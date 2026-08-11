/**
 * What a scrape says about the two deposit backlogs.
 *
 * These are separated from `deposits.test.ts` because they are not about crediting; they are about
 * the one thing micro-org#310 is: whether a number the estate alerts on means what the alert
 * thinks it means. `DepositAddressFrozen` read `wallet_deposit_address_frozen`, a metric no service
 * has ever exported and a state — a frozen deposit address — that does not exist in this schema at
 * all (`deposit_address_assignments_status_ck` admits `active`, `rotated`, `retired`). The
 * condition it *described* is forge-pay's, and `deposits.ts`'s header records why it cannot happen
 * here. What remains is the backlog these tests are about, and it was being measured badly enough
 * that no honest rule could have been written on it either.
 *
 * The file covers TWO backlogs now, because micro-org#326 found the identical pair of defects on
 * the credit-posting side: `wallet_deposit_credits_pending` was the `.length` of a 500-row page, so
 * it saturated, and the leased retry job wrote its own 50-row cap over the same series name. An
 * address nobody registered is money nobody will be told about; a credit nobody posted is money the
 * owner cannot see. Same failure, opposite ends of the deposit path, same two measurement bugs — so
 * the tests that pin one belong beside the tests that pin the other, or the next gauge is fixed one
 * at a time again.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { Metrics, type DroppedMetricWrite } from '@cloudsforge/telemetry'
import { CHAIN_IDS } from './addresses.ts'
import {
  assignDepositAddress,
  pendingCreditCount,
  pendingCredits,
  sampleDepositAddressMetrics,
  unwatchedAssignments,
  unwatchedByChain,
} from './deposits.ts'
import { IndexerUnavailableError } from './indexerclient.ts'
import { indexerObservability, payableChainsOnly, payableFromFeeQuotes } from './observability.ts'
import { registerServiceMetrics } from './server.ts'
import { POST_CREDIT_KIND, WATCH_KIND, registerHandlers } from './jobs.ts'
import type { JobRunner } from '@cloudsforge/jobs'
import {
  enabled,
  harness,
  migrateTestDb,
  openDb,
  quietLogger,
  resetWallet,
  skip,
  testUser,
  type Harness,
} from './testsupport.ts'

let sql: postgres.Sql
let h: Harness

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

/** One assignment that the indexer never accepted, so it stays unwatched. */
async function unwatched(assetCode: string, userId: string): Promise<void> {
  h.indexer.failNext(new Error('indexer said no'))
  await assignDepositAddress(h.deposits, { userId, assetCode, correlationId: 'req-0' })
}

/** The value of one series, or `null` when the scrape would not contain it at all. */
function series(metrics: Metrics, name: string, chain: string): number | null {
  const line = metrics
    .render()
    .split('\n')
    .find((l) => l.startsWith(`${name}{chain="${chain}"}`))
  return line === undefined ? null : Number(line.slice(line.lastIndexOf(' ') + 1))
}

const sample = async (): Promise<Metrics> => {
  const metrics = registerServiceMetrics(new Metrics())
  await sampleDepositAddressMetrics(h.deposits, metrics)
  return metrics
}

/* --------------------------------------------------------------- the backlog, per chain */

test('the backlog is published per chain, not as one number for the estate', { skip }, async () => {
  // DOGE first: the fake custody's published-vector pools are small and its counter is global, so
  // a pooled chain has to be asked for before the unbounded EVM shape has used the count up.
  await unwatched('DOGE', testUser(1))
  await unwatched('EMBER', testUser(2))
  await unwatched('EMBER', testUser(3))

  const metrics = await sample()
  assert.equal(series(metrics, 'wallet_deposit_addresses_unwatched', 'ember'), 2)
  assert.equal(series(metrics, 'wallet_deposit_addresses_unwatched', 'doge'), 1)
  // The scalar this replaced said "3", and an operator holding it had to open psql to learn which
  // chain to go and look at. That is the whole of the change.
  assert.equal(series(metrics, 'wallet_deposit_addresses_unwatched', 'ltc'), 0)
})

test('every chain this build knows has a series, so absent never means healthy', { skip }, async () => {
  const metrics = await sample()
  for (const chain of CHAIN_IDS) {
    // A MEASURED zero, not a fabricated one: the query ran and returned no rows for this chain.
    // It is written rather than implied because a labelled gauge cannot be removed once set — a
    // chain whose backlog cleared would otherwise keep publishing the number it had when it did.
    assert.equal(series(metrics, 'wallet_deposit_addresses_unwatched', chain), 0, chain)
    assert.equal(series(metrics, 'wallet_deposit_addresses_unobservable', chain), 0, chain)
  }
})

