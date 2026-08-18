import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { LedgerRefusedError } from './ledgerclient.ts'
import {
  IdempotencyInFlightError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReuseError,
  namespacedKey,
  peekIdempotency,
  requestFingerprint,
  requireIdempotencyKey,
  withIdempotency,
} from './idempotency.ts'
import {
  MoneyError,
  convert,
  deskInventory,
  fundDesk,
  listConversions,
  listTransfers,
  quoteConversion,
  readConversion,
  sampleDeskInventory,
  spend,
  transfer,
} from './money.ts'
import { Metrics, type DroppedMetricWrite } from '@cloudsforge/telemetry'
import { registerServiceMetrics } from './server.ts'
import {
  enabled,
  harness,
  migrateTestDb,
  openDb,
  resetWallet,
  skip,
  testUser,
  type Harness,
} from './testsupport.ts'

let sql: postgres.Sql
let h: Harness

const USER = testUser(1)
const OTHER = testUser(2)
const ADMIN = testUser(3)
const ONE_EMBER = 1_000_000_000_000_000_000n

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetWallet(sql)
  h = harness(sql)
})

/* ------------------------------------------------------------------ the key itself */

test('THE RULE: a money route with no idempotency key refuses before doing anything', () => {
  // forge-pay's /spend is the estate's one money route that accepts a missing key. Its own
  // comment says a retry without one debits twice, and it proceeds anyway. It is the most-retried
  // money route in the estate.
  for (const presented of [undefined, '', '   ', 'short', 'x'.repeat(201)]) {
    assert.throws(
      () => requireIdempotencyKey('POST /v1/spend', presented),
      (err: unknown) =>
        err instanceof IdempotencyKeyRequiredError && /retry moves money twice/.test((err as Error).message),
      `accepted ${JSON.stringify(presented)}`,
    )
  }
  assert.equal(requireIdempotencyKey('POST /v1/spend', '  a-real-key  '), 'a-real-key')
})

test('the fingerprint is stable across key order and sees a changed amount', () => {
  // JSON.stringify preserves insertion order, so two identical bodies serialised differently would
  // fingerprint differently and a legitimate retry would be rejected as reuse.
  assert.equal(
    requestFingerprint({ a: 1, b: { c: 2, d: 3 } }),
    requestFingerprint({ b: { d: 3, c: 2 }, a: 1 }),
  )
  assert.notEqual(requestFingerprint({ amount: 1n }), requestFingerprint({ amount: 2n }))
  // Every amount in this service is a bigint; a fingerprint that could not hash one could not see
  // a changed amount.
  assert.equal(requestFingerprint({ amount: 1n }), requestFingerprint({ amount: 1n }))
})

test('the key is namespaced by user and route', () => {
  // One user must not be able to read or squat on another's, and a client reusing one key across
  // two endpoints must get two operations.
  assert.notEqual(namespacedKey('u1', 'r', 'k'), namespacedKey('u2', 'r', 'k'))
  assert.notEqual(namespacedKey('u1', 'r1', 'k'), namespacedKey('u1', 'r2', 'k'))
})

/* ------------------------------------------------------------------ the store */

test('a claim runs once and its retry replays the stored answer', { skip }, async () => {
  let ran = 0
  const run = () =>
    withIdempotency<{ n: number }>(sql as never, {
      userId: USER,
      route: 'POST /v1/spend',
      clientKey: 'k1',
      requestHash: 'hash-1',
      run: async () => {
        ran += 1
        return { n: ran }
      },
    })

  const first = await run()
  const second = await run()
  assert.equal(ran, 1)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.deepEqual(second.result, { n: 1 })
})

test('the same key with a different body is refused, not replayed', { skip }, async () => {
  // Returning the first request's answer to a second, different request is worse than an error:
  // the caller believes the thing it asked for happened.
  await withIdempotency(sql as never, {
    userId: USER,
    route: 'POST /v1/spend',
    clientKey: 'k1',
    requestHash: 'hash-1',
    run: async () => ({ ok: true }),
  })
  await assert.rejects(
    () =>
      withIdempotency(sql as never, {
        userId: USER,
        route: 'POST /v1/spend',
        clientKey: 'k1',
        requestHash: 'hash-2',
        run: async () => ({ ok: true }),
      }),
    IdempotencyKeyReuseError,
  )
})

test('a claim whose work threw leaves no row, so the retry does the work', { skip }, async () => {
  // "Record then handle" loses the operation here: the row would exist and the retry would be
  // swallowed as a replay of work that never happened.
  await assert.rejects(
    () =>
      withIdempotency(sql as never, {
        userId: USER,
        route: 'POST /v1/spend',
        clientKey: 'k1',
        requestHash: 'hash-1',
        run: async () => {
          throw new Error('the work failed')
        },
      }),
    /the work failed/,
  )
  assert.equal((await sql`select 1 from idempotency_keys`).length, 0)
  const retry = await withIdempotency(sql as never, {
    userId: USER,
    route: 'POST /v1/spend',
    clientKey: 'k1',
    requestHash: 'hash-1',
    run: async () => ({ ok: true }),
  })
  assert.equal(retry.replayed, false)
})

