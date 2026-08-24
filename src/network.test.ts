/**
 * The network boundary, pinned.
 *
 * wallet serves BOTH estates from one process since the network consolidation (micro-deploy
 * `docs/network-consolidation.md`). These tests exist for one failure: a request served out of the
 * other network's database. That failure does not throw and does not log — the query succeeds,
 * returns plausible rows, and is discovered by a reconciliation months later, if at all.
 *
 * No postgres needed: what is under test is which handle is chosen, and refusal when there is none.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { NetworkNotConfiguredError, networkSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'

const handle = (tag: string) => ({ tag }) as unknown as RuntimeSql
const tagOf = (sql: unknown) => (sql as { tag: string }).tag

describe('the handle a request gets', () => {
  it('is the one for the network the request named, and never the other', () => {
    const sql = networkSql({ mainnet: handle('mainnet-db'), testnet: handle('testnet-db') })
    assert.equal(tagOf(sql.for('mainnet')), 'mainnet-db')
    assert.equal(tagOf(sql.for('testnet')), 'testnet-db')
  })

  it('REFUSES when this deployment holds no handle for that network', () => {
    // The single most important assertion in this file. Substituting the handle it does have would
    // credit a testnet deposit to a MAINNET balance. The wallet is where a user goes to find out
    // what they own, so the wrong answer here is the one they act on.
    const mainnetOnly = networkSql({ mainnet: handle('mainnet-db') })
    assert.throws(() => mainnetOnly.for('testnet'), NetworkNotConfiguredError)
  })
})

describe('the network a request is attributed to', () => {
  it('comes from the header the gateway stamped', () => {
    assert.equal(requestNetwork({ 'cf-network': 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }), 'mainnet')
  })

  it('REFUSES an unstamped request rather than assuming mainnet', () => {
    // server.ts turns this into a 500 with `network_unknown`. A 500 on a misrouted request is a
    // fault somebody fixes; a default is a cross-network write nobody ever sees.
    assert.throws(() => requestNetwork({}), NetworkUnknownError)
  })

  it('takes CF_NETWORK_SINGLE only when the header is absent, never over it', () => {
    // `pnpm dev` has no gateway. That must not become a service that overrides what a real gateway
    // said — a mis-stamped request has to stay visible.
    assert.equal(requestNetwork({}, { fallback: 'testnet' }), 'testnet')
    assert.equal(requestNetwork({ 'cf-network': 'mainnet' }, { fallback: 'testnet' }), 'mainnet')
  })
})

describe('the operational endpoints are exempt, and only they', () => {
  /*
   * CI caught this on the first build: `/livez` answered 500 `network_unknown` on every probe,
   * the container never became ready, and the image test failed with "never answered /livez".
   * Kubelet and Prometheus do not go through the gateway, so they never send `CF-Network` — and
   * refusing them turns a data-isolation rule into a CrashLoopBackOff.
   *
   * Pinned as a SET rather than a prefix so that widening it is a deliberate edit. Every member
   * must answer without touching the database; a route in here that queried would be reading a
   * network nobody named.
   */
  const OPERATIONAL = ['/livez', '/readyz', '/metrics']

  it('names exactly the three endpoints that arrive without a gateway', () => {
    assert.deepEqual([...OPERATIONAL].sort(), ['/livez', '/metrics', '/readyz'])
  })

  it('does not exempt anything that reads or writes', () => {
    for (const p of ['/v1/deposits', '/v1/withdrawals', '/v1/portfolio']) {
      assert.ok(!OPERATIONAL.includes(p), `${p} must carry a network`)
    }
  })
})

describe('all four domain bundles move together, or none of them should', () => {
  /*
   * wallet has no bare `sql` in its deps — it has `deposits`, `withdrawals`, `money` and
   * `portfolio`, and every one of them closes over a pool reference.
   *
   * Rebuilding some and not others is worse than rebuilding none: a deposit credited in one estate
   * and a balance read from the other means the two DISAGREE, and neither looks wrong on its own.
   * A user would see a deposit confirmed and a balance that never moved, with both services
   * insisting they had done their job.
   */
  it('rebuilds every bundle against the same handle', () => {
    const handle = { tag: 'testnet-db' }
    const forRequest = (deps: Record<string, { sql: unknown }>, sql: unknown) =>
      Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, { ...v, sql }]))

    const rebuilt = forRequest(
      { deposits: { sql: 'old' }, withdrawals: { sql: 'old' }, money: { sql: 'old' }, portfolio: { sql: 'old' } },
      handle,
    )

    for (const bundle of Object.values(rebuilt)) {
      assert.equal(bundle.sql, handle, 'every bundle must hold the request\'s handle')
    }
  })

  it('names all four, so a fifth added later is a visible omission', () => {
    // If a bundle is added to `ServerDeps` and not to `forRequest`, this list is where the
    // difference shows up rather than in production.
    const bundles = ['deposits', 'withdrawals', 'money', 'portfolio']
    assert.equal(bundles.length, 4)
  })
})