test('the count is a count, not the length of a page', { skip }, async () => {
  // 600 rows, inserted directly: the point is the number, and 600 assignments through the real
  // path would be 600 round trips to custody for no extra proof. `status = 'rotated'` because the
  // partial unique index permits one ACTIVE assignment per (user, asset, network) — which is also
  // the case worth pinning, since money arriving at a rotated address is still the user's and a
  // rotated row with a null `watched_at` is still a registration that is missing.
  const user = testUser(1)
  h.indexer.failNext(new Error('indexer said no'))
  const seed = await assignDepositAddress(h.deposits, {
    userId: user,
    assetCode: 'LTC',
    correlationId: 'req-0',
  })
  await sql`
    insert into deposit_address_assignments
      (id, user_id, asset_code, chain, network, wallet_id, address, address_key,
       custody_key_urn, status, assigned_at)
    select gen_random_uuid(), ${user}::uuid, 'LTC', 'ltc', 'testnet', w.wallet_id,
           'ltc1q' || n::text, 'ltc1q' || n::text, 'urn:test:' || n::text, 'rotated', now()
      from generate_series(1, 599) as n
     cross join (select wallet_id from deposit_address_assignments where id = ${seed.id}) as w
  `

  assert.equal((await unwatchedByChain(h.deposits.sql, 'testnet')).get('ltc'), 600)
  // What the scrape used to publish. `min(backlog, 500)` is a gauge that stops moving at exactly
  // the point the backlog becomes serious, and reports the same number for 500 and for 50,000.
  assert.equal((await unwatchedAssignments(h.deposits.sql, 500)).length, 500)
  assert.equal(series(await sample(), 'wallet_deposit_addresses_unwatched', 'ltc'), 600)
})

test('a row on another network is not this deployment’s backlog', { skip }, async () => {
  const user = testUser(1)
  h.indexer.failNext(new Error('indexer said no'))
  const seed = await assignDepositAddress(h.deposits, {
    userId: user,
    assetCode: 'LTC',
    correlationId: 'req-0',
  })
  // A mainnet row in a testnet deployment's database. `claimCredit` refuses movements on it with
  // `wrong_network` and `assign` never writes it, so it is not this process's to repair — and
  // counting it would page an estate that cannot act on it.
  await sql`
    insert into deposit_address_assignments
      (id, user_id, asset_code, chain, network, wallet_id, address, address_key,
       custody_key_urn, status, assigned_at)
    select gen_random_uuid(), ${user}::uuid, 'LTC', 'ltc', 'mainnet', wallet_id,
           'ltc1qmainnet', 'ltc1qmainnet', 'urn:test:mainnet', 'rotated', now()
      from deposit_address_assignments where id = ${seed.id}
  `
  assert.equal(series(await sample(), 'wallet_deposit_addresses_unwatched', 'ltc'), 1)
})

/* --------------------------------------------------------------- observability */

test('unobservable is published on every scrape, so the repairable part is computable', { skip }, async () => {
  // The alert that replaces `DepositAddressFrozen` is `unwatched - unobservable > 0`, and it can
  // only be evaluated where BOTH series exist. This one used to be written exclusively by the
  // leased `deposit.watch` job, so it existed on the one replica that claimed the job and was
  // absent on every other — and on those, the subtraction returned nothing at all.
  await unwatched('LTC', testUser(1))
  await unwatched('DOGE', testUser(2))
  h.indexer.setProviders('ltc', 'testnet', 0)

  const metrics = await sample()
  // LTC: nothing follows the chain. The backlog is real and is not a fault — it is an owner
  // deciding whether to support the chain — so it cancels out of the repairable part.
  assert.equal(series(metrics, 'wallet_deposit_addresses_unwatched', 'ltc'), 1)
  assert.equal(series(metrics, 'wallet_deposit_addresses_unobservable', 'ltc'), 1)
  // DOGE: followed, and still unregistered. This is the one somebody has to fix.
  assert.equal(series(metrics, 'wallet_deposit_addresses_unwatched', 'doge'), 1)
  assert.equal(series(metrics, 'wallet_deposit_addresses_unobservable', 'doge'), 0)
})

test('whether this estate takes deposits on a chain at all is a series', { skip }, async () => {
  h.indexer.setProviders('btc', 'testnet', 0)
  const metrics = await sample()
  // Measured from the indexer, per deployment — never asserted from a list in this repository.
  assert.equal(series(metrics, 'wallet_chain_observable', 'btc'), 0)
  assert.equal(series(metrics, 'wallet_chain_observable', 'ember'), 1)
  assert.equal(series(metrics, 'wallet_chain_observability_unknown', 'btc'), 0)
})

