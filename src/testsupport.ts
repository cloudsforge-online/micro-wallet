/**
 * Local fakes for the four upstreams, and the shared test harness.
 *
 * **No test in this repository requires the ledger, custody, the indexer or pricing to be
 * running.** A test that needs four other services is a test nobody runs, and the behaviours under
 * examination here are what *this* service does with its upstreams' answers — a redelivered
 * deposit crediting once, two concurrent withdrawals not over-reserving, an unverified address
 * being refused — every one of which a fake gives faithfully.
 *
 * The fake ledger is the one that has to be more than a stub, because two of the headline tests
 * are about what it refuses. It models what actually matters:
 *
 *   * **Balances per `(subject, asset, purpose)`,** so `available` and `reserved` are two accounts
 *     and a reservation is a movement between them — the shape 04-domain-model §2.1 insists on.
 *   * **A liability that may not go negative,** which is what makes an over-reservation a refusal
 *     rather than a silent overdraft.
 *   * **Idempotency by key, with a body fingerprint,** so a replay returns the first answer and a
 *     reused key with a different body is a 409, exactly as the real one does.
 *   * **Serialised application.** Every mutating call runs under one promise chain, which is the
 *     fake's stand-in for the real ledger's row locks. Without it two concurrent reservations
 *     interleave read-and-write and the test that proves they cannot over-reserve would pass for
 *     the wrong reason.
 *
 * It is deliberately *not* a double-entry engine: it does not check that entries balance, because
 * `contracts-money`'s own `balanceEntry` tests do, and duplicating that here would test the fake.
 */

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger } from '@cloudsforge/telemetry'
import type { AccountType, LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Network } from '@cloudsforge/contracts-chain'
import { toChecksumAddress, type ChainId } from './addresses.ts'
import type { DepositDeps } from './deposits.ts'
import { keccak256 } from '@cloudsforge/evm'
import { MIGRATIONS, TABLES } from './migrations.ts'
import type { MoneyDeps } from './money.ts'
import type { Db } from './outbox.ts'
import type { PortfolioDeps } from './portfolio.ts'
import { recoverAddress } from './secp256k1.ts'
import { staticFeeQuoter } from './settlement.ts'
import { personalSignDigest } from './siwe.ts'
import type { WithdrawalDeps } from './withdrawals.ts'
import { CustodyRefusedError, custodyKeyUrn } from './custodyclient.ts'
import type { CustodyAddress, CustodyClient, CreateAddressRequest } from './custodyclient.ts'
import type { ActivityPage, IndexerClient, ObservedActivity } from './indexerclient.ts'
import { indexerObservability } from './observability.ts'
import {
  LedgerRefusedError,
  type LedgerBalance,
  type LedgerClient,
  type LedgerEntry,
  type PostEntryRequest,
  type PostedEntry,
  type ReleaseRequest,
  type ReserveRequest,
  type Reservation,
} from './ledgerclient.ts'
import type { PricingClient, Quote } from './pricingclient.ts'

/* ------------------------------------------------------------------ ledger */

interface FakeEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  readonly fingerprint: string
  /**
   * The request as posted, kept so a test can assert what was DENOMINATED rather than only what
   * the balances came to. A balance assertion cannot see the asset code on a posting whose amount
   * happened to be zero, and it cannot see the entry KIND at all — which is the field the ledger's
   * retired-asset guard keys on.
   */
  readonly postings?: PostEntryRequest['postings']
  /**
   * The entry as `GET /entries` would return it, built at post time.
   *
   * micro-org#495 §3 made micro-wallet a READER of the journal — `/v1/conversions` and
   * `/v1/transfers` page it by subject and kind rather than keeping a wallet-side table — so a fake
   * that could only be posted to could not exercise either route. Built here from the request
   * rather than from a second description of it, so the shape a test reads back is the shape the
   * code under test actually sent.
   */
  readonly view?: LedgerEntry
  readonly response: PostedEntry | Reservation
  /** For a reservation: what to move back on release. */
  readonly reservation?: {
    readonly subject: string
    readonly assetCode: LedgerAssetCode
    readonly amount: bigint
  }
}

export interface FakeLedger extends LedgerClient {
  /** Seed a starting balance without going through a posting. */
  credit(subject: string, assetCode: LedgerAssetCode, amount: bigint): void
  /**
   * Seed the exchange desk's inventory without going through `fundDesk`.
   *
   * Separate from `credit` because it is a different ACCOUNT — `exchange`/`inventory`/`equity`
   * rather than a user's `available` liability — and because a test about what a conversion does
   * should not have to first arrange a treasury, an operator and a funding request in order to say
   * "the desk has some EMBER". The funding path has its own tests, which use the real one.
   */
  seedDesk(assetCode: LedgerAssetCode, amount: bigint): void
  balanceOf(subject: string, assetCode: LedgerAssetCode, purpose: string): bigint
  readonly entries: readonly FakeEntry[]
  /** Every idempotency key it has seen, in order. The double-credit tests read this. */
  readonly keys: readonly string[]
  /**
   * Freeze withdrawals in an asset, the way reconciliation does.
   *
   * ── MODELLED, NOT ASSUMED AWAY, BECAUSE THE STRING IS THE THING UNDER TEST ──────────────────
   *
   * `ledger/src/reconcile.ts` writes an OPERATOR diagnostic into `asset_freezes.reason` — custody
   * total, observed total, drift, and a per-bucket address-count breakdown — and
   * `AssetFrozenError` interpolates it straight into `Error.message`, which this service reads as
   * `LedgerRefusedError.message`. A fake that refused with a tidy sentence of its own would make
   * the disclosure test pass while proving nothing, because the defect is entirely in what this
   * service does with the ledger's actual text. Callers therefore supply the real shape.
   *
   * Only reservations are affected, matching `assertNotFrozen`, which returns early for any kind
   * outside `WITHDRAWAL_KINDS`.
   */
  freezeWithdrawals(assetCode: LedgerAssetCode, reason: string): void
}

