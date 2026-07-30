/**
 * Conversions, transfers and spends.
 *
 * All three are the same thing — a journal entry in the ledger — and all three **require an
 * idempotency key**. That last word is the reason this file exists as a unit rather than as three
 * routes: in forge-pay, `/coins/convert` and `/coins/convert-to-ember` require a key and `/spend`
 * does not. `/spend`'s own comment says "Send an `Idempotency-Key` header to make a retry safe;
 * without one a retry debits twice", and then it proceeds without one. It is called by games on
 * every action, over mobile networks, by clients that retry on timeout: the most-retried money
 * route in the estate is the only one that will silently do the work again. `requireIdempotencyKey`
 * closes it, `server.test.ts` asserts the 400, and there is no route in this service that accepts
 * a missing key.
 *
 * ## No arithmetic on a balance happens here
 *
 * This service never reads a balance, decides an amount is affordable, and then writes. It hands
 * the ledger a balanced entry and the ledger refuses it if the resulting liability would go
 * negative — a check that happens inside the same transaction as the postings, against the real
 * account, with a real lock. A read-then-write here would be a TOCTOU on money: two spends of the
 * last Shard both read "one Shard" and both succeed.
 *
 * ## Why a conversion has four postings and not two
 *
 * `balanceEntry` in contracts-money requires Σ debits = Σ credits **per asset**, and its header
 * explains why it cannot be per entry: "an entry may legitimately touch two assets — a conversion
 * debits a user's EMBER and credits their Shards in one atomic entry, and those two totals have no
 * arithmetic relationship whatsoever." So each asset needs its own counter-account, and a
 * conversion is two balanced pairs in one entry.
 *
 * The counter-account is `clearing`. Two reasons, and the second is the useful one:
 *
 *   * A `clearing` account is the one kind permitted to sit either side of zero — `wouldOverdraw`
 *     returns false for the type outright — which it must be, because issuing Shards against a
 *     received coin drives the Shard side negative by construction.
 *   * "It nets to zero over a settled period, which is what makes a non-zero clearing balance the
 *     first thing reconciliation looks at." For conversions that is exactly the right alarm: the
 *     clearing EMBER balance is coin the platform has taken in exchange for Shards and not yet
 *     moved to treasury, and the clearing SHARD balance is Shards issued against it. If those two
 *     stop corresponding, something is minting.
 *
 * That last point is the live defect this shape fixes. forge-pay's `convertCoinToEmber` "credits
 * custodial EMBER with no on-chain movement at all" — a liability minted against nothing, with no
 * counter-account and therefore nothing that could ever notice.
 */

import {
  RATE_SCALE,
  type Actor,
  type LedgerAssetCode,
  moneyForShards,
  shardsForMoney,
} from '@cloudsforge/contracts-money'
import { type AssetCode, chainSpec, formatAmount } from '@cloudsforge/contracts-chain'
import { chainForAsset } from './addresses.ts'
import {
  namespacedKey,
  peekIdempotency,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import type { LedgerClient, PostingRequest } from './ledgerclient.ts'
import type { Db } from './outbox.ts'
import { RateUnavailableError, type PricingClient } from './pricingclient.ts'

export const SPEND_ROUTE = 'POST /v1/spend'
export const TRANSFER_ROUTE = 'POST /v1/transfers'
export const CONVERT_ROUTE = 'POST /v1/conversions'

export class MoneyError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'MoneyError'
    this.code = code
    this.status = status
  }
}

export interface MoneyDeps {
  readonly sql: Db
  readonly producer: string
  readonly ledger: LedgerClient
  readonly pricing: PricingClient
}

/** The user's own spendable account for an asset. Every path in this file starts or ends here. */
function userAvailable(userId: string, assetCode: LedgerAssetCode) {
  return {
    subject: `user:${userId}`,
    assetCode,
    purpose: 'available',
    type: 'liability',
  } as const
}

function clearing(assetCode: LedgerAssetCode) {
  return { subject: 'clearing', assetCode, purpose: 'available', type: 'clearing' } as const
}

/* ------------------------------------------------------------------ spend */

export interface SpendInput {
  readonly userId: string
  readonly amount: bigint
  readonly reason: string
  readonly clientKey: string
  readonly correlationId: string
  readonly actor: Actor
}

export interface MoneyResult {
  readonly entryId: string
  readonly replayed: boolean
  readonly summary: Record<string, unknown>
}

