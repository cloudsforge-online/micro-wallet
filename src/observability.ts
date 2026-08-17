/**
 * **Never hand somebody an address nothing is watching.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE DEFECT THIS CLOSES, AND WHY IT IS WORSE THAN A REFUSAL
 *
 * `custody/src/hd.ts` derives a correct address for every chain the estate knows: a real BIP-84
 * Bitcoin address, a real Litecoin address under its own coin type, a real Ed25519 Solana account.
 * `POST /v1/deposits` returned them, 201, with nothing anywhere saying they were inert.
 *
 * `micro-indexer` follows ONE chain per estate. Measured on the running containers rather than
 * inferred: `cloudsforge-estate-indexer-1` carries `INDEXER_CHAINS=ember:mainnet` and
 * `cf-testnet-indexer-1` carries `ember:testnet`. Every other scope answers 200 with
 * `providers: [], indexedHeight: null` — a well-formed answer meaning "I follow no source for
 * this".
 *
 * So a user could be shown a genuine Bitcoin address, send real BTC to it, and **nothing would
 * ever observe, credit or display it.** The coins are not gone — custody holds the key and a human
 * could sweep them — but from the user's side the money vanishes with no error, no pending state
 * and no record, and from the estate's side there is nothing to reconcile against. That is worse
 * than a refusal in every direction: a refusal costs somebody a deposit they will make elsewhere,
 * and this costs them the deposit.
 *
 * ## WHY THIS ASKS INSTEAD OF ASSERTING
 *
 * The obvious repair is a list of supported chains in this repository. It is the wrong one, and the
 * estate has already paid for it once: `explorer-web` offered chains from a literal while the
 * indexer served one, which is the same disagreement pointed at a different surface. A second
 * hardcoded list is not a fix for the first; it is a second thing to forget.
 *
 * So observability is MEASURED, per deployment, from the service that would do the observing. The
 * day an operator adds a provider for BTC, deposits open with no code change, no redeploy of this
 * service and no release. The day they remove one, deposits close the same way. There is one source
 * of truth for "can this estate see that chain" and it is the indexer.
 *
 * ## WHAT IS CACHED, AND WHY IT FAILS THE WAY IT DOES
 *
 * The answer changes when an operator changes configuration — minutes or months apart — and it is
 * read on a path a user hits repeatedly, so a short TTL is right and a long one is a deployment
 * that stays wrong after it has been fixed. Sixty seconds is the compromise, stated as a
 * constructor option rather than a literal so a test can drive it.
 *
 * **An unreachable indexer does not open the gate.** It falls back to the last answer this process
 * held, however stale, and refuses with `observability_unknown` when it has none. Failing OPEN here
 * would mean an indexer outage — precisely when nothing is being observed — is the moment addresses
 * start being issued again. Failing closed costs an unavailable deposit page during an outage,
 * which is recoverable; the other direction is not.
 *
 * A negative answer is cached too. Not doing so would put an indexer round trip on every request
 * for every unsupported asset, which is a denial-of-service anyone can drive from a public route.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Network } from '@cloudsforge/contracts-chain'
import { assetOf, CHAIN_IDS, type ChainId } from './addresses.ts'
import { IndexerUnavailableError, type IndexerClient } from './indexerclient.ts'

/** Why a chain is not depositable. Distinct so a caller can answer differently. */
export type UnobservableReason =
  /** The indexer follows no source for this chain. An owner's decision, not a fault. */
  | 'not_followed'
  /** We could not ask, and have never had an answer to fall back on. */
  | 'unknown'
  /**
   * This deployment has stated no way to pay the chain's native asset back out. See
   * `payableChainsOnly` — an address we can see money arrive at and cannot send money from is a
   * promise this deployment has not made.
   *
   * ── IT USED TO SAY "the estate CAN watch the chain but…", AND THAT HALF WAS NEVER MEASURED ────
   *
   * micro-org#481. `payableChainsOnly` is the outermost gate and answers this reason **without
   * asking the indexer anything**, so the "can watch" half was an assumption the value asserted and
   * nothing checked. On the mainnet estate, measured 2026-08-17, it was false for four of the five
   * chains that receive it: `WALLET_FEE_QUOTES` opens `ember, btc, ltc`, and `INDEXER_CHAINS` is
   * `ember:mainnet, ltc:mainnet, btc:mainnet` — so DOGE, ETC, SOL and XRP were each reported as a
   * chain the estate watches and cannot pay out of, when in fact nothing watches them at all.
   *
   * That is the wrong way round for the person reading it. "We see your coin and cannot send it
   * back" invites someone to deposit and wait; "nothing here is watching that chain" tells them not
   * to send. Dogecoin is the case the owner actually hit (micro-org#481): no dogecoind is reachable
   * from this estate, `GET /v1/chains/doge/mainnet/status` answers `followed: false, providers: []`,
   * and the deposit catalogue was calling that `not_retrievable`.
   *
   * So this value now means exactly what `payableChainsOnly` knows and no more, and
   * `chainAvailability` — which the CATALOGUE uses, where a round trip is affordable — prefers
   * `not_followed` whenever the indexer says so, because that is the more fundamental fact and the
   * one that changes the advice.
   */
  | 'not_retrievable'