const accountKey = (subject: string, assetCode: string, purpose: string): string =>
  `${subject}|${assetCode}|${purpose}`

export function fakeLedger(options: { failWith?: () => Error } = {}): FakeLedger {
  const balances = new Map<string, bigint>()
  /**
   * Each account's `type`, remembered from the first posting that named it.
   *
   * The real ledger stores it on the account row and `GET /accounts/:subject/balances` returns it;
   * this used to answer `'liability'` for every account, which was harmless while every balance a
   * test read was a user's, and stopped being harmless the moment `readDeskInventory` began asking
   * the ledger what the `exchange` subject holds.
   */
  const types = new Map<string, AccountType>()
  const entries: FakeEntry[] = []
  const byKey = new Map<string, FakeEntry>()
  const keys: string[] = []
  const frozen = new Map<string, string>()
  /** Entry id -> the subjects it touched, which is what the ledger's `subject` filter matches on. */
  const subjects = new Map<string, ReadonlySet<string>>()
  // The fake's stand-in for the real ledger's row locks. See the file header.
  let chain: Promise<unknown> = Promise.resolve()
  let counter = 0

  const fingerprint = (value: unknown): string =>
    createHash('sha256')
      .update(
        JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      )
      .digest('hex')

  const serialise = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    // Swallowed on the chain itself so one rejection does not poison every later call; the
    // caller still sees it through `next`.
    chain = next.catch(() => undefined)
    return next
  }

  const move = (
    subject: string,
    assetCode: string,
    purpose: string,
    delta: bigint,
    type: AccountType = 'liability',
  ): void => {
    const key = accountKey(subject, assetCode, purpose)
    balances.set(key, (balances.get(key) ?? 0n) + delta)
    // First writer wins, as in the real ledger: `ensureAccount` does not change an existing
    // account's type as a side effect of a posting that refers to it.
    if (!types.has(key)) types.set(key, type)
  }

  const balanceOf = (subject: string, assetCode: string, purpose: string): bigint =>
    balances.get(accountKey(subject, assetCode, purpose)) ?? 0n

  /**
   * The entry as `GET /entries` returns it, built from the request that produced it.
   *
   * `accountId` is the fake's account key rather than a uuid, so that the id a balance carries and
   * the id a posting carries are the same string for the same account — the property the real
   * ledger has. Nothing may parse it: whose account a posting is against is deliberately not
   * derivable from an entry in the real ledger either, which is why `readConversion` proves
   * ownership from the correlation id instead.
   */
  const view = (
    id: string,
    kind: string,
    recordedAt: string,
    request: {
      readonly actor: string
      readonly correlationId: string
      readonly idempotencyKey: string
      readonly description?: string
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly postings: PostEntryRequest['postings']
    },
  ): LedgerEntry => {
    subjects.set(id, new Set(request.postings.map((posting) => posting.account.subject)))
    return {
      id,
      kind,
      description: request.description ?? null,
      // The fake is only ever this service's client, so there is one possible answer.
      originatingService: 'wallet',
      actor: request.actor,
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      reversesEntryId: null,
      occurredAt: recordedAt,
      recordedAt,
      metadata: request.metadata ?? {},
      postings: request.postings.map((posting) => ({
        id: `${id}-p${posting.sequence}`,
        accountId: accountKey(
          posting.account.subject,
          posting.account.assetCode,
          posting.account.purpose,
        ),
        direction: posting.direction,
        amount: posting.amount,
        assetCode: posting.assetCode,
        sequence: posting.sequence,
      })),
    }
  }

  const claim = (key: string, body: unknown): FakeEntry | null => {
    const existing = byKey.get(key)
    if (!existing) return null
    if (existing.fingerprint !== fingerprint(body)) {
      throw new LedgerRefusedError(
        409,
        'idempotency_key_reuse',
        'this idempotency key was already used with a different request body',
      )
    }
    return existing
  }

  return {
    entries,
    keys,

    credit(subject, assetCode, amount) {
      move(subject, assetCode, 'available', amount, 'liability')
      /*
       * ── AND THE ASSET SIDE, BECAUSE A LIABILITY WITH NOTHING BEHIND IT IS NOT A STARTING STATE ──
       *
       * This used to move one balance, which was fine only while the fake refused a negative
       * balance on liabilities alone. Once it models migration 7 properly — every type but
       * `clearing` reaches the raise — a suite that seeded a user's coins out of nowhere could no
       * longer SETTLE a withdrawal of them: `settleWithdrawal` credits `custody`/`asset`, custody
       * had never been debited, and the trigger refused it. That refusal is correct in production
       * and the fixture was the thing that was wrong, so the fixture now seeds the deposit's other
       * leg as well: `credit` stands in for a deposit, and a deposit debits custody.
       *
       * A test that asserted custody's balance ending up NEGATIVE was asserting a state Postgres
       * will not hold. Two of them existed; both now read the balance the same movement really
       * leaves behind.
       */
      move('custody', assetCode, 'available', amount, 'asset')
    },

    seedDesk(assetCode, amount) {
      // `'exchange'`, `'inventory'` and `'equity'` are spelled out rather than imported from
      // `money.ts`, under the same rule the retired-asset guard below is modelled by: a fake that
      // shared the production constant would agree with a mistake in it, and the point of this one
      // is to be the other side of the boundary. If this line and `desk()` ever disagree, the desk
      // tests fail, which is the correct outcome.
      move('exchange', assetCode, 'inventory', amount, 'equity')
    },

    freezeWithdrawals(assetCode, reason) {
      frozen.set(assetCode, reason)
    },

    balanceOf(subject, assetCode, purpose) {
      return balanceOf(subject, assetCode, purpose)
    },

    async balances(subject) {
      const out: LedgerBalance[] = []
      for (const [key, amount] of balances) {
        const [accountSubject, assetCode, purpose] = key.split('|')
        if (accountSubject !== subject) continue
        out.push({
          accountId: key,
          assetCode: assetCode as LedgerAssetCode,
          purpose: purpose as LedgerBalance['purpose'],
          type: types.get(key) ?? 'liability',
          status: 'open',
          amount,
          updatedAt: new Date(0).toISOString(),
        })
      }
      return out
    },

    postEntry(request: PostEntryRequest) {
      return serialise(() => {
        if (options.failWith) throw options.failWith()
        /*
         * ══════════════════════════════════════════════════════════════════════════════════════
         * MIGRATION 13'S RETIRED-ASSET GUARD, MODELLED HERE RATHER THAN ASSUMED AWAY.
         *
         * `micro-ledger` refuses a retired asset on an ACQUISITION kind — `purchase`,
         * `subscription_charge`, `deposit_credited` — and permits it on every other kind, because
         * retiring an asset must never strand the 69,000 SHARD units 69 holders still have. A fake
         * that accepted everything would let this service post a `purchase` in SHARD, go green, and
         * 400 in production, which is exactly what happened: `spend` was hard-coded to SHARD and
         * nothing in this suite could see it.
         *
         * Modelled from `ledger/src/migrations.ts` migration 13 and NOT from the same constant the
         * production code reads. That is deliberate — a fake that shared the source would agree
         * with a mistake in it, and the value of this check is that it is the OTHER side of the
         * boundary, stated independently.
         * ══════════════════════════════════════════════════════════════════════════════════════
         */
        const ACQUISITION_KINDS = new Set(['purchase', 'subscription_charge', 'deposit_credited'])
        const RETIRED = new Set(['SHARD'])
        if (ACQUISITION_KINDS.has(request.kind)) {
          for (const posting of request.postings) {
            if (RETIRED.has(posting.assetCode)) {
              throw new LedgerRefusedError(
                400,
                'retired_asset',
                `${posting.assetCode} is retired and may not denominate a ${request.kind}`,
              )
            }
          }
        }
        keys.push(request.idempotencyKey)
        const replay = claim(request.idempotencyKey, request)
        if (replay) return { ...(replay.response as PostedEntry), replayed: true }

        /*
         * ── STAGED FIRST, APPLIED SECOND, BECAUSE A REFUSED ENTRY MUST LEAVE NOTHING BEHIND ────
         *
         * The real ledger writes an entry's postings in one transaction, so a posting the overdraft
         * trigger refuses rolls back the ones before it. This loop used to mutate `balances` as it
         * went and throw from the middle, and the entry that exposes the difference is precisely the
         * one micro-org#495 asks for a test of: a conversion is refused on its THIRD posting, the
         * desk's output leg, by which point a mutating loop has already debited the user on its
         * first. "The response was 409" would have passed; "the journal has no entry, and no balance
         * moved" would not have.
         *
         * Amounts are applied in the account's own normal direction, which for a liability is
         * credit-positive and for an asset is debit-positive — `normalBalance` in contracts-money.
         */
        const pending = new Map<string, bigint>()
        const writes: Array<{
          subject: string
          assetCode: string
          purpose: string
          delta: bigint
          type: AccountType
        }> = []
        for (const posting of request.postings) {
          /*
           * A POSTING'S DECLARED ASSET AND ITS ACCOUNT'S ASSET MUST BE THE SAME ASSET.
           *
           * The ledger's account key is `(subject, asset_code, purpose)` and is unique, so these
           * two fields are not a duplication — one selects the ACCOUNT and the other denominates
           * the AMOUNT. A posting where they disagree debits an EMBER account by a number the entry
           * calls SHARD: `balanceEntry` still balances (it sums per declared asset), the account
           * still exists, and the resulting balance is a quantity in no unit at all.
           *
           * This fake used to move balances by `posting.assetCode` alone and never look at
           * `posting.account.assetCode`, so a mutation that changed only the account's asset was
           * invisible to every test. That is the check-that-cannot-fail shape, in the test double
           * rather than in the code.
           */
          if (posting.assetCode !== posting.account.assetCode) {
            throw new LedgerRefusedError(
              400,
              'asset_mismatch',
              `posting ${posting.sequence} is denominated in ${posting.assetCode} but names a ` +
                `${posting.account.assetCode} account`,
            )
          }
          const increases =
            posting.account.type === 'asset' || posting.account.type === 'expense'
              ? posting.direction === 'debit'
              : posting.direction === 'credit'
          const delta = increases ? posting.amount : -posting.amount
          const key = accountKey(
            posting.account.subject,
            posting.assetCode,
            posting.account.purpose,
          )
          const after =
            (pending.get(key) ??
              balanceOf(posting.account.subject, posting.assetCode, posting.account.purpose)) + delta
          /*
           * ════════════════════════════════════════════════════════════════════════════════════
           * MIGRATION 7'S OVERDRAFT TRIGGER — WHICH IS NOT A RULE ABOUT LIABILITIES.
           *
           * This used to refuse a negative balance only when the account's type was `liability`,
           * and that made the fake agree with a belief about `ledger_assert_no_overdraft()` that
           * the trigger does not hold. Read it in order: it returns early for `type = 'clearing'`,
           * then returns early for `overdraft_allowed or purpose = 'suspense'`, and otherwise
           * raises. EVERY other type reaches the raise — asset, revenue, expense and equity alike.
           *
           * The gap was not academic. micro-org#495 moved the conversion counter-account from
           * `clearing` to an `equity` desk precisely because equity reaches that check, and a fake
           * that refused only liabilities would have let an empty desk fill an order and reported
           * the whole change as working. Nothing this service posts sets `overdraft_allowed`, so
           * the two exemptions below are the whole of it.
           *
           * The message is the trigger's own wording, because `micro-ledger` passes the Postgres
           * exception text through to its caller verbatim and recovers the subject and purpose out
           * of it; `money.ts` reads the structured `subject` to tell "you do not have this" from
           * "we do not have this", and a tidier sentence here would make that untestable.
           * ════════════════════════════════════════════════════════════════════════════════════
           */
          const exempt =
            posting.account.type === 'clearing' || posting.account.purpose === 'suspense'
          if (after < 0n && !exempt) {
            throw new LedgerRefusedError(
              409,
              'insufficient_funds',
              `account ${key} (${posting.account.subject} ${posting.account.purpose}) would go to ` +
                `${after} — a ${posting.account.type} account may not go negative without ` +
                'overdraft_allowed',
              { subject: posting.account.subject, purpose: posting.account.purpose },
            )
          }
          pending.set(key, after)
          writes.push({
            subject: posting.account.subject,
            assetCode: posting.assetCode,
            purpose: posting.account.purpose,
            delta,
            type: posting.account.type,
          })
        }
        for (const write of writes) {
          move(write.subject, write.assetCode, write.purpose, write.delta, write.type)
        }

        counter += 1
        const response: PostedEntry = {
          id: `entry-${counter}`,
          kind: request.kind,
          recordedAt: new Date(counter).toISOString(),
          replayed: false,
        }
        const entry: FakeEntry = {
          id: response.id,
          kind: request.kind,
          recordedAt: response.recordedAt,
          fingerprint: fingerprint(request),
          response,
          postings: request.postings,
          view: view(response.id, request.kind, response.recordedAt, request),
        }
        entries.push(entry)
        byKey.set(request.idempotencyKey, entry)
        return response
      })
    },

    reserve(request: ReserveRequest) {
      return serialise(() => {
        if (options.failWith) throw options.failWith()
        const freeze = frozen.get(request.assetCode)
        if (freeze !== undefined) {
          // The message is `AssetFrozenError`'s own construction, spelled here rather than
          // imported, so this stays the OTHER side of the boundary — the same rule the
          // retired-asset guard in `postEntry` is modelled under.
          throw new LedgerRefusedError(
            409,
            'asset_frozen',
            `withdrawals in ${request.assetCode} are frozen: ${freeze}`,
          )
        }
        keys.push(request.idempotencyKey)
        const replay = claim(request.idempotencyKey, request)
        if (replay) return { ...(replay.response as Reservation), replayed: true }

        const available = balanceOf(request.subject, request.assetCode, 'available')
        if (available < request.amount) {
          throw new LedgerRefusedError(
            409,
            'insufficient_funds',
            `${request.subject} has ${available} ${request.assetCode} available, needs ${request.amount}`,
          )
        }
        move(request.subject, request.assetCode, 'available', -request.amount)
        move(request.subject, request.assetCode, 'reserved', request.amount)

        counter += 1
        const response: Reservation = {
          reservationId: `entry-${counter}`,
          entryId: `entry-${counter}`,
          replayed: false,
        }
        const kind = request.kind ?? 'withdrawal_requested'
        const recordedAt = new Date(counter).toISOString()
        const entry: FakeEntry = {
          id: response.entryId,
          kind,
          recordedAt,
          fingerprint: fingerprint(request),
          response,
          // A reservation IS an entry in the real ledger, with the two postings this call implies,
          // so it appears in `listEntries` like any other rather than being invisible to a read.
          view: view(response.entryId, kind, recordedAt, {
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
            postings: reservationPostings(request.subject, request.assetCode, request.amount, 'in'),
          }),
          reservation: {
            subject: request.subject,
            assetCode: request.assetCode,
            amount: request.amount,
          },
        }
        entries.push(entry)
        byKey.set(request.idempotencyKey, entry)
        return response
      })
    },

    release(reservationId: string, request: ReleaseRequest) {
      return serialise(() => {
        keys.push(request.idempotencyKey)
        const replay = claim(request.idempotencyKey, { reservationId, ...request })
        if (replay) return { ...(replay.response as PostedEntry), replayed: true }

        const original = entries.find((e) => e.id === reservationId)
        if (!original?.reservation) {
          throw new LedgerRefusedError(404, 'not_found', `no reservation ${reservationId}`)
        }
        move(
          original.reservation.subject,
          original.reservation.assetCode,
          'reserved',
          -original.reservation.amount,
        )
        move(
          original.reservation.subject,
          original.reservation.assetCode,
          'available',
          original.reservation.amount,
        )

        counter += 1
        const response: PostedEntry = {
          id: `entry-${counter}`,
          kind: 'withdrawal_refunded',
          recordedAt: new Date(counter).toISOString(),
          replayed: false,
        }
        const entry: FakeEntry = {
          id: response.id,
          kind: response.kind,
          recordedAt: response.recordedAt,
          fingerprint: fingerprint({ reservationId, ...request }),
          response,
          view: view(response.id, response.kind, response.recordedAt, {
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            postings: reservationPostings(
              original.reservation.subject,
              original.reservation.assetCode,
              original.reservation.amount,
              'out',
            ),
          }),
        }
        entries.push(entry)
        byKey.set(request.idempotencyKey, entry)
        return response
      })
    },

    /*
     * ── THE TWO READS micro-org#495 §3 ADDED, AND THE ONE THING THEY DO NOT MODEL ─────────────
     *
     * Filtering is the real ledger's: `kind`, `originatingService`, `correlationId` and `subject`
     * are ANDed, newest first, keyset-paged. The cursor is matched by identity rather than by
     * `id < cursor` because this fake's ids are `entry-1`, `entry-2`, … and `entry-10` sorts below
     * `entry-2`; the real ledger's are UUIDv7, where the string order IS the time order. A test
     * that depended on the ordering of the id STRINGS would be depending on the fake, so it is the
     * position in the filtered list that decides the page — the behaviour a caller can see is the
     * same, and the fake's ids stay readable in a failure message.
     */
    async listEntries(query) {
      const matches = entries
        .flatMap((entry) => (entry.view ? [entry.view] : []))
        .filter((entry) => query.kind === undefined || entry.kind === query.kind)
        .filter(
          (entry) =>
            query.originatingService === undefined ||
            entry.originatingService === query.originatingService,
        )
        .filter(
          (entry) => query.correlationId === undefined || entry.correlationId === query.correlationId,
        )
        .filter(
          (entry) => query.subject === undefined || subjects.get(entry.id)?.has(query.subject),
        )
        .reverse()
      const start =
        query.cursor === undefined ? 0 : matches.findIndex((e) => e.id === query.cursor) + 1
      const page = matches.slice(start, start + query.limit)
      const last = page[page.length - 1]
      // Null on the last page, so a caller that pages until null terminates. A cursor is returned
      // only when there is something after it, never merely because the page was full.
      const more = matches.length > start + page.length
      return { entries: page, nextCursor: more && last ? last.id : null }
    },

    async readEntry(entryId) {
      return entries.find((entry) => entry.id === entryId)?.view ?? null
    },
  }
}