/**
 * Debit Shards for something the platform provided.
 *
 * `purchase` rather than `fee_charged`: the user received a thing. The counter-account is platform
 * revenue, so "how much did this product earn" is a query over the journal rather than a number
 * nobody can derive — 00-current-state records that `ledger.source` is populated only by the
 * `/internal/*` routes today, so per-product revenue is not derivable from the estate at all.
 */
export async function spend(deps: MoneyDeps, input: SpendInput): Promise<MoneyResult> {
  if (input.amount <= 0n) throw new MoneyError('invalid_amount', 'amount must be positive')
  if (input.reason.trim().length === 0) {
    throw new MoneyError('invalid_reason', 'reason must not be empty')
  }

  const postings: readonly PostingRequest[] = [
    {
      direction: 'debit',
      amount: input.amount,
      assetCode: 'SHARD',
      sequence: 0,
      account: userAvailable(input.userId, 'SHARD'),
    },
    {
      direction: 'credit',
      amount: input.amount,
      assetCode: 'SHARD',
      sequence: 1,
      account: { subject: 'platform', assetCode: 'SHARD', purpose: 'fees', type: 'revenue' },
    },
  ]

  return run(deps, {
    route: SPEND_ROUTE,
    userId: input.userId,
    clientKey: input.clientKey,
    requestHash: requestFingerprint({ amount: input.amount, reason: input.reason }),
    kind: 'purchase',
    actor: input.actor,
    description: `Spend: ${input.reason}`.slice(0, 200),
    metadata: { reason: input.reason, assetCode: 'SHARD', amount: input.amount.toString() },
    postings,
    summary: () => ({
      assetCode: 'SHARD',
      amount: input.amount.toString(),
      reason: input.reason,
    }),
  })
}

/* ------------------------------------------------------------------ transfer */

export interface TransferInput {
  readonly userId: string
  readonly toUserId: string
  readonly assetCode: string
  readonly amount: bigint
  readonly clientKey: string
  readonly correlationId: string
  readonly actor: Actor
}

/**
 * Move value between two users.
 *
 * One entry, two postings, one asset: the sender's liability falls and the recipient's rises by
 * the same number, so the entry balances and no intermediate account is needed. Both accounts are
 * liabilities, so the direction is the same as any other movement between accounts of one type —
 * `movePostings` in contracts-money is this shape, and it exists so a transfer, an escrow step and
 * a treasury move cannot each get the direction wrong separately.
 */
export async function transfer(deps: MoneyDeps, input: TransferInput): Promise<MoneyResult> {
  if (input.amount <= 0n) throw new MoneyError('invalid_amount', 'amount must be positive')
  if (input.userId === input.toUserId) {
    throw new MoneyError('same_subject', 'a transfer needs two different users', 422)
  }
  const assetCode = input.assetCode.toUpperCase() as LedgerAssetCode

  return run(deps, {
    route: TRANSFER_ROUTE,
    userId: input.userId,
    clientKey: input.clientKey,
    requestHash: requestFingerprint({
      toUserId: input.toUserId,
      assetCode,
      amount: input.amount,
    }),
    kind: 'transfer',
    actor: input.actor,
    description: `Transfer to ${input.toUserId}`,
    metadata: { toUserId: input.toUserId, assetCode, amount: input.amount.toString() },
    postings: [
      {
        direction: 'debit',
        amount: input.amount,
        assetCode,
        sequence: 0,
        account: userAvailable(input.userId, assetCode),
      },
      {
        direction: 'credit',
        amount: input.amount,
        assetCode,
        sequence: 1,
        account: userAvailable(input.toUserId, assetCode),
      },
    ],
    summary: () => ({
      assetCode,
      amount: input.amount.toString(),
      toUserId: input.toUserId,
    }),
  })
}

/* ------------------------------------------------------------------ conversion */

export interface ConvertInput {
  readonly userId: string
  readonly fromAssetCode: string
  readonly toAssetCode: string
  /** Smallest units of `fromAssetCode`. */
  readonly amount: bigint
  readonly clientKey: string
  readonly correlationId: string
  readonly actor: Actor
}

/**
 * Convert one asset into another at a quoted rate.
 *
 * The rate comes from pricing and is a **scaled integer**, never a float — `RATE_SCALE` USD per
 * whole coin. Every rounding decision is delegated to `contracts-chain` through
 * `shardsForMoney` / `moneyForShards`, which round **down, always**. Its header states the reason
 * and it is not symmetric: "Rounding a credit up mints Shards that no coin backs; over enough
 * conversions that is a growing, invisible liability. Rounding down leaves dust in the user's
 * favour on the coin side, which reconciliation can see."
 *
 * A conversion whose output rounds to zero is refused rather than performed. Taking the input and
 * crediting nothing is not a rounding error, it is a confiscation.
 */