export interface Observation {
  readonly observable: boolean
  readonly reason: UnobservableReason | null
  /** How many sources the indexer reported. Zero on every refusal, and logged rather than shown. */
  readonly providers: number
  /** True when this answer came from the cache after the indexer could not be reached. */
  readonly stale: boolean
}

export interface ChainObservability {
  observe(chain: ChainId, network: Network): Promise<Observation>
}

export interface ObservabilityOptions {
  readonly indexer: Pick<IndexerClient, 'chainStatus'>
  /** Milliseconds. Default 60_000 — see the header on why it is neither shorter nor longer. */
  readonly ttlMs?: number | undefined
  /** Test seam. */
  readonly now?: (() => number) | undefined
}

interface Cached {
  readonly at: number
  readonly providers: number
}

export function indexerObservability(options: ObservabilityOptions): ChainObservability {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? Date.now
  const cache = new Map<string, Cached>()

  return {
    async observe(chain, network) {
      const key = `${chain}:${network}`
      const held = cache.get(key)
      if (held && now() - held.at < ttlMs) return decide(held.providers, false)

      try {
        const status = await options.indexer.chainStatus(chain, network)
        cache.set(key, { at: now(), providers: status.providers })
        return decide(status.providers, false)
      } catch (err) {
        // A REFUSAL from the indexer (a 4xx — an unknown chain, a bad scope) is not an outage and
        // is not cached: it means this chain is not one that service knows, which is `not_followed`
        // by another name. Only an unavailability falls back.
        if (!(err instanceof IndexerUnavailableError)) return decide(0, false)
        // Deliberately does NOT refresh `at`: a stale answer must keep ageing, so the fallback
        // cannot become permanent by being consulted.
        if (held) return decide(held.providers, true)
        return { observable: false, reason: 'unknown', providers: 0, stale: false }
      }
    },
  }
}

function decide(providers: number, stale: boolean): Observation {
  return providers > 0
    ? { observable: true, reason: null, providers, stale }
    : { observable: false, reason: 'not_followed', providers, stale }
}