/**
 * The two postings a reservation or its release is, in the real ledger.
 *
 * `in` moves a user's balance from `available` to `reserved` and `out` moves it back. Spelled here
 * rather than taken from `movePostings` in contracts-money for the reason the retired-asset guard
 * gives: this side of the boundary states the shape independently.
 */
function reservationPostings(
  subject: string,
  assetCode: LedgerAssetCode,
  amount: bigint,
  direction: 'in' | 'out',
): PostEntryRequest['postings'] {
  const account = (purpose: 'available' | 'reserved') =>
    ({ subject, assetCode, purpose, type: 'liability' }) as const
  const [from, to] =
    direction === 'in'
      ? ([account('available'), account('reserved')] as const)
      : ([account('reserved'), account('available')] as const)
  return [
    { direction: 'debit', amount, assetCode, sequence: 0, account: from },
    { direction: 'credit', amount, assetCode, sequence: 1, account: to },
  ]
}

/* ------------------------------------------------------------------ custody */

export interface FakeCustody extends CustodyClient {
  readonly minted: readonly CreateAddressRequest[]
}

/**
 * Mints deterministic EVM addresses, and returns the same one for the same idempotency key.
 *
 * ── WHAT THIS FAKE IS FOR, AND WHAT IT PROVED NOTHING ABOUT ──────────────────────────────────
 *
 * It is here so a test about assignment, rotation and watching does not need a key store. It is
 * NOT evidence about the custody seam, and for the whole of its life it read as though it were:
 * it returned a `custodyKeyUrn` that custody has never published, and it accepted a request with
 * no `orderId`, which custody refuses 400 (`custody/src/server.ts`). Every deposit test in
 * this suite passed against it while the live funding path was dead.
 *
 * Two things changed so that it cannot do that again. It now **refuses a request custody would
 * refuse**, by the same rule (`stringField`, `custody/src/server.ts`), so a caller that stops
 * sending the binding fails here too. And the URN it returns is minted by the SAME function the
 * real client uses, so the two cannot disagree about the form. The shape of the wire itself is
 * `custodycontract.test.ts`'s job, over a real socket, against a stub that speaks custody's
 * envelope — not this.
 *
 * The idempotency-key dedupe below is kept because callers rely on it, but note that CUSTODY DOES
 * NOT DO THIS: it has no idempotency handling at all and `provisionAddress` mints unconditionally
 * (`custody/src/keys.ts`). Do not read a passing retry test here as evidence about the estate.
 */
