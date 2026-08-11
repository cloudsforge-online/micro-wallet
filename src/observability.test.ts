/**
 * **A deposit address for a chain nothing watches is money that disappears without an error.**
 *
 * The estate shipped exactly that: `custody/src/hd.ts` derives a correct BIP-84 Bitcoin address, a
 * correct Litecoin address under its own coin type and a correct Solana account, while
 * `micro-indexer` follows ONE chain per deployment (`INDEXER_CHAINS=ember:mainnet`, measured on the
 * running container). `POST /v1/deposits` answered 201 with the address and said nothing.
 *
 * Every case here is written against the shape the indexer really answers with — 200 and
 * `providers: []` for a chain it does not follow, which is an ANSWER rather than an error, and the
 * reason a naive "did the call succeed" check would have passed.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IndexerRefusedError, IndexerUnavailableError, type ChainStatus } from './indexerclient.ts'
import {
  indexerObservability,
  payableChainsOnly,
  payableFromFeeQuotes,
} from './observability.ts'

function stub(options: {
  readonly providers?: number
  readonly throws?: Error
  readonly onCall?: () => void
}) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    chainStatus: async (chain: 'ember' | 'btc' | 'eth', network: 'mainnet' | 'testnet'): Promise<ChainStatus> => {
      calls += 1
      options.onCall?.()
      if (options.throws) throw options.throws
      return {
        chain,
        network,
        providers: options.providers ?? 0,
        indexedHeight: null,
        halted: false,
      }
    },
  }
}

describe('what this estate can actually see', () => {
  it('calls a chain with a provider observable', async () => {
    const indexer = stub({ providers: 1 })
    const observed = await indexerObservability({ indexer }).observe('ember', 'mainnet')
    assert.deepEqual(observed, { observable: true, reason: null, providers: 1, stale: false })
  })

  /**
   * The whole defect, in one assertion. The indexer answers 200 — the chain is known, the asset is
   * known, the confirmation depth is known — and follows no source for it.
   */
  it('calls a chain the indexer answers 200 for but follows no source for UNobservable', async () => {
    const indexer = stub({ providers: 0 })
    const observed = await indexerObservability({ indexer }).observe('btc', 'mainnet')
    assert.equal(observed.observable, false)
    assert.equal(observed.reason, 'not_followed')
  })

  /**
   * `providers`, not `indexedHeight`. A chain configured a minute ago has no indexed height yet, and
   * refusing on that would make every newly-added chain unusable until its first block landed — so
   * the owner's fix would look like it had not worked.
   */
  it('does not require the chain to have caught up before deposits open', async () => {
    const indexer = {
      chainStatus: async (): Promise<ChainStatus> => ({
        chain: 'btc',
        network: 'mainnet',
        providers: 2,
        indexedHeight: null,
        halted: false,
      }),
    }
    assert.equal((await indexerObservability({ indexer }).observe('btc', 'mainnet')).observable, true)
  })

  it('asks once per TTL rather than once per request', async () => {
    let clock = 0
    const indexer = stub({ providers: 1 })
    const gate = indexerObservability({ indexer, ttlMs: 60_000, now: () => clock })

    await gate.observe('ember', 'mainnet')
    await gate.observe('ember', 'mainnet')
    assert.equal(indexer.calls, 1, 'a deposit page must not be an indexer round trip per render')

    clock = 60_001
    await gate.observe('ember', 'mainnet')
    assert.equal(indexer.calls, 2, 'and an operator adding a provider must not need a redeploy')
  })

  it('caches the refusal too, so an unsupported asset cannot be used to hammer the indexer', async () => {
    const indexer = stub({ providers: 0 })
    const gate = indexerObservability({ indexer, ttlMs: 60_000, now: () => 0 })
    for (let i = 0; i < 10; i++) await gate.observe('btc', 'mainnet')
    assert.equal(indexer.calls, 1)
  })

  /**
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **AN UNREACHABLE INDEXER MUST NOT OPEN THE GATE.**
   *
   * Failing open would mean an indexer outage — the moment when, by definition, nothing is being
   * observed — is the moment addresses start being handed out again. That is the defect back, timed
   * to the worst possible minute. Failing closed costs an unavailable deposit page, which is
   * recoverable; the other direction is not.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  it('refuses, and says it does not know, when the indexer cannot be reached at all', async () => {
    const indexer = stub({ throws: new IndexerUnavailableError('ECONNREFUSED') })
    const observed = await indexerObservability({ indexer }).observe('ember', 'mainnet')
    assert.equal(observed.observable, false)
    // A different fact from `not_followed`, and separated on the wire: "try again later" is advice
    // for this one and a lie for the other.
    assert.equal(observed.reason, 'unknown')
  })

  it('falls back to the last answer it held, and keeps that answer ageing', async () => {
    let clock = 0
    let down = false
    const indexer = {
      calls: 0,
      chainStatus: async (): Promise<ChainStatus> => {
        if (down) throw new IndexerUnavailableError('ECONNREFUSED')
        return { chain: 'ember', network: 'mainnet', providers: 1, indexedHeight: 10, halted: false }
      },
    }
    const gate = indexerObservability({ indexer, ttlMs: 1_000, now: () => clock })

    assert.equal((await gate.observe('ember', 'mainnet')).observable, true)
    down = true
    clock = 5_000
    const stale = await gate.observe('ember', 'mainnet')
    assert.equal(stale.observable, true, 'an EMBER deposit must survive an indexer blip')
    assert.equal(stale.stale, true, 'and must say that is what it is')

    // The fallback does NOT refresh the cache timestamp, so consulting it cannot make it permanent:
    // the next call goes back to the indexer rather than serving the same stale answer for ever.
    assert.equal((await gate.observe('ember', 'mainnet')).stale, true)
  })

  /**
   * A REFUSAL is not an outage. A 4xx from the indexer means it has looked at the scope and said no
   * — an unknown chain — which is `not_followed` under another name, and falling back to a cached
   * "yes" for it would be reading an outage into a definite answer.
   */
  it('treats a refusal as a definite no rather than as an outage', async () => {
    const indexer = stub({ throws: new IndexerRefusedError('unknown_chain', 'no such chain: doge') })
    const observed = await indexerObservability({ indexer }).observe('btc', 'mainnet')
    assert.equal(observed.observable, false)
    assert.equal(observed.reason, 'not_followed')
  })

  it('answers per network, because one estate follows mainnet and the other testnet', async () => {
    const followed = new Map([['ember:mainnet', 1]])
    const indexer = {
      chainStatus: async (chain: string, network: string): Promise<ChainStatus> => ({
        chain: chain as ChainStatus['chain'],
        network: network as ChainStatus['network'],
        providers: followed.get(`${chain}:${network}`) ?? 0,
        indexedHeight: null,
        halted: false,
      }),
    }
    const gate = indexerObservability({ indexer, ttlMs: 60_000, now: () => 0 })
    assert.equal((await gate.observe('ember', 'mainnet')).observable, true)
    assert.equal((await gate.observe('ember', 'testnet')).observable, false)
  })
})