/**
 * **Watching a chain is not the same promise as being able to pay out on it, and this service used
 * to make the second promise by accident whenever an operator made the first.**
 *
 * ── THE DEFECT, EXACTLY ───────────────────────────────────────────────────────────────────────
 *
 * Everything above decides on `providers > 0` and nothing else. So the single act of adding a
 * scope to the indexer's `INDEXER_CHAINS` opened this service's deposit route for that chain, in
 * the same instant, with no second decision anywhere. micro-org#373 §6.1 measured what that would
 * mean for Bitcoin: `micro-settlement` has a complete BTC PSBT adapter that **cannot run against
 * the estate's node** — it selects coins with `listunspent` and prices with `estimatesmartfee`,
 * and bitcoind runs `disablewallet=1 blocksonly=1`, so both answer `-32601`/`-32603`. Turning the
 * indexer on would have had this service handing out real Bitcoin addresses within one TTL, on a
 * deployment where nothing could move a satoshi off one.
 *
 * The header above argues at length that a second hardcoded list of supported chains is the wrong
 * repair, and that argument still holds and is not being reversed. This is not a list. It is the
 * OTHER half of the same question, measured the same way — from the configuration that states it.
 *
 * ── WHY THE WITHDRAWAL FEE TABLE IS THE HONEST SIGNAL ─────────────────────────────────────────
 *
 * `WALLET_FEE_QUOTES` is already this estate's written statement of "we can pay this asset out":
 * `settlement.ts`'s `staticFeeQuoter` throws for an asset absent from it and the withdrawal route
 * refuses `fee_unavailable` with a 503, deliberately, rather than pricing by guessing. It is set
 * per deployment by an operator, not by this repository, and micro-org#373 §6.3 independently
 * concludes that BTC must not appear in it until a UTXO source and a fee source exist. So the two
 * gates move together with no third variable to keep in step, and the ordering constraint that
 * document spent a section deriving is enforced instead of documented.
 *
 * The NATIVE asset of the chain, via `assetOf`, not the asset being deposited: a fee is paid in
 * the chain's own coin. An ERC-20 you cannot pay gas for is not withdrawable however many of it
 * you hold — which is the same reason this is keyed on the chain and not on the token.
 *
 * ── WHAT IT COSTS, STATED PLAINLY ─────────────────────────────────────────────────────────────
 *
 * A deployment that has never set `WALLET_FEE_QUOTES` (it defaults to `{}`) now refuses every
 * deposit, where before it accepted them. That IS the intended behaviour and not an oversight: on
 * such a deployment every withdrawal already answers 503 `fee_unavailable`, so what it had was a
 * wallet that took coins in and could not let them out. `index.ts` logs the open chains once at
 * boot so the refusal is one grep away rather than a mystery on a support call.
 *
 * The indexer is deliberately NOT asked when this gate is shut. The answer cannot change the
 * outcome, and not asking keeps an unconfigured chain off the indexer's request budget entirely.
 */
export interface PayableOptions {
  readonly observability: ChainObservability
  /** True when this deployment has stated a way to pay the chain's native asset out. */
  readonly payable: (chain: ChainId) => boolean
}

export function payableChainsOnly(options: PayableOptions): ChainObservability {
  return {
    async observe(chain, network) {
      if (!options.payable(chain)) {
        return { observable: false, reason: 'not_retrievable', providers: 0, stale: false }
      }
      return options.observability.observe(chain, network)
    },
  }
}

/**
 * **The same verdict as `payableChainsOnly`, with the reason the CATALOGUE owes a reader.**
 *
 * micro-org#481. `GET /v1/deposits/assets` and `POST /v1/deposits` are asking two different
 * questions of the same two gates, and only one of them is a gate:
 *
 *   - `POST /v1/deposits` decides whether to mint an address. It wants the cheapest sufficient
 *     refusal, and `payableChainsOnly`'s short circuit is exactly right for it — the indexer's
 *     answer cannot change the outcome, and not asking keeps an unconfigured chain off the
 *     indexer's request budget on a per-user path. **That is not changed here and must not be.**
 *   - `GET /v1/deposits/assets` DESCRIBES the estate. It is one read per chain per sixty seconds
 *     behind the same cache, it already asks the indexer about every chain the fee table opens, and
 *     its entire job is to say why an asset is not offered. A refusal it cannot explain correctly is
 *     the whole defect it exists to prevent.
 *
 * So this port asks BOTH and then applies the payable gate on top. **The gate is unchanged**: if
 * the chain is not payable, `observable` is `false` whatever the indexer said, so turning a chain on
 * in `INDEXER_CHAINS` still cannot open deposits as a side effect of a decision that was about
 * something else. The only thing that moves is which of two true sentences gets told.
 *
 * `not_followed` wins over `not_retrievable` when both apply, and that ordering is the point rather
 * than a tie-break: they lead to different advice. `not_retrievable` says an operator has a fee to
 * quote; `not_followed` says there is no node, and no fee quote in the world would help. Dogecoin on
 * the mainnet estate is the second, and was being reported as the first.
 *
 * An `unknown` from the indexer — it could not be asked — does NOT survive the gate, because the
 * payable half is a certainty on its own and `unknown` reads as "try again shortly", which is advice
 * for a chain that is one outage away from working rather than one this deployment has closed.
 */