/**
 * Addresses the fake custody mints, per chain.
 *
 * ── THE FAKE USED TO MINT `0x…` FOR EVERY CHAIN, WHICH MADE ONE PATH UNTESTABLE ────────────────
 *
 * `assignDepositAddress` canonicalises whatever custody hands back, so a fake that answers an EVM
 * address for a `bitcoin` request cannot get past `canonicaliseAddress` — and the failure looks
 * like "address contains a character outside its alphabet", which reads as a bug in the code under
 * test rather than in the fake. The effect was that **no deposit-assignment test existed for any
 * non-EVM chain at all**, and the first one written found this rather than anything about Litecoin.
 *
 * The Litecoin entries are Litecoin Core's own published vectors
 * (`litecoin/src/test/data/key_io_valid.json`, chain `test`) rather than strings shaped to look
 * right. A fake that answers a plausible-looking address would let a canonicaliser with the wrong
 * parameters pass, which is the exact defect these tests exist to catch.
 *
 * The Dogecoin entries hold to the same rule and come from Dogecoin Core's own
 * `src/test/data/base58_keys_valid.json`, the file its `base58_tests` runs against, filtered to
 * `isTestnet: true` and `addrType: pubkey` — version byte 113, which is what custody derives for
 * this chain because Dogecoin has no segwit to derive instead. A `tltc1…`-shaped string with
 * `doge` in front of it would be exactly the plausible-looking answer this comment warns about,
 * and there is no such thing.
 */
