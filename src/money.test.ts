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
import { MoneyError, convert, spend, transfer } from './money.ts'
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
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
  const result = await spend(h.money, {
    userId: USER,
    amount: 120n,
    reason: 'nda:build-shelter',
    clientKey: 'spend-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  })

  assert.equal(result.replayed, false)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 380n)
  // The counter-account is what makes "how much did this product earn" a query over the journal.
  // Today `ledger.source` is populated only by the /internal/* routes, so per-product revenue is
  // not derivable from the estate at all.
  assert.equal(h.ledger.balanceOf('platform', 'SHARD', 'fees'), 120n)
})

test('THE RULE: a retried spend debits exactly once', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
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
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 380n)
  assert.equal(h.ledger.entries.length, 1)
})

test('an unaffordable spend is the ledger’s refusal, not a check in this service', { skip }, async () => {
  // No read-then-write anywhere: the ledger refuses inside the same transaction as the postings,
  // against the real account, with a real lock. Two spends of the last Shard cannot both succeed.
  h.ledger.credit(`user:${USER}`, 'SHARD', 50n)
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
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 50n)
})

test('concurrent spends of one balance cannot both succeed', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'SHARD', 100n)
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
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 0n)
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
  // The clearing account holds both sides. A non-zero clearing balance is the first thing
  // reconciliation looks at, and here it is exactly the coin taken in exchange for the Shards
  // issued — if the two stop corresponding, something is minting.
  assert.equal(h.ledger.balanceOf('clearing', 'EMBER', 'available'), 2n * ONE_EMBER)
  assert.equal(h.ledger.balanceOf('clearing', 'SHARD', 'available'), -500n)
  assert.equal(result.summary['toAmount'], '500')
})

test('a conversion rounds down, never up', { skip }, async () => {
  // Rounding a credit up mints Shards that no coin backs; over enough conversions that is a
  // growing, invisible liability. Rounding down leaves dust on the coin side, which
  // reconciliation can see. 0.0079 EMBER at $2.50 is $0.01975, which is 1.975 Shards.
  h.ledger.credit(`user:${USER}`, 'EMBER', ONE_EMBER)
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
  h.ledger.credit(`user:${USER}`, 'EMBER', ONE_EMBER)
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
