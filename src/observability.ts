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
import type { ChainId } from './addresses.ts'
import { IndexerUnavailableError, type IndexerClient } from './indexerclient.ts'

/** Why a chain is not depositable. Distinct so a caller can answer differently. */
export type UnobservableReason =
  /** The indexer follows no source for this chain. An owner's decision, not a fault. */
  | 'not_followed'
  /** We could not ask, and have never had an answer to fall back on. */
  | 'unknown'

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