test('“the indexer follows no source” and “we could not ask” are two series', { skip }, async () => {
  // Both refuse deposits and both read 0 on `wallet_chain_observable`. Only one of them is a fault,
  // and an operator seeing a zero has to be able to tell which — the same reason
  // `ledger_reconciliation_observed` sits beside `ledger_reconciliation_drift`.
  const metrics = registerServiceMetrics(new Metrics())
  await sampleDepositAddressMetrics(
    {
      ...h.deposits,
      // An indexer this process has never reached, rather than one that answered "no sources".
      // Only an *unavailability* produces `unknown`; a refusal is `not_followed` by another name,
      // which is why the fake's `failStatusNext` hook takes an error class at all.
      observability: indexerObservability({
        indexer: {
          chainStatus: () => Promise.reject(new IndexerUnavailableError('ECONNREFUSED')),
        },
      }),
    },
    metrics,
  )

  assert.equal(series(metrics, 'wallet_chain_observable', 'ember'), 0)
  assert.equal(series(metrics, 'wallet_chain_observability_unknown', 'ember'), 1)
})

/* -------------------------------------------------------------- retrievability */

/**
 * The deposit gate as this service actually assembles it in `index.ts`: the payability check
 * OUTERMOST, so a chain this deployment cannot pay out of never reaches the indexer at all.
 * `feeQuotes` names the assets an operator has stated a withdrawal fee for.
 */
function gated(feeQuotes: Record<string, bigint>): Parameters<typeof sampleDepositAddressMetrics>[0] {
  return {
    ...h.deposits,
    observability: payableChainsOnly({
      observability: h.deposits.observability,
      payable: payableFromFeeQuotes(feeQuotes).payable,
    }),
  }
}

test('retrievability is a series of its own, and a scrape actually carries it', { skip }, async () => {
  // micro-org#373 §6.1's gate has been shipping since 2.5.18 and its series has never once been
  // scraped: `deposits.ts` wrote `wallet_chain_not_retrievable`, `server.ts` never registered that
  // name, and `Metrics.set` drops an unregistered write on its first line. Measured on the running
  // mainnet container on 2026-08-11 — `/metrics` carried the two gauges below and no third one.
  // So this asserts the series RENDERS, not that a setter was called: `series()` returns null for a
  // name absent from `render()`, which is exactly the state the defect left production in.
  const metrics = registerServiceMetrics(new Metrics())
  await sampleDepositAddressMetrics(gated({ EMBER: 21_000_000_000_000n }), metrics)

  // EMBER: the fee table names it and the indexer follows it. Both halves, so the gate is open.
  assert.equal(series(metrics, 'wallet_chain_retrievable', 'ember'), 1)
  assert.equal(series(metrics, 'wallet_chain_observable', 'ember'), 1)

  // LTC: the indexer follows it PERFECTLY — that is the state in which a missing second condition
  // looks fine — and the fee table does not name it, so the gate is shut. An operator reading only
  // `wallet_chain_observable` sees a 0 identical to an indexer outage's and goes to the wrong
  // service; the two series below are what tell them apart without reading source.
  assert.equal(series(metrics, 'wallet_chain_retrievable', 'ltc'), 0)
  assert.equal(series(metrics, 'wallet_chain_observable', 'ltc'), 0)
  assert.equal(series(metrics, 'wallet_chain_observability_unknown', 'ltc'), 0)
})

test('a scrape publishes every series it writes', { skip }, async () => {
  // The general form of the defect above, and the reason it survived a release: a metric write to a
  // name nobody registered is REPORTED and never thrown, by design — observability failing must not
  // become an outage — so the only trace was one deduplicated stderr line at boot. Asserting the
  // registry dropped nothing catches the next one at the commit that introduces it, whatever it is
  // called, rather than at the next time somebody opens a dashboard looking for it.
  const dropped: DroppedMetricWrite[] = []
  const metrics = registerServiceMetrics(new Metrics({ onDropped: (d) => dropped.push(d) }))
  await sampleDepositAddressMetrics(gated({ EMBER: 21_000_000_000_000n }), metrics)
  assert.deepEqual(dropped, [], 'a scrape wrote a series no operator can read')
})

