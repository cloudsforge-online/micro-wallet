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
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { Network } from '@cloudsforge/contracts-chain'
import { toChecksumAddress, type ChainId } from './addresses.ts'
import type { DepositDeps } from './deposits.ts'
import { keccak256 } from './keccak.ts'
import { MIGRATIONS, TABLES } from './migrations.ts'
import type { MoneyDeps } from './money.ts'
import type { Db } from './outbox.ts'
import type { PortfolioDeps } from './portfolio.ts'
import { recoverAddress } from './secp256k1.ts'
import { staticFeeQuoter } from './settlement.ts'
import { personalSignDigest } from './siwe.ts'
import type { WithdrawalDeps } from './withdrawals.ts'
import type { CustodyAddress, CustodyClient, CreateAddressRequest } from './custodyclient.ts'
import type { ActivityPage, IndexerClient, ObservedActivity } from './indexerclient.ts'
import {
  LedgerRefusedError,
  type LedgerBalance,
  type LedgerClient,
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
  balanceOf(subject: string, assetCode: LedgerAssetCode, purpose: string): bigint
  readonly entries: readonly FakeEntry[]
  /** Every idempotency key it has seen, in order. The double-credit tests read this. */
  readonly keys: readonly string[]
}

const accountKey = (subject: string, assetCode: string, purpose: string): string =>
  `${subject}|${assetCode}|${purpose}`

export function fakeLedger(options: { failWith?: () => Error } = {}): FakeLedger {
  const balances = new Map<string, bigint>()
  const entries: FakeEntry[] = []
  const byKey = new Map<string, FakeEntry>()
  const keys: string[] = []
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

  const move = (subject: string, assetCode: string, purpose: string, delta: bigint): void => {
    const key = accountKey(subject, assetCode, purpose)
    balances.set(key, (balances.get(key) ?? 0n) + delta)
  }

  const balanceOf = (subject: string, assetCode: string, purpose: string): bigint =>
    balances.get(accountKey(subject, assetCode, purpose)) ?? 0n

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
      move(subject, assetCode, 'available', amount)
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
          type: 'liability',
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
        keys.push(request.idempotencyKey)
        const replay = claim(request.idempotencyKey, request)
        if (replay) return { ...(replay.response as PostedEntry), replayed: true }

        // Applied in the account's own normal direction, which for a liability is credit-positive
        // and for an asset is debit-positive — `normalBalance` in contracts-money.
        for (const posting of request.postings) {
          const increases =
            posting.account.type === 'asset' || posting.account.type === 'expense'
              ? posting.direction === 'debit'
              : posting.direction === 'credit'
          const delta = increases ? posting.amount : -posting.amount
          const after =
            balanceOf(posting.account.subject, posting.assetCode, posting.account.purpose) + delta
          // A liability that would go negative is the ledger's hard refusal, and it is what makes
          // an unaffordable spend a 409 rather than an overdraft.
          if (after < 0n && posting.account.type === 'liability') {
            throw new LedgerRefusedError(
              409,
              'insufficient_funds',
              `${posting.account.subject} has insufficient ${posting.assetCode}`,
            )
          }
          move(posting.account.subject, posting.assetCode, posting.account.purpose, delta)
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
        }
        entries.push(entry)
        byKey.set(request.idempotencyKey, entry)
        return response
      })
    },

    reserve(request: ReserveRequest) {
      return serialise(() => {
        if (options.failWith) throw options.failWith()
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
        const entry: FakeEntry = {
          id: response.entryId,
          kind: 'withdrawal_requested',
          recordedAt: new Date(counter).toISOString(),
          fingerprint: fingerprint(request),
          response,
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
        }
        entries.push(entry)
        byKey.set(request.idempotencyKey, entry)
        return response
      })
    },
  }
}

/* ------------------------------------------------------------------ custody */

export interface FakeCustody extends CustodyClient {
  readonly minted: readonly CreateAddressRequest[]
}

/**
 * Mints deterministic EVM addresses, and returns the same one for the same idempotency key.
 *
 * That last part is not decoration: `assignDepositAddress` relies on it, because a retry that
 * minted a second address would produce an address the user was never told about and that nobody
 * is watching.
 */
export function fakeCustody(): FakeCustody {
  const minted: CreateAddressRequest[] = []
  const byKey = new Map<string, CustodyAddress>()
  let counter = 0
  return {
    minted,
    async createAddress(request) {
      minted.push(request)
      const existing = byKey.get(request.idempotencyKey)
      if (existing) return existing
      counter += 1
      const address = `0x${counter.toString(16).padStart(40, 'a')}`
      const created: CustodyAddress = {
        custodyKeyUrn: `cf:custody:key:${counter}`,
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
  readonly watched: ReadonlyArray<{ chain: ChainId; network: Network; address: string }>
  setActivity(address: string, items: readonly ObservedActivity[]): void
  failNext(err: Error): void
}

export function fakeIndexer(): FakeIndexer {
  const watched: Array<{ chain: ChainId; network: Network; address: string }> = []
  const activity = new Map<string, readonly ObservedActivity[]>()
  let pendingFailure: Error | null = null
  return {
    watched,
    setActivity(address, items) {
      activity.set(address.toLowerCase(), items)
    },
    failNext(err) {
      pendingFailure = err
    },
    async watch(chain, network, address) {
      if (pendingFailure) {
        const err = pendingFailure
        pendingFailure = null
        throw err
      }
      watched.push({ chain, network, address })
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
    deposits: { sql: db, producer: 'wallet', network, custody, indexer, ledger },
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