/**
 * **The other half of the same question, and the estate only ever asked one half.**
 *
 * micro-org#373 §6.1: everything above decides on `providers > 0`, so adding a scope to the
 * indexer's `INDEXER_CHAINS` opened this service's deposit route in the same instant, with no
 * second decision anywhere. For Bitcoin that would have meant handing out real addresses within
 * one TTL on a deployment where `micro-settlement` cannot move a satoshi — its adapter needs
 * `listunspent` and `estimatesmartfee`, and bitcoind runs `disablewallet=1 blocksonly=1`.
 *
 * The case that matters is the FIRST one: indexer says yes, gate still says no. A suite that only
 * checked "no fee quote and no provider is refused" would pass against no gate at all.
 */
describe('a deposit is refused for a chain this estate cannot pay back out of', () => {
  const following = (...chains: readonly string[]) => ({
    chainStatus: async (chain: string, network: string): Promise<ChainStatus> => ({
      chain: chain as ChainStatus['chain'],
      network: network as ChainStatus['network'],
      providers: chains.includes(chain) ? 1 : 0,
      indexedHeight: null,
      halted: false,
    }),
  })

  it('refuses a chain the indexer follows PERFECTLY WELL when no fee is quoted for its coin', async () => {
    const gate = payableChainsOnly({
      observability: indexerObservability({ indexer: following('btc', 'ember') }),
      payable: payableFromFeeQuotes({ EMBER: 21_000_000_000_000n }).payable,
    })
    const btc = await gate.observe('btc', 'mainnet')
    assert.equal(btc.observable, false, 'BTC is indexed here and still must not be depositable')
    assert.equal(btc.reason, 'not_retrievable')
    // Distinct from `not_followed` on the wire, because the repair is a different one entirely:
    // this is a WALLET_FEE_QUOTES entry, not a node.
    assert.notEqual(btc.reason, 'not_followed')
    assert.equal((await gate.observe('ember', 'mainnet')).observable, true)
  })

  it('does not ask the indexer at all about a chain it would refuse anyway', async () => {
    const asked: string[] = []
    const gate = payableChainsOnly({
      observability: {
        async observe(chain, network) {
          asked.push(chain)
          return { observable: true, reason: null, providers: 1, stale: false }
        },
      },
      payable: payableFromFeeQuotes({ LTC: 10_000n }).payable,
    })
    assert.equal((await gate.observe('btc', 'mainnet')).observable, false)
    assert.deepEqual(asked, [], 'a chain with no fee quote must not cost an indexer round trip')
    assert.equal((await gate.observe('ltc', 'mainnet')).observable, true)
    assert.deepEqual(asked, ['ltc'])
  })

  it('still refuses a payable chain the indexer does not follow — the gate is an AND', async () => {
    const gate = payableChainsOnly({
      observability: indexerObservability({ indexer: following('ember') }),
      payable: payableFromFeeQuotes({ EMBER: 1n, LTC: 10_000n }).payable,
    })
    const ltc = await gate.observe('ltc', 'mainnet')
    assert.equal(ltc.observable, false)
    assert.equal(ltc.reason, 'not_followed')
  })

  /*
   * The fee is paid in the chain's OWN coin, so the table is read at the native asset of the chain
   * and never at the asset being deposited. Keyed the other way, a deployment quoting a fee for
   * some token would have opened its whole chain.
   */
  it('reads the fee table at the chain native asset, and the mainnet table opens exactly three chains', () => {
    const { chains, payable } = payableFromFeeQuotes({
      EMBER: 21_000_000_000_000n,
      LTC: 10_000n,
      BTC: 3_000n,
    })
    // `CHAIN_IDS` order, not the table's — the open-chain list is derived by filtering the canonical
    // chain list, so it does not inherit whatever order somebody wrote the JSON keys in.
    assert.deepEqual([...chains], ['ember', 'btc', 'ltc'], 'the live mainnet WALLET_FEE_QUOTES, verbatim')
    assert.equal(payable('ember'), true)
    assert.equal(payable('ltc'), true)
    // BTC joined on 2026-08-11, and only after settlement could pay one out: an endpoint in
    // `SETTLEMENT_RPC_URLS`, a UTXO source that needs no wallet RPC, a fee derived from confirmed
    // blocks, and a provisioned treasury. DOGE has none of that and is still closed.
    assert.equal(payable('btc'), true)
    assert.equal(payable('doge'), false)
  })

  /*
   * `WALLET_FEE_QUOTES` defaults to `{}`, and on such a deployment every withdrawal already answers
   * 503 `fee_unavailable`. Closing deposits there is the intended consequence and not an oversight:
   * what it had was a wallet that took coins in and could not let them out. Asserted so that a
   * later "surely this should default open" is a red test rather than a quiet reversal.
   */
  it('takes nothing in when the deployment has stated no way to pay anything out', async () => {
    const { chains, payable } = payableFromFeeQuotes({})
    assert.deepEqual([...chains], [])
    const gate = payableChainsOnly({
      observability: indexerObservability({ indexer: following('ember', 'btc', 'ltc') }),
      payable,
    })
    for (const chain of ['ember', 'btc', 'ltc'] as const) {
      const answer = await gate.observe(chain, 'mainnet')
      assert.equal(answer.observable, false, `${chain} must be refused`)
      assert.equal(answer.reason, 'not_retrievable')
    }
  })
})
