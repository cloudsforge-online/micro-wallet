/**
 * What a scrape says about the deposit-address backlog.
 *
 * These are separated from `deposits.test.ts` because they are not about crediting; they are about
 * the one thing micro-org#310 is: whether a number the estate alerts on means what the alert
 * thinks it means. `DepositAddressFrozen` read `wallet_deposit_address_frozen`, a metric no service
 * has ever exported and a state — a frozen deposit address — that does not exist in this schema at
 * all (`deposit_address_assignments_status_ck` admits `active`, `rotated`, `retired`). The
 * condition it *described* is forge-pay's, and `deposits.ts`'s header records why it cannot happen
 * here. What remains is the backlog these tests are about, and it was being measured badly enough
 * that no honest rule could have been written on it either.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { Metrics } from '@cloudsforge/telemetry'
import { CHAIN_IDS } from './addresses.ts'
import {
  assignDepositAddress,
  sampleDepositAddressMetrics,
  unwatchedAssignments,
  unwatchedByChain,
} from './deposits.ts'
import { IndexerUnavailableError } from './indexerclient.ts'
import { indexerObservability } from './observability.ts'
import { registerServiceMetrics } from './server.ts'
import { WATCH_KIND, registerHandlers } from './jobs.ts'
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

/* --------------------------------------------------------------- the writer */

test('the watch job does not publish the backlog gauges', { skip }, async () => {
  // It saw one batch of at most 50 and it is leased to one replica, so what it published was
  // `min(backlog, 50)` on one scrape target out of N. Two writers of one series name, disagreeing
  // about the definition of the number, is how one fact came to have several values in the estate.
  await unwatched('LTC', testUser(1))

  const handlers = new Map<string, (job: never, ctx: never) => Promise<void>>()
  const runner = {
    register(kind: string, handler: (job: never, ctx: never) => Promise<void>) {
      handlers.set(kind, handler)
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

  await handlers.get(WATCH_KIND)!({} as never, {
    signal: new AbortController().signal,
    heartbeat: async () => true,
  } as never)

  // Any sample line at all, braced or bare. Asserting only on the labelled form would pass against
  // the very code this is about: the old writer passed no labels, so it published the name with an
  // empty label set — a second, unlabelled series beside the per-chain ones, which is worse than
  // either alone. `# HELP`/`# TYPE` are excluded because a registration is not a reading.
  const published = metrics
    .render()
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const brace = line.indexOf('{')
      return line.slice(0, brace === -1 ? line.indexOf(' ') : brace)
    })
  assert.equal(published.includes('wallet_deposit_addresses_unwatched'), false)
  assert.equal(published.includes('wallet_deposit_addresses_unobservable'), false)
})