test('an address already issued on a chain that cannot pay out is counted, not just refused', { skip }, async () => {
  // micro-org#373 §6.2, generalised. The gate shuts the door on NEW addresses and cannot recall the
  // ones handed out before it existed — on mainnet that is a `btc | mainnet` assignment from
  // 2026-08-05, one of six chains a single scripted account took an address on in three seconds,
  // three of which (eth, sol, xrp) are still unpayable today. Finding them took psql. They are a
  // number now.
  await assignDepositAddress(h.deposits, {
    userId: testUser(1),
    assetCode: 'LTC',
    correlationId: 'req-0',
  })

  const shut = registerServiceMetrics(new Metrics())
  await sampleDepositAddressMetrics(gated({ EMBER: 21_000_000_000_000n }), shut)
  assert.equal(series(shut, 'wallet_deposit_addresses_unretrievable', 'ltc'), 1)
  // Not a count of addresses: EMBER is payable, so its assignments are promises this deployment can
  // keep and are not outstanding against anything.
  assert.equal(series(shut, 'wallet_deposit_addresses_unretrievable', 'ember'), 0)

  // The same row, the same instant, one `WALLET_FEE_QUOTES` entry later. This is what proves the
  // gauge reads the retrievability condition rather than counting rows on a chain nobody deposits
  // on: nothing about the assignment changed and the number is 0.
  const open = registerServiceMetrics(new Metrics())
  await sampleDepositAddressMetrics(gated({ EMBER: 21_000_000_000_000n, LTC: 10_000n }), open)
  assert.equal(series(open, 'wallet_deposit_addresses_unretrievable', 'ltc'), 0)
  assert.equal(series(open, 'wallet_chain_retrievable', 'ltc'), 1)
})

test('retiring an unpayable address clears the gauge, and the key survives it', { skip }, async () => {
  // The other half of §6.1: the gauge above is a number an operator is supposed to be able to drive
  // to zero, and `scripts/retire-unretrievable-assignments.sql` is how. That script writes a status
  // NOTHING in this service writes — `assign` writes `active`, a rotation writes `rotated` — so the
  // only thing making `retired` mean "no longer outstanding" is `activeByChain`'s WHERE clause. If
  // somebody widens that clause to "every row ever issued", the script silently stops working and
  // the estate keeps alerting on promises it has already disowned. This pins it.
  const assignment = await assignDepositAddress(h.deposits, {
    userId: testUser(2),
    assetCode: 'LTC',
    correlationId: 'req-1',
  })

  const before = registerServiceMetrics(new Metrics())
  await sampleDepositAddressMetrics(gated({ EMBER: 21_000_000_000_000n }), before)
  assert.equal(series(before, 'wallet_deposit_addresses_unretrievable', 'ltc'), 1)

  await h.deposits.sql`
    update deposit_address_assignments set status = 'retired' where id = ${assignment.id}
  `

  const after = registerServiceMetrics(new Metrics())
  await sampleDepositAddressMetrics(gated({ EMBER: 21_000_000_000_000n }), after)
  assert.equal(series(after, 'wallet_deposit_addresses_unretrievable', 'ltc'), 0)
  // Still 0, not absent: a chain whose backlog has cleared must keep publishing its zero or an
  // alert cannot tell "resolved" from "the series went away".
  assert.notEqual(series(after, 'wallet_deposit_addresses_unretrievable', 'ltc'), null)

  // And the address is still ours. The row, its custody key and its wallet are all deliberately
  // left intact — retiring is a statement about what this estate will OFFER, not about who owns a
  // coin that already arrived. Deleting the key to tidy the row would turn an unwatched balance
  // into an unspendable one, which is strictly worse than the defect being fixed.
  const [row] = await h.deposits.sql<{ custody_key_urn: string; address: string }[]>`
    select custody_key_urn, address from deposit_address_assignments where id = ${assignment.id}
  `
  assert.equal(row?.address, assignment.address)
  assert.equal(row?.custody_key_urn, assignment.custodyKeyUrn)
})

/* --------------------------------------------------------------- the writer */

/**
 * Run one pass of a job handler against the real `registerHandlers`, and report which series it
 * published. Shared by the two tests below because they are one assertion made twice: a leased job
 * that writes a batch-capped copy of a backlog gauge is the defect, whichever gauge it is.
 */