test('a claim with no response yet reads as in flight, never as done', { skip }, async () => {
  // If the claiming transaction rolls back, nothing committed, so the honest answer is "retry".
  await sql`
    insert into idempotency_keys (key, user_id, route, request_hash)
    values (${namespacedKey(USER, 'POST /v1/spend', 'k1')}, ${USER}, 'POST /v1/spend', 'hash-1')
  `
  await assert.rejects(
    () =>
      withIdempotency(sql as never, {
        userId: USER,
        route: 'POST /v1/spend',
        clientKey: 'k1',
        requestHash: 'hash-1',
        run: async () => ({ ok: true }),
      }),
    IdempotencyInFlightError,
  )
})

test('peek answers a completed operation without re-deriving the request', { skip }, async () => {
  await withIdempotency(sql as never, {
    userId: USER,
    route: 'POST /v1/conversions',
    clientKey: 'k1',
    requestHash: 'hash-1',
    run: async () => ({ entryId: 'e-1' }),
  })
  const hit = await peekIdempotency(sql as never, USER, 'POST /v1/conversions', 'k1', 'hash-1')
  assert.deepEqual(hit?.result, { entryId: 'e-1' })
  assert.equal(await peekIdempotency(sql as never, USER, 'POST /v1/conversions', 'k2', 'hash-1'), null)
  await assert.rejects(
    () => peekIdempotency(sql as never, USER, 'POST /v1/conversions', 'k1', 'other-hash'),
    IdempotencyKeyReuseError,
  )
})

/* ------------------------------------------------------------------ spend */

test('a spend debits the user and credits platform revenue', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 500n)
  const result = await spend(h.money, {
    userId: USER,
    amount: 120n,
    reason: 'nda:build-shelter',
    clientKey: 'spend-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  })

  assert.equal(result.replayed, false)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 380n)
  // The counter-account is what makes "how much did this product earn" a query over the journal.
  // Today `ledger.source` is populated only by the /internal/* routes, so per-product revenue is
  // not derivable from the estate at all.
  assert.equal(h.ledger.balanceOf('platform', 'EMBER', 'fees'), 120n)
})

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RETIRED-ASSET DEFECT, AND THE THREE THINGS THAT MUST ALL BE TRUE AT ONCE.
 *
 * `spend` was hard-coded to SHARD. `micro-ledger` migration 13 refuses a retired asset on an
 * ACQUISITION kind, and `purchase` is one, so every call to `POST /v1/spend` 400'd in production
 * while this suite stayed green — the fake ledger did not model the guard. It does now.
 *
 * The temptation was to relabel the kind, since `transfer`, `conversion` and `adjustment` all stay
 * legal for a retired asset. That would have passed immediately and been a lie: a sale booked to
 * revenue is not an adjustment, and it would have re-opened the exact hole the guard closes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a spend defaults to EMBER and no longer trips the retired-asset guard', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 500n)
  await spend(h.money, {
    userId: USER,
    amount: 10n,
    reason: 'x',
    clientKey: 'k-default',
    correlationId: 'r',
    actor: `user:${USER}`,
  })
  const entry = h.ledger.entries.at(-1)!
  assert.equal(entry.kind, 'purchase', 'the kind is still honest about what happened')
  for (const posting of entry.postings ?? []) {
    assert.equal(posting.assetCode, 'EMBER')
    assert.notEqual(posting.assetCode, 'SHARD')
  }
})

test('the ledger would still refuse a purchase denominated in a retired asset', { skip }, async () => {
  // The guard is real and this proves the fake models it — without which the test above could pass
  // for the wrong reason. `spend` can no longer REACH this state (the type forbids it), so it is
  // driven through the ledger client directly.
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
  await assert.rejects(
    () =>
      h.ledger.postEntry({
        kind: 'purchase',
        actor: `user:${USER}`,
        correlationId: 'r',
        idempotencyKey: 'direct-shard-purchase',
        description: 'a sale priced in a wound-down unit',
        postings: [
          {
            direction: 'debit',
            amount: 10n,
            assetCode: 'SHARD',
            sequence: 0,
            account: { subject: `user:${USER}`, assetCode: 'SHARD', purpose: 'available', type: 'liability' },
          },
          {
            direction: 'credit',
            amount: 10n,
            assetCode: 'SHARD',
            sequence: 1,
            account: { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'revenue' },
          },
        ],
      }),
    /retired/,
  )
})

test('a SHARD holder can still convert out, because the guard permits conversion', { skip }, async () => {
  /*
   * THE HALF OF THE GUARD THAT MATTERS MOST. 69 holders have 69,000 SHARD units. Retiring an asset
   * must never strand them, so `conversion` stays legal — and this asserts the drain route works,
   * which is the property a careless tightening of the guard would break silently.
   */
  h.ledger.credit(`user:${USER}`, 'SHARD', 1_000n)
  h.ledger.seedDesk('EMBER', 10n * ONE_EMBER)
  const result = await convert(h.money, {
    userId: USER,
    fromAssetCode: 'SHARD',
    toAssetCode: 'EMBER',
    amount: 100n,
    clientKey: 'drain-1',
    correlationId: 'r',
    actor: `user:${USER}`,
  })
  assert.equal(result.replayed, false)
  assert.equal(h.ledger.entries.at(-1)!.kind, 'conversion')
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 900n)
})

