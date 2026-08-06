/**
 * Pricing, as this service uses it.
 *
 * Two things this client insists on, and both are lessons from `forge-pay/src/pricing.ts`:
 *
 *   1. **A rate carries the instant it was observed.** A number with no timestamp cannot be shown
 *      to a user honestly and cannot be refused when it goes stale. Every quote in the portfolio
 *      renders its own `asOf`, because "your portfolio is worth £X" with no time attached is a
 *      claim about now that is actually a claim about whenever the cache was last warm.
 *   2. **A rate that cannot be quoted is an error, never a default.** forge-pay refuses a
 *      conversion with 503 `rate_unavailable` rather than guessing, and so does this. A fallback
 *      rate is a rate at which somebody trades.
 *
 * The rate itself is a **scaled integer**, `RATE_SCALE` (10^6) USD per whole coin, and never a
 * float. `contracts-chain`'s header states why: "A float rate applied to an 18-decimal amount
 * loses precision in the least significant digits, which is exactly where a reconciliation drift
 * shows up."
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call pricing.
 *
 * `pricing:read` is registered and pricing enforces it (`pricing/src/server.ts,492`) — but the
 * one route this client calls, `GET /rates` (`pricing/src/server.ts`), is not gated at all:
 * the board is public. So this grant is currently WIDER than the call sites need, and it is kept
 * deliberately rather than emptied, for a reason that belongs to the derivation and not to this
 * service: `derive-grants.mjs` treats a module that presents a credential and declares NO scope
 * as an undeclared gap and fails the estate build unless `micro-deploy` carries a hand-written
 * entry for the file. An empty array and a forgotten declaration were the same input, so the
 * honest answer was unsayable and this service over-declared instead.
 *
 * **Half of that is now fixed, and this line is waiting on the other half.**
 * `@cloudsforge/contracts-auth` exports `NO_SCOPES_REQUIRED` — a named empty constant that makes
 * "nothing" a statement rather than an absence. What is still missing is the reader:
 * `derive-grants.mjs` matches `= Object.freeze(` and would see `= NO_SCOPES_REQUIRED` as no
 * declaration at all, so switching this line TODAY fails the estate build. The order is
 * micro-deploy first, then this. Narrow it to `NO_SCOPES_REQUIRED` once that branch has landed —
 * an over-declaration is a real grant on a real token, and AD-05 says a token carries the least
 * it can.
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `custodyclient.ts`.
 */
export const PRICING_SCOPES: readonly LiveScope[] = Object.freeze(['pricing:read'])

/** No usable price. A conversion refuses; a portfolio renders the holding without a value. */
export class RateUnavailableError extends Error {
  readonly assetCode: string
  constructor(assetCode: string, message: string) {
    super(message)
    this.name = 'RateUnavailableError'
    this.assetCode = assetCode
  }
}

export interface Quote {
  readonly assetCode: LedgerAssetCode
  /** USD per whole coin, scaled by `RATE_SCALE`. Never a float. */
  readonly usdPerCoinScaled: bigint
  /** When the underlying market observation was made — not when this response was built. */
  readonly asOf: string
  readonly source: string
}

export interface PricingClient {
  /**
   * Quotes for a set of assets.
   *
   * A map rather than a list, and an asset absent from it means "no usable price" rather than
   * zero. A zero would be a valuation, and a valuation of zero is a lie about a holding that
   * exists.
   */
  quotes(assets: readonly LedgerAssetCode[]): Promise<ReadonlyMap<LedgerAssetCode, Quote>>
}

export interface PricingClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpPricingClient(options: PricingClientOptions): PricingClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'pricing',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async quotes(assets) {
      if (assets.length === 0) return new Map()
      try {
        // `GET /rates`, not `/v1/quotes`. The latter never existed — this client was written
        // against an imagined surface and would have 404'd in production. Found by micro-hub-api
        // reading both services' route tables side by side, which is exactly the class of defect
        // consumer-driven contract tests exist to catch before a deploy does.
        //
        // The board is returned whole rather than filtered by asset: it is a small, fixed set,
        // it is the same response every caller gets so it caches once, and asking for a subset
        // would let the board silently forget an asset exists.
        const body = await client.get<{ rates: readonly RawRate[] }>('/rates')
        const wanted = new Set<string>(assets)
        const out = new Map<LedgerAssetCode, Quote>()
        for (const rate of body.rates) {
          if (!wanted.has(rate.asset)) continue
          // An unusable rate is skipped rather than defaulted. Pricing answers 200 with a reason
          // instead of a 404, because the asset does exist — it is the price that is missing, and
          // valuing a holding at a stale or absent rate is worse than declining to value it.
          if (!rate.usable) continue
          out.set(rate.asset as LedgerAssetCode, {
            assetCode: rate.asset as LedgerAssetCode,
            usdPerCoinScaled: BigInt(rate.usdScaled),
            asOf: rate.quotedAt,
            source: rate.source,
          })
        }
        return out
      } catch (err) {
        if (err instanceof HttpError && err.peerDecided) {
          throw new RateUnavailableError('*', err.message)
        }
        // A pricing outage must not take the portfolio down with it: the balances are the
        // important half and they come from the ledger. The caller decides, so this propagates
        // as the same error type and `portfolio.ts` renders unvalued holdings.
        throw new RateUnavailableError('*', err instanceof Error ? err.message : String(err))
      }
    },
  }
}

/**
 * One row of pricing's `GET /rates` board, as pricing actually serves it.
 *
 * `usable` is the field that matters. Pricing answers 200 for an asset whose rate is stale,
 * absent or below the smallest quotable unit, carrying the reason — a 404 would be a lie about
 * the asset existing, and a 503 would suggest that retrying helps when a refresh is what is
 * needed. So the caller must read `usable` and not merely the presence of a number.
 */
interface RawRate {
  readonly asset: string
  readonly usable: boolean
  readonly usdScaled: string
  readonly quotedAt: string
  readonly source: string
}