const CHAIN_ADDRESSES: Partial<Record<ChainId, readonly string[]>> = {
  ltc: [
    'tltc1qpftpsvdn6mjp8celrkj0qxqy4jlapl959rlwg9',
    'tltc1quf7ycjczjpjd6u9a8mpa00jl7g9aplhy8e0vf7',
  ],
  btc: ['tb1qcrh3yqn4nlleplcez2yndq2ry8h9ncg3qh7n54'],
  doge: ['nhRsrUaxZou6sewjqaS37cJrMRJRgwVXdk', 'ngbSgr1dhCqsLg6Z5tpsaCspwrH72x2Zk3'],
}

export function fakeCustody(): FakeCustody {
  const minted: CreateAddressRequest[] = []
  const byKey = new Map<string, CustodyAddress>()
  let counter = 0
  return {
    minted,
    async createAddress(request) {
      minted.push(request)
      for (const [name, value] of [
        ['chain', request.chain],
        ['userId', request.userId],
        ['orderId', request.orderId],
      ] as const) {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw new CustodyRefusedError(400, 'bad_request', `${name} must be a non-empty string`)
        }
      }
      const existing = byKey.get(request.idempotencyKey)
      if (existing) return existing
      counter += 1
      // A chain-appropriate address where one is needed, and the EVM shape otherwise — which is
      // unbounded, where the published-vector pools are not. A pool that runs out throws rather
      // than wrapping: two assignments sharing an address would violate the unique index and the
      // resulting failure would point at the schema instead of at this line.
      const pool = CHAIN_ADDRESSES[request.chain]
      if (pool && counter > pool.length) {
        throw new Error(
          `the fake custody has only ${pool.length} published ${request.chain} addresses and a ` +
            `${counter}th was asked for — add another from that chain's own test vectors`,
        )
      }
      const address = pool
        ? (pool[counter - 1] as string)
        : `0x${counter.toString(16).padStart(40, 'a')}`
      const created: CustodyAddress = {
        custodyKeyUrn: custodyKeyUrn({ chain: request.chain, network: request.network, address }),
        address,
        chain: request.chain,
        network: request.network,
        scheme: 'hd_bip44',
        derivationPath: `m/44'/60'/0'/0/${counter}`,
      }
      byKey.set(request.idempotencyKey, created)
      return created
    },
  }
}