export async function convert(deps: MoneyDeps, input: ConvertInput): Promise<MoneyResult> {
  if (input.amount <= 0n) throw new MoneyError('invalid_amount', 'amount must be positive')
  const from = input.fromAssetCode.toUpperCase()
  const to = input.toAssetCode.toUpperCase()
  if (from === to) {
    throw new MoneyError('same_asset', `${from} cannot be converted into itself`, 422)
  }
  if (!isConvertible(from) || !isConvertible(to)) {
    throw new MoneyError(
      'not_convertible',
      'conversions are supported between SHARD and the chain assets only',
      422,
    )
  }

  // **Before pricing, not after.** A retry must return the conversion that already happened, not
  // build a new one out of a moved market — see `peekIdempotency` for the failure this avoids.
  const requestHash = requestFingerprint({ from, to, amount: input.amount })
  const replay = await peekIdempotency<MoneyResult>(
    deps.sql,
    input.userId,
    CONVERT_ROUTE,
    input.clientKey,
    requestHash,
  )
  if (replay) return { ...replay.result, replayed: true }

  const output = await priceConversion(deps, from, to, input.amount)
  if (output.amount <= 0n) {
    throw new MoneyError(
      'amount_too_small',
      `that amount of ${from} converts to less than one unit of ${to}`,
      422,
    )
  }

  const fromAsset = from as LedgerAssetCode
  const toAsset = to as LedgerAssetCode

  return run(deps, {
    route: CONVERT_ROUTE,
    userId: input.userId,
    clientKey: input.clientKey,
    // Deliberately excludes the rate. The same key with the same assets and the same input amount
    // is a retry, even if the market has moved between the two attempts — and answering a retry
    // with a second conversion at a new rate is how one user action becomes two trades.
    requestHash,
    kind: 'conversion',
    actor: input.actor,
    description: `Convert ${from} to ${to}`,
    metadata: {
      fromAssetCode: from,
      toAssetCode: to,
      fromAmount: input.amount.toString(),
      toAmount: output.amount.toString(),
      rateScale: RATE_SCALE.toString(),
      quotedAt: output.quotedAt,
    },
    postings: [
      // The input asset: out of the user, into clearing.
      {
        direction: 'debit',
        amount: input.amount,
        assetCode: fromAsset,
        sequence: 0,
        account: userAvailable(input.userId, fromAsset),
      },
      {
        direction: 'credit',
        amount: input.amount,
        assetCode: fromAsset,
        sequence: 1,
        account: clearing(fromAsset),
      },
      // The output asset: out of clearing, into the user. A separate balanced pair, because the
      // two assets have no arithmetic relationship — see the file header.
      {
        direction: 'debit',
        amount: output.amount,
        assetCode: toAsset,
        sequence: 2,
        account: clearing(toAsset),
      },
      {
        direction: 'credit',
        amount: output.amount,
        assetCode: toAsset,
        sequence: 3,
        account: userAvailable(input.userId, toAsset),
      },
    ],
    summary: () => ({
      fromAssetCode: from,
      fromAmount: input.amount.toString(),
      fromAmountFormatted: formatDisplay(from, input.amount),
      toAssetCode: to,
      toAmount: output.amount.toString(),
      toAmountFormatted: formatDisplay(to, output.amount),
      quotedAt: output.quotedAt,
    }),
  })
}

function isConvertible(assetCode: string): boolean {
  return assetCode === 'SHARD' || chainForAsset(assetCode) !== null
}

function formatDisplay(assetCode: string, amount: bigint): string {
  if (assetCode === 'SHARD') return amount.toString()
  return formatAmount(amount, chainSpec(assetCode as AssetCode).decimals)
}

/**
 * What `amount` of `from` is worth in `to`.
 *
 * Coin to coin goes through USD in two steps rather than through a composed rate, because the
 * composition would have to be done in floating point or with a second scale factor, and both
 * reintroduce exactly the precision loss `RATE_SCALE` exists to avoid. Two floors instead of one
 * costs the user a sub-unit of dust and costs the platform nothing it cannot see.
 */
