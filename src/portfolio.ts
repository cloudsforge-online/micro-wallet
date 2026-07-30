/**
 * The portfolio read: ledger balances composed with what the chain shows.
 *
 * Three rules shape this file, and the third is the one that made it smaller than expected.
 *
 * ## 1. Balances come from the ledger, every time
 *
 * There is no cache here, no projection, no "last known" column. 04-domain-model §11 forbids one
 * and names the reason: a cached balance in a product database is the bug that made Crucible's bot
 * state diverge from Pay's. If the ledger is unreachable, this endpoint says so rather than
 * serving a stale number that looks authoritative.
 *
 * ## 2. Everything unbounded is paged
 *
 * The wallet list is paged on `id`, which is UUIDv7 and therefore a total order. **The current
 * wallet returns the entire unpaginated ledger on every call** — unbounded memory on the server,
 * unbounded transfer, and slower for every user every day for ever. The balance list is *not*
 * paged, and that is deliberate rather than an oversight: it is bounded by the number of assets
 * times the number of purposes, which is a constant of the chart of accounts and not something a
 * user can grow.
 *
 * ## 3. What the indexer cannot answer, this does not invent
 *
 * The indexer's HTTP surface (`indexer/src/reads.ts`) exposes chain status, address *activity*, a
 * transaction and a block. **It exposes no balance read.** So for an `external` or `watch` wallet —
 * where the platform holds nothing and the only truth is on chain — there is no balance to fetch.
 *
 * The tempting repair is to sum the activity page. That would be wrong, and quietly:
 *
 *   * A page is a window, not a history. Netting one page gives a number that changes when the
 *     page size changes.
 *   * On an account-model chain the gas an address spends is not an `address_activity` row, so
 *     even a complete net would drift below the true balance by every fee that address has ever
 *     paid.
 *
 * So the response carries `netObserved` over the window it actually read, flagged `complete` only
 * when the whole history fitted, and `balance: null` with a machine-readable reason. A field named
 * `balance` holding a number that is not the balance is worse than no field: it will be rendered
 * as a balance by the first frontend that finds it.
 */

import { type AssetCode, type Network, chainSpec, formatAmount } from '@cloudsforge/contracts-chain'
import type { LedgerAssetCode } from '@cloudsforge/contracts-money'
import { chainForAsset } from './addresses.ts'
import type { IndexerClient } from './indexerclient.ts'
import type { LedgerBalance, LedgerClient } from './ledgerclient.ts'
import type { Db } from './outbox.ts'
import { RateUnavailableError, type PricingClient, type Quote } from './pricingclient.ts'
import { DEFAULT_PAGE_SIZE, listWallets, type WalletRecord } from './wallets.ts'

export interface PortfolioDeps {
  readonly sql: Db
  readonly network: Network
  readonly ledger: LedgerClient
  readonly indexer: IndexerClient
  readonly pricing: PricingClient
}

/** A valuation, with the instant it was observed. Never a number on its own. */
export interface Valuation {
  /** USD, scaled by `RATE_SCALE`, as a decimal string. Never a float and never a JSON number. */
  readonly usdScaled: string
  /** When the market observation was made — not when this response was assembled. */
  readonly quotedAt: string
  readonly source: string
}

export interface PortfolioBalance {
  readonly assetCode: LedgerAssetCode
  readonly purpose: string
  readonly amount: string
  readonly amountFormatted: string
  /** Null when pricing has no usable quote. A holding with no price is shown, not hidden. */
  readonly valuation: Valuation | null
}

export interface ObservedWallet {
  readonly walletId: string
  readonly origin: WalletRecord['origin']
  readonly chain: string
  readonly network: string
  readonly address: string
  readonly label: string | null
  readonly status: string
  /**
   * Always null. See the file header: the indexer exposes no balance read, and a `balance` field
   * containing something that is not the balance would be rendered as one.
   */
  readonly balance: null
  readonly balanceUnavailable: 'indexer_exposes_no_balance_read'
  /**
   * Confirmed in minus confirmed out **over the window this read actually saw**. Not a balance.
   * Useful for "has anything happened here", useless for "how much is there", and named so that
   * the difference is impossible to miss.
   */
  readonly netObserved: string
  /** True when the whole activity history fitted in the window, so `netObserved` is over all of it. */
  readonly complete: boolean
  readonly movements: number
  readonly lastActivityAt: string | null
  /** When this service asked the chain, through the indexer. */
  readonly observedAt: string
}

export interface Portfolio {
  readonly subject: string
  readonly network: Network
  /** Bounded by the chart of accounts, so returned whole. See rule 2 in the header. */
  readonly balances: readonly PortfolioBalance[]
  /** Unbounded in the user's control, so paged. */
  readonly wallets: readonly ObservedWallet[]
  readonly nextCursor: string | null
  /**
   * Which upstreams did not answer.
   *
   * Present rather than thrown, because a portfolio missing its on-chain half is still worth
   * showing and a portfolio missing its prices is still worth showing. A portfolio missing its
   * *balances* is not, and that one does throw.
   */
  readonly degraded: readonly string[]
  readonly asOf: string
}

export interface PortfolioQuery {
  readonly userId: string
  readonly limit?: number
  readonly cursor?: string
  /** How much activity to read per external wallet before giving up on completeness. */
  readonly activityWindow?: number
}

const DEFAULT_ACTIVITY_WINDOW = 200

/**
 * Compose the portfolio.
 *
 * The ledger read is awaited on its own and is allowed to fail the request. Everything after it —
 * pricing, the chain — is best-effort and degrades into `degraded[]`, because a price feed having
 * a bad minute must not make a user unable to see what they own.
 */