/* ------------------------------------------------------------------ indexer */

export interface FakeIndexer extends IndexerClient {
  readonly watched: ReadonlyArray<{
    chain: ChainId
    network: Network
    address: string
    /** The history claim the caller made, if it made one. See `indexerclient.watch`. */
    freshlyDerived: boolean
  }>
  setActivity(address: string, items: readonly ObservedActivity[]): void
  failNext(err: Error): void
  /**
   * How many providers this fake reports for a scope. **Defaults to one for EVERY chain**, which
   * keeps every existing test meaning what it meant — they were written against an indexer that
   * was assumed to watch whatever it was handed. A test that cares sets it to zero.
   */
  setProviders(chain: ChainId, network: Network, providers: number): void
  /** Fail the next `chainStatus` read. Separate from `failNext`, which fails a `watch`. */
  failStatusNext(err: Error): void
}

export function fakeIndexer(): FakeIndexer {
  const watched: Array<{
    chain: ChainId
    network: Network
    address: string
    freshlyDerived: boolean
  }> = []
  const activity = new Map<string, readonly ObservedActivity[]>()
  const providers = new Map<string, number>()
  let pendingFailure: Error | null = null
  let statusFailure: Error | null = null
  return {
    watched,
    setActivity(address, items) {
      activity.set(address.toLowerCase(), items)
    },
    setProviders(chain, network, count) {
      providers.set(`${chain}:${network}`, count)
    },
    failStatusNext(err) {
      statusFailure = err
    },
    async chainStatus(chain, network) {
      // Deliberately does NOT consume `failNext`. That hook exists to make a WATCH registration
      // fail so the repair job can be exercised, and a status read that swallowed it would turn
      // "the indexer refused to watch this address" into "this chain is not observable" — two
      // different faults with two different repairs.
      if (statusFailure) {
        const err = statusFailure
        statusFailure = null
        throw err
      }
      return {
        chain,
        network,
        providers: providers.get(`${chain}:${network}`) ?? 1,
        indexedHeight: 1,
        halted: false,
      }
    },
    failNext(err) {
      pendingFailure = err
    },
    async watch(chain, network, address, _label, freshlyDerived = false) {
      if (pendingFailure) {
        const err = pendingFailure
        pendingFailure = null
        throw err
      }
      watched.push({ chain, network, address, freshlyDerived })
    },
    async activity(_chain, _network, address, limit): Promise<ActivityPage> {
      const items = activity.get(address.toLowerCase()) ?? []
      return {
        address,
        tipHeight: 1_000,
        requiredConfirmations: 12,
        items: items.slice(0, limit),
        nextCursor: items.length > limit ? 'next' : null,
      }
    },
  }
}