test('two spends of one amount in two assets are two requests, not a replay', { skip }, async () => {
  // The asset is in the idempotency fingerprint. Without it the second call would be answered with
  // the first one's entry — silently, and in the wrong unit.
  h.ledger.credit(`user:${USER}`, 'EMBER', 500n)
  h.ledger.credit(`user:${USER}`, 'BTC', 500n)
  const base = {
    userId: USER,
    amount: 10n,
    reason: 'same reason',
    clientKey: 'same-key',
    correlationId: 'r',
    actor: `user:${USER}`,
  } as const

  await spend(h.money, { ...base, assetCode: 'EMBER' })
  await assert.rejects(
    () => spend(h.money, { ...base, assetCode: 'BTC' }),
    IdempotencyKeyReuseError,
    'one key must not answer two different requests',
  )
})

test('THE RULE: a retried spend debits exactly once', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 500n)
  const input = {
    userId: USER,
    amount: 120n,
    reason: 'nda:build-shelter',
    clientKey: 'spend-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  } as const

  const first = await spend(h.money, input)
  const second = await spend(h.money, input)

  assert.equal(second.replayed, true)
  assert.equal(second.entryId, first.entryId)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 380n)
  assert.equal(h.ledger.entries.length, 1)
})

test('an unaffordable spend is the ledger’s refusal, not a check in this service', { skip }, async () => {
  // No read-then-write anywhere: the ledger refuses inside the same transaction as the postings,
  // against the real account, with a real lock. Two spends of the last Shard cannot both succeed.
  h.ledger.credit(`user:${USER}`, 'EMBER', 50n)
  await assert.rejects(
    () =>
      spend(h.money, {
        userId: USER,
        amount: 120n,
        reason: 'too much',
        clientKey: 'spend-key-1',
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    (err: unknown) => err instanceof LedgerRefusedError && err.code === 'insufficient_funds',
  )
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 50n)
})

test('concurrent spends of one balance cannot both succeed', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 100n)
  const results = await Promise.allSettled(
    ['a', 'b', 'c'].map((k) =>
      spend(h.money, {
        userId: USER,
        amount: 100n,
        reason: 'race',
        clientKey: `spend-key-${k}`,
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    ),
  )
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 0n)
})

/* ------------------------------------------------------------------ transfer */

test('a transfer moves value between two users in one entry', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
  await transfer(h.money, {
    userId: USER,
    toUserId: OTHER,
    assetCode: 'SHARD',
    amount: 200n,
    clientKey: 'transfer-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  })
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 300n)
  assert.equal(h.ledger.balanceOf(`user:${OTHER}`, 'SHARD', 'available'), 200n)
  assert.equal(h.ledger.entries.length, 1, 'one entry, not a debit and a credit')
})