async function publishedByJob(kind: string): Promise<readonly string[]> {
  const handlers = new Map<string, (job: never, ctx: never) => Promise<void>>()
  const runner = {
    register(k: string, handler: (job: never, ctx: never) => Promise<void>) {
      handlers.set(k, handler)
      return this
    },
  } as unknown as JobRunner
  const metrics = registerServiceMetrics(new Metrics())
  registerHandlers(runner, {
    sql: h.deposits.sql,
    logger: quietLogger(),
    metrics,
    signingSecret: 'x'.repeat(32),
    idempotencyTtlDays: 7,
    deposits: h.deposits,
    withdrawals: h.withdrawals,
  })

  await handlers.get(kind)!({} as never, {
    signal: new AbortController().signal,
    heartbeat: async () => true,
  } as never)

  // Any sample line at all, braced or bare. Asserting only on the labelled form would pass against
  // the very code this is about: the old writer passed no labels, so it published the name with an
  // empty label set — a second, unlabelled series beside the per-chain ones, which is worse than
  // either alone. `# HELP`/`# TYPE` are excluded because a registration is not a reading.
  return metrics
    .render()
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const brace = line.indexOf('{')
      return line.slice(0, brace === -1 ? line.indexOf(' ') : brace)
    })
}

test('the watch job does not publish the backlog gauges', { skip }, async () => {
  // It saw one batch of at most 50 and it is leased to one replica, so what it published was
  // `min(backlog, 50)` on one scrape target out of N. Two writers of one series name, disagreeing
  // about the definition of the number, is how one fact came to have several values in the estate.
  await unwatched('LTC', testUser(1))

  const published = await publishedByJob(WATCH_KIND)
  assert.equal(published.includes('wallet_deposit_addresses_unwatched'), false)
  assert.equal(published.includes('wallet_deposit_addresses_unobservable'), false)
})

/* --------------------------------------------------------------- the credit-posting backlog */

/**
 * `count` credits that were claimed and never posted, inserted directly.
 *
 * Directly, because the point is the NUMBER: driving six hundred credits through
 * `handleDepositConfirmed` against a ledger rigged to fail would be six hundred round trips for no
 * extra proof, and `deposits.test.ts` already pins that the claim-then-post ordering leaves exactly
 * this row behind. `ledger_entry_id` is left null, which is the entire definition of the backlog —
 * money on the chain, claimed by this service, and invisible to its owner.
 */
async function unposted(count: number, userId: string): Promise<void> {
  const seed = await assignDepositAddress(h.deposits, {
    userId,
    assetCode: 'EMBER',
    correlationId: 'req-credit',
  })
  await sql`
    insert into deposit_credits
      (id, user_id, assignment_id, wallet_id, chain, network, address_key, asset_code,
       amount, tx_hash, block_height, confirmations, credit_key)
    select gen_random_uuid(), ${userId}::uuid, a.id, a.wallet_id, a.chain, a.network,
           a.address_key, a.asset_code, 1000, '0xtest' || n::text, 100 + n, 12,
           'test:credit:' || n::text
      from generate_series(1, ${count}) as n
     cross join (select id, wallet_id, chain, network, address_key, asset_code
                   from deposit_address_assignments where id = ${seed.id}) as a
  `
}

test('the pending-credit reading is a count, not the length of a page', { skip }, async () => {
  await unposted(600, testUser(1))

  assert.equal(await pendingCreditCount(h.deposits.sql), 600)
  // What the scrape used to publish. `min(backlog, 500)` reports the same number for five hundred
  // unposted credits and for fifty thousand, so `DepositCreditsUnposted` fires identically on a
  // backlog that is draining and on one that is running away — and the graph an operator checks
  // next goes flat at exactly the moment it should be going vertical.
  assert.equal((await pendingCredits(h.deposits.sql, 500)).length, 500)
})

test('an empty backlog is a measured zero, not an absent series', { skip }, async () => {
  // The healthy reading has to be a real 0 rather than nothing: `DepositCreditsUnposted` is
  // `> 0`, and an absent series and a healthy one are the same shape to that rule. This is also
  // the case the index exists for — no matching row means nothing to stop early on.
  assert.equal(await pendingCreditCount(h.deposits.sql), 0)
})

test('the post-credit job does not publish the pending gauge', { skip }, async () => {
  // It wrote `pending.length`, capped at `BATCH` — 50, a TIGHTER cap than the 500 `beforeScrape`
  // applied to the same series name — from the one replica holding the lease. It was invisible only
  // because the next scrape re-sampled over it, which makes it a write that can never be read
  // rather than a write that is correct. Left in place it is the second writer that turned the
  // address gauge into one fact with several values.
  await unposted(3, testUser(1))

  const published = await publishedByJob(POST_CREDIT_KIND)
  assert.equal(published.includes('wallet_deposit_credits_pending'), false)
})