export async function readPortfolio(
  deps: PortfolioDeps,
  query: PortfolioQuery,
): Promise<Portfolio> {
  const subject = `user:${query.userId}`
  const degraded: string[] = []

  // No fallback. If this fails the caller gets an error, because the alternative is an empty
  // portfolio that looks exactly like a user who owns nothing.
  const balances = await deps.ledger.balances(subject)

  const page = await listWallets(deps.sql, {
    userId: query.userId,
    limit: query.limit ?? DEFAULT_PAGE_SIZE,
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    network: deps.network,
  })

  const quotes = await quoteOrDegrade(deps, balances, degraded)

  const observable = page.wallets.filter(
    // Managed wallets are deliberately excluded from the chain half. Their contents are already in
    // the ledger as a custody asset — showing them again here would let a user add the two and
    // double-count their own money.
    (wallet) => wallet.origin === 'external' || wallet.origin === 'watch',
  )
  const observed = await observeAll(deps, observable, query.activityWindow ?? DEFAULT_ACTIVITY_WINDOW, degraded)

  return {
    subject,
    network: deps.network,
    balances: balances.map((balance) => toPortfolioBalance(balance, quotes.get(balance.assetCode))),
    wallets: observed,
    nextCursor: page.nextCursor,
    degraded,
    asOf: new Date().toISOString(),
  }
}

function toPortfolioBalance(
  balance: LedgerBalance,
  quote: Quote | undefined,
): PortfolioBalance {
  const decimals = decimalsFor(balance.assetCode)
  return {
    assetCode: balance.assetCode,
    purpose: balance.purpose,
    amount: balance.amount.toString(),
    amountFormatted: decimals === null ? balance.amount.toString() : formatAmount(balance.amount, decimals),
    valuation:
      quote === undefined || decimals === null
        ? null
        : {
            // amount × rate ÷ 10^decimals, all in bigint. The division floors, which understates a
            // valuation by less than one scaled cent and never overstates it.
            usdScaled: (
              (balance.amount * quote.usdPerCoinScaled) /
              10n ** BigInt(decimals)
            ).toString(),
            quotedAt: quote.asOf,
            source: quote.source,
          },
  }
}

/**
 * Decimals for a ledger asset, or `null` when this service cannot know them.
 *
 * `TOKEN:<urn>` assets have decimals chosen at deploy time and recorded by the mint, so guessing
 * eighteen because most EVM tokens use it would display a six-decimal token a million times too
 * small. `assetDecimals` in contracts-money refuses for exactly this reason; here the refusal is
 * "show the raw integer and no valuation", which is honest rather than fatal.
 */
function decimalsFor(assetCode: LedgerAssetCode): number | null {
  if (assetCode === 'SHARD') return 0
  if (assetCode === 'USD') return 2
  const chain = chainForAsset(assetCode)
  return chain === null ? null : chainSpec(assetCode as AssetCode).decimals
}

async function quoteOrDegrade(
  deps: PortfolioDeps,
  balances: readonly LedgerBalance[],
  degraded: string[],
): Promise<ReadonlyMap<LedgerAssetCode, Quote>> {
  const priceable = [...new Set(balances.map((b) => b.assetCode))].filter(
    (asset) => chainForAsset(asset) !== null,
  )
  if (priceable.length === 0) return new Map()
  try {
    return await deps.pricing.quotes(priceable)
  } catch (err) {
    // A holding with no price is shown without one. Refusing the whole portfolio because the
    // market feed is down would be a worse answer than "we cannot value this right now".
    degraded.push(err instanceof RateUnavailableError ? 'pricing' : 'pricing')
    return new Map()
  }
}

async function observeAll(
  deps: PortfolioDeps,
  wallets: readonly WalletRecord[],
  window: number,
  degraded: string[],
): Promise<readonly ObservedWallet[]> {
  const out: ObservedWallet[] = []
  for (const wallet of wallets) {
    out.push(await observe(deps, wallet, window, degraded))
  }
  return out
}

async function observe(
  deps: PortfolioDeps,
  wallet: WalletRecord,
  window: number,
  degraded: string[],
): Promise<ObservedWallet> {
  const base = {
    walletId: wallet.id,
    origin: wallet.origin,
    chain: wallet.chain,
    network: wallet.network,
    address: wallet.address,
    label: wallet.label,
    status: wallet.status,
    balance: null,
    balanceUnavailable: 'indexer_exposes_no_balance_read',
  } as const

  try {
    const page = await deps.indexer.activity(
      wallet.chain,
      wallet.network,
      wallet.address,
      window,
      null,
    )
    let net = 0n
    let movements = 0
    let lastActivityAt: string | null = null
    for (const item of page.items) {
      // Orphaned movements are excluded: they describe a history the chain has abandoned.
      // Unconfirmed ones are excluded too — counting value that has not reached its depth is the
      // whole class of error `contracts-chain`'s confirmation policy exists to prevent.
      if (item.status !== 'included' || !item.confirmed) continue
      movements += 1
      net += item.direction === 'in' ? item.amount : -item.amount
      if (lastActivityAt === null) lastActivityAt = item.confirmedAt ?? item.firstSeenAt
    }
    return {
      ...base,
      netObserved: net.toString(),
      complete: page.nextCursor === null,
      movements,
      lastActivityAt,
      observedAt: new Date().toISOString(),
    }
  } catch {
    // One unreachable chain must not empty the whole portfolio. The wallet is still listed, its
    // observation is empty and explicitly incomplete, and `degraded` names the upstream.
    if (!degraded.includes('indexer')) degraded.push('indexer')
    return {
      ...base,
      netObserved: '0',
      complete: false,
      movements: 0,
      lastActivityAt: null,
      observedAt: new Date().toISOString(),
    }
  }
}