/* ------------------------------------------------------------------ pricing */

export function fakePricing(
  table: Readonly<Record<string, bigint>> = { EMBER: 2_500_000n, ETH: 3_000_000_000n },
): PricingClient {
  return {
    async quotes(assets) {
      const out = new Map<LedgerAssetCode, Quote>()
      for (const asset of assets) {
        const rate = table[asset]
        // Absent means "no usable price", never zero. A valuation of zero is a lie about a
        // holding that exists.
        if (rate === undefined) continue
        out.set(asset, {
          assetCode: asset,
          usdPerCoinScaled: rate,
          asOf: '2026-01-01T00:00:00.000Z',
          source: 'fake',
        })
      }
      return out
    },
  }
}

/* ------------------------------------------------------------------ event payloads */

/** A well-formed `indexer.deposit.confirmed` payload, with the awkward fields already right. */
export function depositPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chain: 'ember',
    network: 'testnet',
    address: '0x000000000000000000000000000000000000aaa1',
    direction: 'in',
    assetCode: 'EMBER',
    assetKind: 'native',
    tokenAddress: null,
    amount: '1000000000000000000',
    txHash: `0x${'11'.repeat(32)}`,
    logIndex: null,
    blockHeight: 900,
    // Above EMBER's depth of 60, which `contracts-chain` publishes and this service re-checks.
    confirmations: 100,
    ...overrides,
  }
}

/* ------------------------------------------------------------------ the database harness */

/**
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetWallet` truncates every table this service owns, and requiring "test"
 * in the name is the difference between a red build and an emptied environment. This is a money
 * service; the wrong connection string here destroys the record of every deposit address ever
 * handed out.
 *
 * Only a `wallet_test` database is ever created or written by this suite.
 */
const url = process.env['WALLET_TEST_DATABASE_URL']

/** Both halves are required: a URL, and a URL that names a test database. */
export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set WALLET_TEST_DATABASE_URL (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that are supposed to prove they fire — and two
 * of those constraints, `deposit_credits.credit_key` and the partial unique index on
 * `wallets.is_primary`, are load-bearing safety properties rather than tidiness.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'wallet-test' })
}

/** Empty every table this service owns. `jobs` included, so a leased job cannot leak between files. */
export async function resetWallet(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** A stable UUID for a test user, so failures name the same subject every run. */
export function testUser(n = 1): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
}

/** A quiet logger. Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'wallet-test', sink: () => {} })
}

/** The deps bundle every store test needs, wired to fakes and one pool. */
export interface Harness {
  readonly sql: Db
  readonly ledger: FakeLedger
  readonly custody: FakeCustody
  readonly indexer: FakeIndexer
  readonly pricing: PricingClient
  readonly deposits: DepositDeps
  readonly withdrawals: WithdrawalDeps
  readonly money: MoneyDeps
  readonly portfolio: PortfolioDeps
}

export function harness(
  sql: postgres.Sql,
  options: { readonly fees?: Readonly<Record<string, bigint>>; readonly network?: Network } = {},
): Harness {
  const db = sql as unknown as Db
  const ledger = fakeLedger()
  const custody = fakeCustody()
  const indexer = fakeIndexer()
  const pricing = fakePricing()
  const network = options.network ?? 'testnet'
  return {
    sql: db,
    ledger,
    custody,
    indexer,
    pricing,
    deposits: {
      sql: db,
      producer: 'wallet',
      network,
      custody,
      indexer,
      ledger,
      observability: indexerObservability({ indexer, ttlMs: 0 }),
      // The harness quotes no fees and gates on nothing, so the catalogue port is the same
      // observation as the gate. A test that wants the two to DISAGREE — which is the whole of
      // micro-org#481 — builds them itself; see `observability.test.ts` and `deposits.test.ts`.
      availability: indexerObservability({ indexer, ttlMs: 0 }),
    },
    withdrawals: {
      sql: db,
      producer: 'wallet',
      network,
      ledger,
      fees: staticFeeQuoter(options.fees ?? { EMBER: 21_000_000_000_000n }),
      withdrawalsEnabled: true,
      minFeeMultiple: 3,
      stuckMinutes: 60,
    },
    money: { sql: db, producer: 'wallet', ledger, pricing },
    portfolio: { sql: db, network, ledger, indexer, pricing },
  }
}