export function chainAvailability(options: PayableOptions): ChainObservability {
  return {
    async observe(chain, network) {
      const observed = await options.observability.observe(chain, network)
      if (options.payable(chain)) return observed
      return {
        ...observed,
        observable: false,
        reason: observed.reason === 'not_followed' ? 'not_followed' : 'not_retrievable',
      }
    },
  }
}

/**
 * Why an asset is not on offer, as a sentence rather than as a word.
 *
 * ── A CONSUMER THAT KNOWS ONLY `depositable: false` RENDERS NOTHING AT ALL ─────────────────────
 *
 * micro-org#481, reported as "I don't see any Dogecoin reference in the wallet". `micro-wallet` was
 * already answering honestly — `GET /v1/deposits/assets` carried a DOGE row with `depositable:
 * false` — and the surface reading it dropped every refused row before drawing, so the one place the
 * estate said anything about Dogecoin never reached a screen. A machine-readable enum a client has
 * to write its own prose for is prose the client will not write.
 *
 * This is `pool/src/chains.ts`'s rule, and it argues it against exactly the same mistake: *"a bare
 * boolean was the first shape and it was wrong … a consumer that knows only 'false' renders
 * 'unavailable', which reads as an outage the operator will fix, and the reader waits for something
 * that is never going to change."* `micro-pool-web` renders that reason verbatim; this gives a
 * wallet surface the same thing to render.
 *
 * The sentences are shared with `assertObservable`, which raises them as the `DepositError` message
 * on `POST /v1/deposits`, so the list and the refusal cannot drift into saying different things
 * about one asset — which is the failure a second copy of a sentence always eventually produces.
 */
export function unobservableDetail(assetCode: string, reason: UnobservableReason): string {
  switch (reason) {
    case 'not_retrievable':
      // Deliberately does not name WHICH chains this deployment can pay out on: that is an
      // operational fact and belongs in the log line, not on a public catalogue.
      return (
        `${assetCode} deposits are not available on this deployment yet. This estate cannot send ` +
        `${assetCode} back out, and it will not take a deposit it could not return — which is why ` +
        'no address has been issued.'
      )
    case 'unknown':
      return (
        `we could not confirm that ${assetCode} deposits are being watched right now, so no address ` +
        'has been issued. Nothing is wrong with your account — please try again shortly.'
      )
    case 'not_followed':
      return (
        `${assetCode} deposits are not available on this deployment yet. An address would be real ` +
        'and nothing would be watching it, so anything sent to it would not be credited — which is ' +
        'why none has been issued.'
      )
  }
}

/**
 * The `payable` predicate built from the fee table, and the list it opens.
 *
 * Returns the list as well as the predicate because `index.ts` logs it at boot: a gate whose state
 * is only visible by provoking a refusal is a gate nobody checks until a user complains.
 */
export function payableFromFeeQuotes(feeQuotes: Readonly<Record<string, bigint>>): {
  readonly payable: (chain: ChainId) => boolean
  readonly chains: readonly ChainId[]
} {
  const open = new Set<ChainId>(CHAIN_IDS.filter((chain) => feeQuotes[assetOf(chain)] !== undefined))
  return {
    payable: (chain) => open.has(chain),
    chains: Object.freeze(CHAIN_IDS.filter((chain) => open.has(chain))),
  }
}
