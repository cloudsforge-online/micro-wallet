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

export const PRICING_SCOPES: readonly string[] = Object.freeze(['pricing:read'])

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
        const body = await client.get<{ quotes: readonly RawQuote[] }>(
          `/v1/quotes?assets=${encodeURIComponent(assets.join(','))}`,
        )
        const out = new Map<LedgerAssetCode, Quote>()
        for (const raw of body.quotes) {
          // A quote with no rate is skipped rather than defaulted. See the header.
          if (raw.usdPerCoinScaled === null) continue
          out.set(raw.assetCode, {
            assetCode: raw.assetCode,
            usdPerCoinScaled: BigInt(raw.usdPerCoinScaled),
            asOf: raw.asOf,
            source: raw.source,
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

interface RawQuote {
  readonly assetCode: LedgerAssetCode
  readonly usdPerCoinScaled: string | null
  readonly asOf: string
  readonly source: string
}