/* ------------------------------------------------------------------ an EVM signer */

/**
 * A wallet, for tests: a secp256k1 key and `personal_sign` over it.
 *
 * ## Why the ECDSA here is hand-written rather than Node's
 *
 * It was Node's, first, and it does not work: `crypto.sign(null, digest, ecKey)` **hashes the
 * input with SHA-256 anyway** rather than treating it as a pre-computed digest. EIP-191 signs
 * `keccak256("\x19Ethereum Signed Message:\n" + len + msg)` directly, and OpenSSL cannot be asked
 * to sign an arbitrary 32 bytes on this curve, nor does it implement Keccak. So there is no way to
 * produce a real `personal_sign` signature with `node:crypto`.
 *
 * That is a smaller concession than it looks, because the independence lives elsewhere:
 * `secp256k1.test.ts` signs with **OpenSSL** over a SHA-256 digest and asserts that
 * `recoverAddress` — the production code — lands on the address OpenSSL's own public key derives
 * to. The curve constants, the field arithmetic and the recovery construction are therefore pinned
 * against an independent implementation there. `assertMatchesNode` below closes the remaining gap
 * by checking this file's scalar multiplication reproduces the public key OpenSSL generated.
 *
 * The recovery byte is found by trying both and keeping the one that recovers this key, which is
 * exactly what a real wallet does to produce a `v`.
 */
export interface EvmSigner {
  /** EIP-55 checksummed, as EIP-4361 requires the address in the message to be. */
  readonly address: string
  sign(message: string): string
}

const SECP256K1_P =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
}

type TestPoint = { x: bigint; y: bigint } | null

const fmod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m

function finvert(a: bigint, m: bigint): bigint {
  let [oldR, r] = [fmod(a, m), m]
  let [oldS, s] = [1n, 0n]
  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }
  return fmod(oldS, m)
}

function padd(a: TestPoint, b: TestPoint): TestPoint {
  if (a === null) return b
  if (b === null) return a
  if (a.x === b.x && a.y !== b.y) return null
  const lambda =
    a.x === b.x
      ? fmod(3n * a.x * a.x * finvert(2n * a.y, SECP256K1_P), SECP256K1_P)
      : fmod((b.y - a.y) * finvert(b.x - a.x, SECP256K1_P), SECP256K1_P)
  const x = fmod(lambda * lambda - a.x - b.x, SECP256K1_P)
  return { x, y: fmod(lambda * (a.x - x) - a.y, SECP256K1_P) }
}

function pmul(point: TestPoint, scalar: bigint): TestPoint {
  let k = fmod(scalar, SECP256K1_N)
  let result: TestPoint = null
  let addend = point
  while (k > 0n) {
    if (k & 1n) result = padd(result, addend)
    addend = padd(addend, addend)
    k >>= 1n
  }
  return result
}

export function evmSigner(): EvmSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const priv = privateKey.export({ format: 'jwk' }) as { d: string }
  const pub = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const d = BigInt(`0x${Buffer.from(priv.d, 'base64url').toString('hex')}`)

  // The gap-closing check: this file's scalar multiplication must reproduce the public key
  // OpenSSL derived. If the curve constants or the group law here were wrong, every signature
  // below would be wrong in a way the tests could not see.
  const derived = pmul(G, d)
  const expectedX = BigInt(`0x${Buffer.from(pub.x, 'base64url').toString('hex')}`)
  const expectedY = BigInt(`0x${Buffer.from(pub.y, 'base64url').toString('hex')}`)
  if (derived === null || derived.x !== expectedX || derived.y !== expectedY) {
    throw new Error('the test signer does not agree with OpenSSL about this key')
  }

  const uncompressed = Buffer.concat([
    Buffer.from(expectedX.toString(16).padStart(64, '0'), 'hex'),
    Buffer.from(expectedY.toString(16).padStart(64, '0'), 'hex'),
  ])
  const lower = `0x${Buffer.from(keccak256(uncompressed).slice(12)).toString('hex')}`

  return {
    address: toChecksumAddress(lower),
    sign(message) {
      const digest = personalSignDigest(message)
      const z = BigInt(`0x${Buffer.from(digest).toString('hex')}`) % SECP256K1_N
      for (;;) {
        const k = BigInt(`0x${randomBytes(32).toString('hex')}`) % SECP256K1_N
        if (k === 0n) continue
        const R = pmul(G, k)
        if (R === null) continue
        const r = fmod(R.x, SECP256K1_N)
        if (r === 0n) continue
        let s = fmod(finvert(k, SECP256K1_N) * (z + r * d), SECP256K1_N)
        if (s === 0n) continue
        // EIP-2 accepts only the low half of the malleable pair.
        if (s > SECP256K1_N >> 1n) s = SECP256K1_N - s
        for (const recovery of [0, 1]) {
          const candidate = `0x${r.toString(16).padStart(64, '0')}${s
            .toString(16)
            .padStart(64, '0')}${(27 + recovery).toString(16)}`
          try {
            if (recoverAddress(digest, candidate) === lower) return candidate
          } catch {
            // A recovery bit that does not produce a point is simply the wrong bit.
          }
        }
        throw new Error('neither recovery bit reproduced the signing key')
      }
    },
  }
}