async function priceConversion(
  deps: MoneyDeps,
  from: string,
  to: string,
  amount: bigint,
): Promise<{ amount: bigint; quotedAt: string }> {
  const needed = [from, to].filter((asset) => asset !== 'SHARD') as LedgerAssetCode[]
  const quotes = await deps.pricing.quotes(needed)

  const rateFor = (asset: string): { rate: bigint; asOf: string } => {
    const quote = quotes.get(asset as LedgerAssetCode)
    if (!quote) {
      // Refused, never defaulted. A fallback rate is a rate at which somebody trades.
      throw new MoneyError(
        'rate_unavailable',
        `there is no usable ${asset} price right now; the conversion is refused rather than guessed`,
        503,
      )
    }
    return { rate: quote.usdPerCoinScaled, asOf: quote.asOf }
  }

  try {
    if (to === 'SHARD') {
      const { rate, asOf } = rateFor(from)
      return {
        amount: shardsForMoney({ amount, assetCode: from as LedgerAssetCode }, rate).amount,
        quotedAt: asOf,
      }
    }
    if (from === 'SHARD') {
      const { rate, asOf } = rateFor(to)
      return { amount: moneyForShards(amount, to as AssetCode, rate).amount, quotedAt: asOf }
    }
    const source = rateFor(from)
    const target = rateFor(to)
    const asShards = shardsForMoney({ amount, assetCode: from as LedgerAssetCode }, source.rate)
    return {
      amount: moneyForShards(asShards.amount, to as AssetCode, target.rate).amount,
      // The older of the two quotes. Reporting the newer one would describe the conversion as
      // fresher than its stalest input, which is the number a user would act on.
      quotedAt: source.asOf < target.asOf ? source.asOf : target.asOf,
    }
  } catch (err) {
    if (err instanceof RateUnavailableError) {
      throw new MoneyError('rate_unavailable', err.message, 503)
    }
    if (err instanceof RangeError) {
      // contracts-chain refuses a negative amount or a non-positive rate. Either is the caller's
      // input being wrong in a way the maths cannot absorb.
      throw new MoneyError('invalid_amount', err.message, 422)
    }
    throw err
  }
}

/* ------------------------------------------------------------------ the shared path */

interface RunInput {
  readonly route: string
  readonly userId: string
  readonly clientKey: string
  readonly requestHash: string
  readonly kind: 'purchase' | 'transfer' | 'conversion'
  readonly actor: Actor
  readonly description: string
  readonly metadata: Record<string, string | number | boolean | null>
  readonly postings: readonly PostingRequest[]
  readonly summary: () => Record<string, unknown>
}

/**
 * The one path all three take: claim the key locally, post to the ledger, store the answer.
 *
 * The ledger call is made **outside** the local claim's transaction and keyed with the same
 * namespaced string, so the two idempotency layers agree about what "this operation" is. That
 * ordering is the same one deposits and withdrawals use and it is chosen for the same reason: a
 * database transaction must not be held open across an HTTP call to another service.
 *
 * `withIdempotency` runs second so that its stored response is the ledger's actual answer. A crash
 * between the two leaves no local row and a posted entry — and the retry replays that entry from
 * the ledger rather than posting a second one, because the key is the same.
 */
async function run(deps: MoneyDeps, input: RunInput): Promise<MoneyResult> {
  const key = namespacedKey(input.userId, input.route, input.clientKey)

  const replay = await peekIdempotency<MoneyResult>(
    deps.sql,
    input.userId,
    input.route,
    input.clientKey,
    input.requestHash,
  )
  if (replay) return { ...replay.result, replayed: true }

  const posted = await deps.ledger.postEntry({
    kind: input.kind,
    actor: input.actor,
    // **Stable per operation, not per request.** The ledger fingerprints the whole body, so a
    // fresh request id here would make a legitimate retry look like a different request and be
    // answered 409 `idempotency_key_reuse`. The operation's own key is the correlation the ledger
    // needs — it joins an entry to the row in this database that caused it — and the HTTP request
    // id stays in this service's logs, where it joins to the trace.
    correlationId: key,
    idempotencyKey: key,
    description: input.description,
    metadata: input.metadata,
    postings: input.postings,
  })

  const outcome = await withIdempotency<MoneyResult>(deps.sql, {
    userId: input.userId,
    route: input.route,
    clientKey: input.clientKey,
    requestHash: input.requestHash,
    run: async () => ({
      entryId: posted.id,
      replayed: posted.replayed,
      summary: input.summary(),
    }),
  })

  return { ...outcome.result, replayed: outcome.replayed || posted.replayed }
}