test('a transfer to oneself is refused', { skip }, async () => {
  await assert.rejects(
    () =>
      transfer(h.money, {
        userId: USER,
        toUserId: USER,
        assetCode: 'SHARD',
        amount: 1n,
        clientKey: 'transfer-key-1',
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    (err: unknown) => err instanceof MoneyError && err.code === 'same_subject',
  )
})

/* ------------------------------------------------------------------ conversion */

test('a conversion posts two balanced pairs, one per asset', { skip }, async () => {
  // `balanceEntry` requires Σ debits = Σ credits PER ASSET, so a conversion cannot be two
  // postings: each asset needs its own counter-account.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 1_000n)
  const result = await convert(h.money, {
    userId: USER,
    fromAssetCode: 'EMBER',
    toAssetCode: 'SHARD',
    amount: 2n * ONE_EMBER,
    clientKey: 'convert-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  })

  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 8n * ONE_EMBER)
  // 2 EMBER at $2.50 = $5.00 = 500 Shards, at 100 Shards per USD.
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 500n)
  /*
   * BOTH COUNTER-LEGS ARE THE DESK, AND THE SHARD SIDE GOES DOWN RATHER THAN NEGATIVE.
   *
   * These two assertions used to name `clearing` and expect the Shard side to sit at -500 — "the
   * Shard side goes negative by construction" was the design, and it was a mint: `clearing` is
   * exempt from the ledger's overdraft trigger, so the platform could issue any number of Shards it
   * did not hold. The desk is an `equity`/`inventory` account instead, it was funded with 1,000
   * above, and what is left is what it can still sell.
   */
  assert.equal(h.ledger.balanceOf('exchange', 'EMBER', 'inventory'), 2n * ONE_EMBER)
  assert.equal(h.ledger.balanceOf('exchange', 'SHARD', 'inventory'), 500n)
  assert.equal(result.summary['toAmount'], '500')
})

test('a conversion rounds down, never up', { skip }, async () => {
  // Rounding a credit up mints Shards that no coin backs; over enough conversions that is a
  // growing, invisible liability. Rounding down leaves dust on the coin side, which
  // reconciliation can see. 0.0079 EMBER at $2.50 is $0.01975, which is 1.975 Shards.
  h.ledger.credit(`user:${USER}`, 'EMBER', ONE_EMBER)
  h.ledger.seedDesk('SHARD', 1_000n)
  const result = await convert(h.money, {
    userId: USER,
    fromAssetCode: 'EMBER',
    toAssetCode: 'SHARD',
    amount: 7_900_000_000_000_000n,
    clientKey: 'convert-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  })
  assert.equal(result.summary['toAmount'], '1')
})

test('a conversion that would credit nothing is refused, not performed', { skip }, async () => {
  // Taking the input and crediting zero is not a rounding error, it is a confiscation.
  // The desk is funded, so this is the rounding refusal rather than an empty-desk one.
  h.ledger.credit(`user:${USER}`, 'EMBER', ONE_EMBER)
  h.ledger.seedDesk('SHARD', 1_000n)
  await assert.rejects(
    () =>
      convert(h.money, {
        userId: USER,
        fromAssetCode: 'EMBER',
        toAssetCode: 'SHARD',
        amount: 3_900_000_000_000_000n,
        clientKey: 'convert-key-1',
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    (err: unknown) => err instanceof MoneyError && err.code === 'amount_too_small',
  )
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), ONE_EMBER)
})

test('a retried conversion replays without re-pricing', { skip }, async () => {
  // The peek runs BEFORE pricing. A retry that re-quoted would build a different request out of a
  // moved market, and the ledger — which fingerprints the whole body — would answer the legitimate
  // retry with 409 `idempotency_key_reuse`.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 1_000n)
  const input = {
    userId: USER,
    fromAssetCode: 'EMBER',
    toAssetCode: 'SHARD',
    amount: 2n * ONE_EMBER,
    clientKey: 'convert-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  } as const

  const first = await convert(h.money, input)
  const second = await convert(h.money, input)
  assert.equal(second.replayed, true)
  assert.equal(second.entryId, first.entryId)
  assert.equal(h.ledger.entries.length, 1)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 500n)
})

test('an asset with no usable price refuses the conversion rather than guessing', { skip }, async () => {
  // A fallback rate is a rate at which somebody trades.
  h.ledger.credit(`user:${USER}`, 'BTC', 100_000_000n)
  h.ledger.seedDesk('SHARD', 1_000n)
  await assert.rejects(
    () =>
      convert(h.money, {
        userId: USER,
        fromAssetCode: 'BTC',
        toAssetCode: 'SHARD',
        amount: 100_000n,
        clientKey: 'convert-key-1',
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    (err: unknown) => err instanceof MoneyError && err.code === 'rate_unavailable' && err.status === 503,
  )
})

test('an asset cannot be converted into itself', { skip }, async () => {
  await assert.rejects(
    () =>
      convert(h.money, {
        userId: USER,
        fromAssetCode: 'EMBER',
        toAssetCode: 'EMBER',
        amount: 1n,
        clientKey: 'convert-key-1',
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    (err: unknown) => err instanceof MoneyError && err.code === 'same_asset',
  )
})

/* ------------------------------------------------------------------ the desk can run out */

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * micro-org#495 §1. THE OLD COUNTER-ACCOUNT COULD NOT REFUSE ANYTHING.
 *
 * Both conversion counter-legs used to be `clearing(asset)`, and `ledger_assert_no_overdraft()`
 * returns *allow* for `type = 'clearing'` before it ever reads `overdraft_allowed`. So a user
 * converting into EMBER was credited EMBER out of an account with no EMBER in it and the platform
 * owed a coin it had never held. The desk is `equity`/`inventory`, which reaches the check.
 *
 * Every test below asserts on the JOURNAL and not only on the exception. "It answered 409" is
 * satisfied by a refusal that happens after the user has already been debited, and the whole point
 * of moving the guard into the entry's own transaction is that no such state exists.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

const CONVERT_INPUT = {
  userId: USER,
  fromAssetCode: 'EMBER',
  toAssetCode: 'SHARD',
  amount: 2n * ONE_EMBER,
  clientKey: 'convert-key-1',
  correlationId: 'req-1',
  actor: `user:${USER}`,
} as const

test('THE RULE: an empty desk refuses the conversion and posts nothing', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  // No `seedDesk`. This is the estate on the day the desk is created and before anyone funds it.
  await assert.rejects(
    () => convert(h.money, CONVERT_INPUT),
    (err: unknown) =>
      err instanceof MoneyError && err.code === 'desk_inventory_short' && err.status === 409,
  )
  assert.equal(h.ledger.entries.length, 0, 'the journal must have no entry at all')
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 10n * ONE_EMBER)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 0n)
})

test('a conversion bigger than the desk holds is refused, and posts nothing', { skip }, async () => {
  // Funded, but not enough: 2 EMBER at $2.50 wants 500 Shards and the desk has 100. This is the
  // half of the pre-check that can only run AFTER pricing — the size of the order in the OUTPUT
  // asset does not exist until the output amount does.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 100n)
  await assert.rejects(
    () => convert(h.money, CONVERT_INPUT),
    (err: unknown) => err instanceof MoneyError && err.code === 'desk_inventory_short',
  )
  assert.equal(h.ledger.entries.length, 0)
  assert.equal(h.ledger.balanceOf('exchange', 'SHARD', 'inventory'), 100n)
})

test('THE RULE: the refusal never discloses what the desk holds', { skip }, async () => {
  /*
   * What the desk is holding is a trading signal — it is what somebody would need in order to size
   * an order against the platform's book — so an anonymous 409 must not publish it. The two ways in
   * are also worded IDENTICALLY, because a caller who could tell "empty" from "not enough" could
   * binary-search the inventory out of the difference, which is the same disclosure by a slower
   * route.
   */
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const empty = await convert(h.money, CONVERT_INPUT).catch((err: unknown) => err)

  h = harness(sql)
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 137n)
  const short = await convert(h.money, CONVERT_INPUT).catch((err: unknown) => err)

  assert.ok(empty instanceof MoneyError && short instanceof MoneyError)
  assert.equal(empty.message, short.message, 'empty and short must be indistinguishable')
  assert.match(empty.message, /SHARD/, 'the ASSET is named — a person must know which side is short')
  assert.doesNotMatch(short.message, /137|100|\b0\b/, 'the FIGURE must not appear')
})

test('a desk emptied inside the race window still loses cleanly', { skip }, async () => {
  /*
   * The pre-check is a read-then-write over the network and is therefore not the guarantee: another
   * conversion can empty the desk between it and the posting. The guarantee is the ledger's
   * `overdraft_allowed = false` check, inside the entry's transaction, with the balance row locked
   * — and this asserts the loser of that race gets the SAME answer as everyone else rather than a
   * raw constraint violation.
   *
   * The window is simulated at the only place it exists: the desk is drained in `postEntry`, after
   * `convert` has read the inventory and decided it could be filled.
   */
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 500n)
  const racing = {
    ...h.ledger,
    postEntry(request: Parameters<typeof h.ledger.postEntry>[0]) {
      h.ledger.seedDesk('SHARD', -400n)
      return h.ledger.postEntry(request)
    },
  }

  await assert.rejects(
    () => convert({ ...h.money, ledger: racing }, CONVERT_INPUT),
    (err: unknown) => err instanceof MoneyError && err.code === 'desk_inventory_short',
  )
  assert.equal(h.ledger.entries.length, 0)
})

test('THE RULE: a user’s own shortfall is not reported as the desk’s', { skip }, async () => {
  /*
   * `insufficient_funds` is one ledger code for two opposite facts. The user cannot afford the
   * INPUT leg here — the desk is fully funded — and telling them "the desk is out of SHARD" would
   * send them away to try again later over a balance that is never going to be enough. The `subject`
   * on the ledger's refusal is what separates the two, which is why it was added to micro-ledger
   * rather than recovered by matching English.
   */
  h.ledger.credit(`user:${USER}`, 'EMBER', ONE_EMBER)
  h.ledger.seedDesk('SHARD', 10_000n)
  await assert.rejects(
    () => convert(h.money, CONVERT_INPUT),
    (err: unknown) =>
      err instanceof LedgerRefusedError &&
      err.code === 'insufficient_funds' &&
      err.subject === `user:${USER}`,
  )
  assert.equal(h.ledger.entries.length, 0)
})

/* ------------------------------------------------------------------ funding the desk */

const FUND = {
  adminUserId: ADMIN,
  sourceAccount: `user:${OTHER}`,
  assetCode: 'SHARD',
  amount: 1_000n,
  reason: 'seeding the SHARD book',
  direction: 'in',
  clientKey: 'fund-key-1',
  correlationId: 'req-1',
  actor: `user:${ADMIN}`,
} as const

test('funding the desk moves stock into it under liquidity_seed', { skip }, async () => {
  h.ledger.credit(`user:${OTHER}`, 'SHARD', 5_000n)
  const result = await fundDesk(h.money, FUND)

  assert.equal(result.replayed, false)
  assert.equal(h.ledger.entries.at(-1)!.kind, 'liquidity_seed', 'a kind that already existed')
  assert.equal(h.ledger.balanceOf('exchange', 'SHARD', 'inventory'), 1_000n)
  assert.equal(h.ledger.balanceOf(`user:${OTHER}`, 'SHARD', 'available'), 4_000n)
  assert.equal(result.summary['direction'], 'in')
})

test('THE RULE: a funding is reversible by the same route', { skip }, async () => {
  /*
   * §2 requires the entry to be reversible by a negative-direction sibling rather than by a second
   * route or by hand-written SQL. `direction` is that sibling, and it is in the idempotency
   * fingerprint: funding and its reversal are the same amount, asset and account, so a key that
   * could not tell them apart would answer the reversal with the funding's entry and report money
   * as moved back when it had not.
   */
  h.ledger.credit(`user:${OTHER}`, 'SHARD', 5_000n)
  await fundDesk(h.money, FUND)
  const back = await fundDesk(h.money, {
    ...FUND,
    direction: 'out',
    reason: 'wrong amount, putting it back',
    clientKey: 'fund-key-2',
  })

  assert.equal(back.replayed, false)
  assert.equal(h.ledger.entries.length, 2, 'two entries, not one replayed')
  assert.equal(h.ledger.balanceOf('exchange', 'SHARD', 'inventory'), 0n)
  assert.equal(h.ledger.balanceOf(`user:${OTHER}`, 'SHARD', 'available'), 5_000n)
})

test('a drawdown larger than the desk holds is refused', { skip }, async () => {
  // The desk being non-exempt cuts both ways: a reversal cannot leave the inventory negative
  // either, so a fat-fingered drawdown is refused rather than silently overdrawing the book.
  h.ledger.seedDesk('SHARD', 100n)
  await assert.rejects(
    () => fundDesk(h.money, { ...FUND, direction: 'out' }),
    (err: unknown) =>
      err instanceof LedgerRefusedError &&
      err.code === 'insufficient_funds' &&
      err.subject === 'exchange',
  )
  assert.equal(h.ledger.balanceOf('exchange', 'SHARD', 'inventory'), 100n)
})

test('funding out of a treasury that holds nothing is refused', { skip }, async () => {
  /*
   * **Funding does not CREATE stock**, and this is the assertion that says so. `platform`'s
   * treasury is an `equity` account and equity is not overdraft-exempt either, so a treasury that
   * has never held SHARD cannot seed a SHARD desk. It is the correct refusal — a desk funded out of
   * an empty account is the same unbacked liability one account further back — and it does mean a
   * cold estate has to put the asset in the treasury first. That is recorded on micro-org#495.
   */
  await assert.rejects(
    () => fundDesk(h.money, { ...FUND, sourceAccount: 'platform' }),
    (err: unknown) =>
      err instanceof LedgerRefusedError &&
      err.code === 'insufficient_funds' &&
      err.subject === 'platform',
  )
  assert.equal(h.ledger.balanceOf('exchange', 'SHARD', 'inventory'), 0n)
})

test('a misspelt source account is refused rather than opened', { skip }, async () => {
  // The ledger CREATES an account it has not seen. A typo therefore does not fail: it opens a
  // permanent account with a misspelt name and moves real money into a place no route can spend it
  // out of. A uuid check is the difference between a 422 and a manual correction entry.
  for (const sourceAccount of ['user:not-a-uuid', 'platfrom', 'treasury']) {
    await assert.rejects(
      () => fundDesk(h.money, { ...FUND, sourceAccount }),
      (err: unknown) =>
        err instanceof MoneyError && err.code === 'unknown_source' && err.status === 422,
    )
  }
  assert.equal(h.ledger.entries.length, 0)
})

test('the inventory read reports every asset the desk holds, formatted', { skip }, async () => {
  // The figure IS returned here, and that is not in tension with the refusal hiding it: this backs
  // a `requireAdmin` route, and an operator deciding whether to fund the desk has to see what is in
  // it. `available` under the same subject is deliberately not counted as stock.
  h.ledger.seedDesk('SHARD', 1_000n)
  h.ledger.seedDesk('EMBER', 3n * ONE_EMBER)
  h.ledger.credit('exchange', 'BTC', 500n)

  assert.deepEqual(await deskInventory(h.money), [
    { assetCode: 'EMBER', amount: '3000000000000000000', amountFormatted: '3' },
    { assetCode: 'SHARD', amount: '1000', amountFormatted: '1000' },
  ])
})

/* ------------------------------------------------------------------ the desk, at scrape time */

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * micro-org#501. NOTHING IN THE ESTATE COULD SEE THE DESK RUN OUT.
 *
 * The refusal above is correct and it is also the ONLY signal that existed: `convert` threw
 * `desk_inventory_short` before the route's counter ran, so a dry desk produced a 409 to one user
 * and complete silence to everyone else. No gauge, no counter, no log line an operator would find.
 * The first party to learn the desk was empty would have been the person holding the 409, and the
 * desk cannot refill itself — `fundDesk` is `requireAdmin` and stays that way, because both
 * fundings this estate has booked drew on a USER's available balance.
 *
 * These tests are about the gauge meaning what the alert thinks it means, in the same sense
 * `depositmetrics.test.ts` is: a series that rounds, or that vanishes when the news is worst, is
 * worse than no series, because it reads as cover.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** The value of one `asset`-labelled series, or `null` when the scrape would not contain it. */
function deskSeries(metrics: Metrics, asset: string): number | null {
  const prefix = `wallet_desk_inventory{asset="${asset}"}`
  const line = metrics
    .render()
    .split('\n')
    .find((l) => l.startsWith(prefix))
  return line === undefined ? null : Number(line.slice(line.lastIndexOf(' ') + 1))
}

const scrape = async (): Promise<Metrics> => {
  const metrics = registerServiceMetrics(new Metrics())
  await sampleDeskInventory(h.money, metrics)
  return metrics
}

test('a scrape publishes what the desk holds, per asset', { skip }, async () => {
  h.ledger.seedDesk('SHARD', 1_000n)
  h.ledger.seedDesk('EMBER', 3n * ONE_EMBER)
  // Not stock: the same rule `deskInventory` follows. Counting an `available` balance under the
  // `exchange` subject as inventory would publish a number the desk cannot actually sell out of,
  // and an alert on it would go quiet for the wrong reason.
  h.ledger.credit('exchange', 'BTC', 500n)

  const metrics = await scrape()
  assert.equal(deskSeries(metrics, 'EMBER'), 3)
  assert.equal(deskSeries(metrics, 'SHARD'), 1000)
  assert.equal(deskSeries(metrics, 'BTC'), null)
})

test('THE RULE: the gauge is whole units, because a wei-valued sample is a rounded one', { skip }, async () => {
  /*
   * The mainnet desk held 28,432.78 EMBER when this was written. A Prometheus sample is a float64
   * and that balance is 2.843278e22 wei — four orders of magnitude past 2^53, the last integer a
   * float64 holds exactly. Exporting the smallest unit would publish a silently rounded number as
   * the input to a threshold, which is the one job this series has.
   *
   * The second assertion is the defect itself rather than the fix: it is what the series would have
   * carried, and it is not the balance.
   */
  const wei = 28_432_780_000_000_000_000_000n
  h.ledger.seedDesk('EMBER', wei)

  assert.equal(deskSeries(await scrape(), 'EMBER'), 28_432.78)
  assert.notEqual(BigInt(Number(wei)), wei, 'if this ever passes, float64 has changed and so can we')
})

test('THE RULE: an asset the desk never held publishes nothing, so absent is not a zero', { skip }, async () => {
  /*
   * There is no balance row for an asset the desk was never funded in, so there is no series, so
   * `wallet_desk_inventory < x` never fires for it and the silence is indistinguishable from
   * health. This is asserted rather than left implicit because it is the entire reason
   * `ExchangeDeskInventoryShort` alerts on the REFUSAL counter instead of on this gauge: the
   * conversion route increments `outcome="desk_short"` whether or not an account exists.
   *
   * The opposite choice — publishing 0 for every asset in the catalogue, as the deposit gauges do
   * per chain — is wrong here. A chain list is fixed by the build; which assets the desk is meant
   * to trade is a business decision nothing in this service holds, so a fabricated 0 would page the
   * operator about a desk they never intended to open.
   */
  h.ledger.seedDesk('EMBER', 5n * ONE_EMBER)
  const metrics = await scrape()
  assert.equal(deskSeries(metrics, 'EMBER'), 5)
  assert.equal(deskSeries(metrics, 'LTC'), null)
  assert.doesNotMatch(metrics.render(), /wallet_desk_inventory\{asset="LTC"\}/)
})

test('THE RULE: the series name is registered, or every write is dropped in silence', { skip }, async () => {
  // `Metrics.set` on an unregistered name reports and returns — it does not throw — so a sampler
  // wired to a name nobody registered scrapes clean for ever. That is how a gauge gets deployed
  // and alerted on without existing. The registry is the thing under test here, not the sampler.
  const dropped: DroppedMetricWrite[] = []
  const metrics = registerServiceMetrics(new Metrics({ onDropped: (d) => dropped.push(d) }))
  h.ledger.seedDesk('EMBER', ONE_EMBER)

  await sampleDeskInventory(h.money, metrics)
  assert.deepEqual(dropped, [], 'a dropped write means the name or the label is unregistered')
  assert.match(metrics.render(), /# TYPE wallet_desk_inventory gauge/)
})

/* ------------------------------------------------------------------ the quote */

test('a quote gives the conversion’s figures and books nothing', { skip }, async () => {
  const quote = await quoteConversion(h.money, {
    fromAssetCode: 'ember',
    toAssetCode: 'shard',
    amount: 2n * ONE_EMBER,
  })

  assert.equal(quote.fromAssetCode, 'EMBER')
  assert.equal(quote.toAmount, '500')
  assert.equal(quote.toAmountFormatted, '500')
  assert.equal(quote.fromAmountFormatted, '2')
  assert.equal(h.ledger.entries.length, 0, 'a quote is not a conversion')
})

test('THE RULE: a quote says in the payload that it is not a hold', { skip }, async () => {
  // In a FIELD, not in prose only the API docs carry. Nothing is reserved by asking: the rate can
  // move and somebody else can spend the inventory in the same window. A surface that renders a
  // quote as a hold is making a promise this service has not made, and the only way to stop that
  // being an easy mistake is to put the disclaimer in the payload it is already rendering.
  const quote = await quoteConversion(h.money, {
    fromAssetCode: 'EMBER',
    toAssetCode: 'SHARD',
    amount: ONE_EMBER,
  })
  assert.equal(quote.hold, false)
  assert.match(quote.holdNotice, /not a hold/i)
})

test('a quote does not answer whether the desk could fill it', { skip }, async () => {
  /*
   * The desk is deliberately NOT consulted here. An unlimited, free, unbooked route that answers
   * "can you fill N?" is an oracle: a caller binary-searches N and reads the inventory straight out
   * of it — the figure `desk_inventory_short` exists not to disclose. So an unfillable amount is
   * quoted like any other and refused at the conversion, which costs one request.
   */
  const quote = await quoteConversion(h.money, {
    fromAssetCode: 'EMBER',
    toAssetCode: 'SHARD',
    amount: 1_000n * ONE_EMBER,
  })
  assert.equal(quote.toAmount, '250000')
  assert.equal(h.ledger.balanceOf('exchange', 'SHARD', 'inventory'), 0n)
})

/* ------------------------------------------------------------------ reading them back */

test('conversions are read out of the journal, newest first, and page', { skip }, async () => {
  /*
   * micro-org#495 §3, and the reason there is no conversions table: the entry IS the conversion.
   * A wallet-side copy would be a second record of the same fact, written in a second transaction,
   * free to disagree with the first — and invisibly, because the surface would read the copy.
   */
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 10_000n)
  for (const key of ['c1', 'c2', 'c3']) {
    await convert(h.money, { ...CONVERT_INPUT, amount: ONE_EMBER, clientKey: key })
  }

  const first = await listConversions(h.money, { userId: USER, limit: 2 })
  assert.equal(first.conversions.length, 2)
  assert.equal(first.conversions[0]!.fromAssetCode, 'EMBER')
  assert.equal(first.conversions[0]!.toAmount, '250')
  assert.equal(first.conversions[0]!.fromAmountFormatted, '1')
  assert.ok(first.nextCursor, 'a full page with more behind it carries a cursor')

  const second = await listConversions(h.money, {
    userId: USER,
    limit: 2,
    cursor: first.nextCursor!,
  })
  assert.equal(second.conversions.length, 1)
  assert.equal(second.nextCursor, null, 'null on the last page — callers page until null')
  const ids = [...first.conversions, ...second.conversions].map((c) => c.id)
  assert.equal(new Set(ids).size, 3, 'no entry appears on two pages')
})

test('THE RULE: another user’s conversion reads as absent, not as forbidden', { skip }, async () => {
  /*
   * Fail-closed in all three directions — not this service's entry, not a conversion, not this
   * user's — and to the SAME `null` a nonexistent id gets. A caller who could tell "somebody else's
   * conversion" from "no such conversion" would have an oracle for entry ids.
   */
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 10_000n)
  const posted = await convert(h.money, CONVERT_INPUT)

  const mine = await readConversion(h.money, { userId: USER, entryId: posted.entryId })
  assert.equal(mine?.id, posted.entryId)
  assert.equal(mine?.rateScale, '1000000')

  assert.equal(await readConversion(h.money, { userId: OTHER, entryId: posted.entryId }), null)
  assert.equal(await readConversion(h.money, { userId: USER, entryId: 'entry-999' }), null)
})

test('transfers read back from both ends of the entry', { skip }, async () => {
  // The ledger's subject filter is an ENTRY-level filter, so an entry with a posting against this
  // user comes back whichever end that posting is. A "transfers" list showing only what somebody
  // had sent would be a strange thing to hand a person looking for money a friend says they sent.
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
  h.ledger.credit(`user:${OTHER}`, 'SHARD', 500n)
  await transfer(h.money, {
    userId: USER,
    toUserId: OTHER,
    assetCode: 'SHARD',
    amount: 200n,
    clientKey: 'out-1',
    correlationId: 'r',
    actor: `user:${USER}`,
  })
  await transfer(h.money, {
    userId: OTHER,
    toUserId: USER,
    assetCode: 'SHARD',
    amount: 50n,
    clientKey: 'in-1',
    correlationId: 'r',
    actor: `user:${OTHER}`,
  })

  const page = await listTransfers(h.money, { userId: USER, limit: 10 })
  assert.deepEqual(
    page.transfers.map((t) => [t.direction, t.amount, t.counterpartyUserId]),
    [
      ['in', '50', OTHER],
      ['out', '200', OTHER],
    ],
  )
  assert.equal(page.nextCursor, null)
})

test('a conversion emits into the empty activity category', { skip }, async () => {
  /*
   * micro-org#495 §4. `activity/src/categories.ts` has listed `conversion` since that service was
   * written and nothing has ever produced into it, so a user who swapped one coin for another read
   * a feed that did not mention it. The row is written inside `withIdempotency`'s transaction, so
   * the event and the stored response commit together — a publish after commit is a publish that is
   * skipped when the process dies in between.
   */
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.seedDesk('SHARD', 10_000n)
  const posted = await convert(h.money, CONVERT_INPUT)

  const rows = await sql<
    Array<{ topic: string; key: string; payload: Record<string, unknown> }>
  >`select topic, key, payload from outbox`
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.topic, 'wallet.conversion.completed')
  assert.equal(rows[0]!.key, posted.entryId, 'keyed by the entry, which IS the conversion')
  assert.equal(rows[0]!.payload['toAmountFormatted'], '500')
  assert.equal(rows[0]!.payload['userId'], USER)
})
