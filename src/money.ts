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
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## THE COUNTER-ACCOUNT IS THE DESK, AND IT USED TO BE `clearing`. THAT WAS A MINT.
 *
 * micro-org#495 §1. The old shape put both counter-legs in `clearing(asset)`, and this header used
 * to defend that with the sentence "a `clearing` account is the one kind permitted to sit either
 * side of zero… which it must be, because issuing Shards against a received coin drives the Shard
 * side negative by construction". Every word of that is true and the conclusion was wrong.
 *
 * `ledger_assert_no_overdraft()` in micro-ledger returns *allow* for `type = 'clearing'` **before**
 * it ever reads `overdraft_allowed`. So the output leg of a conversion could not be refused by
 * anything: a user converting into EMBER was credited EMBER out of an account with no EMBER in it,
 * the clearing balance went as negative as it needed to, and the platform owed a coin it had never
 * held. That is the same unbacked liability forge-pay's `convertCoinToEmber` minted — "credits
 * custodial EMBER with no on-chain movement at all" — arrived at by a different route.
 *
 * The counter-account is now `desk(asset)`: `{ subject: 'exchange', purpose: 'inventory', type:
 * 'equity' }`. Two properties, and both are needed:
 *
 *   * **`equity` is credit-normal**, like `clearing`, so the directions of all four postings are
 *     unchanged and a funded desk behaves exactly as the old clearing account did.
 *   * **`equity` falls through to the `overdraft_allowed = false` check.** A desk that cannot fill
 *     an order is refused by Postgres, inside the entry's transaction, serialised on the balance
 *     row — not by a read-then-write in this process. `convert` also pre-checks the inventory in
 *     TypeScript, and that is an addition rather than a replacement: it exists so the ordinary case
 *     returns a named `desk_inventory_short` 409 instead of a constraint violation. The database
 *     stays the thing that is actually load-bearing, and the race is caught below by mapping the
 *     ledger's refusal onto the same code.
 *
 * So the desk is a **funded inventory that can run out**, and running out is a first-class answer
 * rather than an overdraft nobody could see. It is filled by `fundDesk` (admin-only,
 * `POST /v1/admin/exchange-desk/funding`, booked as `liquidity_seed`), and what it holds is a
 * trading signal — so the refusal names the asset and never the figure.
 *
 * The reconciliation property the clearing account had is kept and sharpened. The desk's EMBER
 * balance is coin the platform has taken in exchange for what it issued, and its SHARD balance is
 * what remains of the Shards it was funded with; the pair no longer drifts silently negative,
 * because the negative direction is now the one Postgres refuses.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  RATE_SCALE,
  type Actor,
  type LedgerAssetCode,
  moneyForShards,
  shardsForMoney,
} from '@cloudsforge/contracts-money'
import {
  chainSpec,
  formatAmount,
  type AssetCode,
  type IssuableAssetCode,
} from '@cloudsforge/contracts-chain'
import { chainForAsset } from './addresses.ts'
import {
  namespacedKey,
  peekIdempotency,
  requestFingerprint,
  withIdempotency,
} from './idempotency.ts'
import {
  LedgerRefusedError,
  type LedgerClient,
  type LedgerEntry,
  type PostingRequest,
} from './ledgerclient.ts'
import type { Metrics } from '@cloudsforge/telemetry'
import { CONVERSION_COMPLETED, writeEvent, type Db, type DomainEvent } from './outbox.ts'
import { RateUnavailableError, type PricingClient } from './pricingclient.ts'

export const SPEND_ROUTE = 'POST /v1/spend'
export const TRANSFER_ROUTE = 'POST /v1/transfers'
export const CONVERT_ROUTE = 'POST /v1/conversions'
export const DESK_FUNDING_ROUTE = 'POST /v1/admin/exchange-desk/funding'

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

/**
 * The one subject the Forge Exchange Desk's inventory lives under.
 *
 * Named rather than spelled at each site because two other things have to agree with it and both
 * are string comparisons: `readDeskInventory` filters the ledger's balance list on it, and the race
 * handler in `convert` recognises the ledger's refusal by it. A typo in either would be a desk that
 * silently reads as empty, or a desk refusal reported to a user as their own shortfall.
 */
export const DESK_SUBJECT = 'exchange'

/**
 * The desk's inventory in one asset — the counter-account for every conversion leg.
 *
 * `equity`/`inventory`, deliberately, and NOT `clearing`. See the file header: `clearing` is exempt
 * from the overdraft check in the database, so the account this used to be could be drawn to any
 * negative number, which meant a conversion could always be filled out of nothing. `equity` is
 * credit-normal — so every posting direction here is the same one the clearing account took — and
 * it reaches the `overdraft_allowed = false` check, so an order the desk cannot fill is refused by
 * Postgres inside the entry's own transaction.
 */
function desk(assetCode: LedgerAssetCode) {
  return { subject: DESK_SUBJECT, assetCode, purpose: 'inventory', type: 'equity' } as const
}

/**
 * The refusal, in one place, in one wording, for all three of the ways it can be reached.
 *
 * **THE FIGURE IS NOT IN IT AND MUST NOT BE.** How much of an asset the desk is holding is a
 * trading signal: it is what somebody would need to know to size an order against the platform's
 * book, and answering "the desk has 4.2 EMBER" to an anonymous 409 publishes it to anyone willing
 * to send one request. The asset is named, because a person needs to know which half of their
 * conversion is the problem, and the sentence says what they can do about it.
 *
 * One string for the empty desk, the too-large order and the lost race, so the three are also
 * indistinguishable from outside — a caller that could tell "empty" from "not enough" could binary
 * search the inventory out of the error code, which is the same disclosure by a slower route.
 */
function deskInventoryShort(assetCode: string): MoneyError {
  return new MoneyError(
    'desk_inventory_short',
    `the desk is out of ${assetCode} right now — try a smaller amount, or try again shortly`,
    409,
  )
}

/* ------------------------------------------------------------------ spend */

export interface SpendInput {
  readonly userId: string
  readonly amount: bigint
  readonly reason: string
  readonly clientKey: string
  readonly correlationId: string
  readonly actor: Actor
  /**
   * What the user is paying WITH.
   *
   * **`IssuableAssetCode`, so a retired asset is a COMPILE error rather than a 400.** That type is
   * `Exclude<AssetCode, 'SHARD'>` (`contracts/packages/chain/src/index.ts`), and typing this
   * field with it is the whole of the fix — `micro-mint` took the same shape and it is why a retired
   * code can no longer reach a posting from there either. The alternative, validating at runtime,
   * would have left the next caller free to make the same mistake and find out from the ledger.
   *
   * Defaulted to EMBER rather than required, because every existing caller meant "the platform's
   * unit" and there was exactly one of those before SHARD was retired.
   */
  readonly assetCode?: IssuableAssetCode
}

export interface MoneyResult {
  readonly entryId: string
  readonly replayed: boolean
  readonly summary: Record<string, unknown>
}

/**
 * Debit a user for something the platform provided.
 *
 * `purchase` rather than `fee_charged`: the user received a thing. The counter-account is platform
 * revenue, so "how much did this product earn" is a query over the journal rather than a number
 * nobody can derive — 00-current-state records that `ledger.source` is populated only by the
 * `/internal/*` routes today, so per-product revenue is not derivable from the estate at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ## This used to be hard-coded to SHARD, and that made it dead code the day SHARD was retired
 *
 * `micro-ledger`'s migration 13 refuses a retired asset on an ACQUISITION kind, and `purchase` is
 * the first kind on that list — "a product being SOLD for a wound-down unit". This function was
 * exactly that: it debited the user's SHARD and credited platform revenue, under `kind: 'purchase'`,
 * with the code written as a literal in five places. Every call to `POST /v1/spend` now 400s with
 * `retired_asset`. It is the same defect `micro-mint` had and it is live code.
 *
 * **THE FIX IS NOT TO RELABEL THE KIND, AND THAT DESERVES SAYING OUT LOUD** because it is the
 * cheap move available here. `transfer`, `conversion` and `adjustment` all remain legal for a
 * retired asset, so renaming the kind would make this pass immediately — and it would be a lie:
 * the user is buying a thing from the platform, the counter-account is revenue, and calling that an
 * `adjustment` would put a sale in the one bucket an auditor reads as "somebody corrected
 * something". Worse, it would re-open the hole the guard closes, because a sale priced in a
 * wound-down unit is precisely what must stop happening. The guard is right and this function was
 * wrong.
 *
 * So the asset became a parameter typed `IssuableAssetCode`, which cannot be SHARD, and defaults to
 * EMBER. A retired code is now refused by `tsc` rather than by Postgres — which is the property
 * `micro-mint` gained in the same change, and the only one that stops the next caller repeating it.
 *
 * **WHAT THIS DOES NOT DO, DELIBERATELY.** It does not add USD-cent pricing the way `micro-mint`'s
 * migration 6 did. Mint prices a PRODUCT, so it needs a catalogue, a rate read per purchase and
 * both amounts recorded on the row. This route takes the amount from its caller — there is no price
 * here to convert and no rate to record, and inventing a conversion would be adding an FX step to a
 * number somebody already decided. If a priced product is ever put behind this route, mint's shape
 * is the one to copy, and this paragraph is where to start.
 *
 * **THE 69,000 SHARD UNITS ARE UNAFFECTED.** Holders keep every route out — withdrawal, transfer,
 * conversion to EMBER — because migration 13 leaves all of them legal. What has stopped is selling
 * something new for Shards, which is the intended effect.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function spend(deps: MoneyDeps, input: SpendInput): Promise<MoneyResult> {
  if (input.amount <= 0n) throw new MoneyError('invalid_amount', 'amount must be positive')
  if (input.reason.trim().length === 0) {
    throw new MoneyError('invalid_reason', 'reason must not be empty')
  }
  const assetCode: IssuableAssetCode = input.assetCode ?? 'EMBER'

  const postings: readonly PostingRequest[] = [
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
      account: { subject: 'platform', assetCode, purpose: 'fees', type: 'revenue' },
    },
  ]

  return run(deps, {
    route: SPEND_ROUTE,
    userId: input.userId,
    clientKey: input.clientKey,
    // THE ASSET IS IN THE FINGERPRINT. Two spends of the same amount for the same reason in two
    // different assets are two different requests, and an idempotency key that could not tell them
    // apart would answer the second with the first one's entry — silently, and in the wrong unit.
    requestHash: requestFingerprint({ amount: input.amount, reason: input.reason, assetCode }),
    kind: 'purchase',
    actor: input.actor,
    description: `Spend: ${input.reason}`.slice(0, 200),
    metadata: { reason: input.reason, assetCode, amount: input.amount.toString() },
    postings,
    summary: () => ({
      assetCode,
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
  const { from, to } = convertiblePair(input.fromAssetCode, input.toAssetCode)

  // **Before pricing, not after.** A retry must return the conversion that already happened, not
  // build a new one out of a moved market — see `peekIdempotency` for the failure this avoids.
  //
  // It is also before the desk read below, and that ordering is not incidental either: a retry of a
  // conversion that already happened must be answered from the stored response whatever the desk
  // holds now, because the money already moved and the desk was solvent when it did.
  const requestHash = requestFingerprint({ from, to, amount: input.amount })
  const replay = await peekIdempotency<MoneyResult>(
    deps.sql,
    input.userId,
    CONVERT_ROUTE,
    input.clientKey,
    requestHash,
  )
  if (replay) return { ...replay.result, replayed: true }

  // ── THE PRE-CHECK, WHICH IS AN ADDITION TO THE DATABASE'S GUARD AND NEVER A REPLACEMENT ──────
  //
  // An empty desk is refused HERE, before a rate is fetched: quoting a market to somebody who
  // cannot be filled spends an upstream call and, worse, tells them a price they will not get.
  // The amount comparison below can only be made after pricing — the size of the order in the
  // OUTPUT asset is not known until the output asset's amount exists — so that half is second.
  //
  // Neither check is the guarantee. Both are a read-then-write over the network and a concurrent
  // conversion can empty the desk between this line and the posting; the guarantee is the
  // `overdraft_allowed = false` check the ledger runs inside the entry's transaction with the
  // balance row locked, and the `catch` below is what turns losing that race into the same answer
  // rather than into a raw constraint violation.
  const inventory = await readDeskInventory(deps)
  const held = inventory.get(to as LedgerAssetCode) ?? 0n
  if (held <= 0n) throw deskInventoryShort(to)

  const output = await priceConversion(deps, from, to, input.amount)
  if (output.amount <= 0n) {
    throw new MoneyError(
      'amount_too_small',
      `that amount of ${from} converts to less than one unit of ${to}`,
      422,
    )
  }
  if (output.amount > held) throw deskInventoryShort(to)

  const fromAsset = from as LedgerAssetCode
  const toAsset = to as LedgerAssetCode

  return runConversion(deps, to, {
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
      // The input asset: out of the user, into the desk's inventory. **Both** counter-legs are the
      // desk now — this one used to be `clearing(fromAsset)` too, and leaving it there would have
      // left the coin the user paid in sitting in an account nothing can spend it out of.
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
        account: desk(fromAsset),
      },
      // The output asset: out of the desk, into the user. A separate balanced pair, because the
      // two assets have no arithmetic relationship — see the file header. This is the leg that can
      // be refused, and the only leg that ever could have been.
      {
        direction: 'debit',
        amount: output.amount,
        assetCode: toAsset,
        sequence: 2,
        account: desk(toAsset),
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
    /**
     * micro-org#495 §4. `activity/src/categories.ts` has listed `conversion` as a category since
     * that service was written and nothing has ever produced into it, so a user who swapped one
     * coin for another read a feed that did not mention it.
     *
     * Written through `writeEvent` inside `withIdempotency`'s transaction — see `run` — so the
     * event and the stored idempotency response commit together. Both formatted amounts travel,
     * because wallet is in micro-activity's `SMALLEST_UNIT_PRODUCERS` and a classifier may not go
     * and look decimals up; this is the one service that can, and `formatDisplay` is where it does.
     */
    event: (entryId) => ({
      topic: CONVERSION_COMPLETED,
      // Keyed by the ENTRY. There is no conversions table in this service — the entry IS the
      // conversion, and this id is what `GET /v1/conversions/:id` takes.
      key: entryId,
      payload: {
        userId: input.userId,
        entryId,
        fromAssetCode: from,
        fromAmount: input.amount.toString(),
        fromAmountFormatted: formatDisplay(from, input.amount),
        toAssetCode: to,
        toAmount: output.amount.toString(),
        toAmountFormatted: formatDisplay(to, output.amount),
        rateScale: RATE_SCALE.toString(),
        quotedAt: output.quotedAt,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    }),
  })
}

/**
 * `run`, plus the one refusal that has to be renamed on the way out.
 *
 * The desk's output leg is an `equity` account with `overdraft_allowed = false`, so a desk that
 * cannot fill the order comes back as the ledger's `insufficient_funds` — the SAME code it uses
 * when the USER cannot afford the input leg. Those two are opposite facts: one is "you do not have
 * this", the other is "we do not have this", and a caller that cannot tell them apart tells a
 * person their balance is short when it is not.
 *
 * `subject` is what tells them apart, and micro-ledger sends it as a field on the error precisely
 * so this does not have to be done by matching English. Anything that is not the desk is left
 * exactly as it was — a user's own shortfall still surfaces as the ledger's 409.
 */
async function runConversion(
  deps: MoneyDeps,
  toAsset: string,
  input: RunInput,
): Promise<MoneyResult> {
  try {
    return await run(deps, input)
  } catch (err) {
    if (
      err instanceof LedgerRefusedError &&
      err.code === 'insufficient_funds' &&
      err.subject === DESK_SUBJECT
    ) {
      throw deskInventoryShort(toAsset)
    }
    throw err
  }
}

function isConvertible(assetCode: string): boolean {
  return assetCode === 'SHARD' || chainForAsset(assetCode) !== null
}

/** The two asset codes a conversion is between, upper-cased and checked. Refuses, never guesses. */
function convertiblePair(rawFrom: string, rawTo: string): { from: string; to: string } {
  const from = rawFrom.toUpperCase()
  const to = rawTo.toUpperCase()
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
  return { from, to }
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

/* ------------------------------------------------------------------ the quote */

/** A conversion priced but not booked. Every figure `POST /v1/conversions` would use, and no entry. */
export interface ConversionQuote {
  readonly fromAssetCode: string
  readonly fromAmount: string
  readonly fromAmountFormatted: string
  readonly toAssetCode: string
  readonly toAmount: string
  readonly toAmountFormatted: string
  readonly rateScale: string
  readonly quotedAt: string
  /**
   * **Always `false`, and it is a field rather than a paragraph in the API docs for that reason.**
   *
   * Nothing is reserved by asking. The rate can move between this answer and the conversion, the
   * desk's inventory can be spent by somebody else in the same window, and either one makes the
   * conversion come back with a different number or with `desk_inventory_short`. A surface that
   * renders a quote as though it were a hold is making a promise this service has not made, and the
   * only way to stop that being an easy mistake is to put the disclaimer in the payload the surface
   * is already rendering.
   *
   * It is a constant today. It stays a field so that a desk which one day CAN hold — a quote with
   * an expiry and a reserved inventory line — becomes `true` here rather than a new shape.
   */
  readonly hold: false
  /** The same fact as a sentence, so a client has something to show without composing English. */
  readonly holdNotice: string
}

const HOLD_NOTICE =
  'This is a quote, not a hold. Nothing is reserved: the rate and the desk’s inventory can both ' +
  'move before you convert, and the conversion is priced again when you make it.'

/**
 * Price a conversion without booking one.
 *
 * The same validation and the same `priceConversion` the real thing uses, so a quote cannot say
 * something the conversion would refuse — including `amount_too_small`, which is a refusal a person
 * would much rather have while they are still typing.
 *
 * **The desk's inventory is deliberately NOT consulted here.** It would have to be reported as a
 * yes/no on this exact amount, and an unlimited, free, unbooked route that answers "can you fill
 * N?" is an oracle: a caller binary-searches N and reads the inventory straight out of it. That is
 * the figure `desk_inventory_short` exists not to disclose. A quote that cannot be filled is
 * therefore refused at the conversion rather than at the quote, which costs the caller one request
 * and the platform nothing.
 */
export async function quoteConversion(
  deps: MoneyDeps,
  input: { readonly fromAssetCode: string; readonly toAssetCode: string; readonly amount: bigint },
): Promise<ConversionQuote> {
  if (input.amount <= 0n) throw new MoneyError('invalid_amount', 'amount must be positive')
  const { from, to } = convertiblePair(input.fromAssetCode, input.toAssetCode)

  const output = await priceConversion(deps, from, to, input.amount)
  if (output.amount <= 0n) {
    throw new MoneyError(
      'amount_too_small',
      `that amount of ${from} converts to less than one unit of ${to}`,
      422,
    )
  }

  return {
    fromAssetCode: from,
    fromAmount: input.amount.toString(),
    fromAmountFormatted: formatDisplay(from, input.amount),
    toAssetCode: to,
    toAmount: output.amount.toString(),
    toAmountFormatted: formatDisplay(to, output.amount),
    rateScale: RATE_SCALE.toString(),
    quotedAt: output.quotedAt,
    hold: false,
    holdNotice: HOLD_NOTICE,
  }
}

/* ------------------------------------------------------------------ the desk */

/**
 * What the desk is holding, per asset, in smallest units.
 *
 * One call to the ledger for every asset rather than one per asset: `GET /accounts/:subject/
 * balances` returns the subject's whole set, and the pre-check in `convert` sits on the hot path of
 * every conversion.
 *
 * Filtered on `purpose === 'inventory'` rather than taken whole. The `exchange` subject is a
 * subject like any other and nothing stops a later change opening a `fees` or `suspense` account
 * under it; counting those as stock the desk can sell would be the same class of mistake as reading
 * a user's `reserved` balance as spendable.
 */
async function readDeskInventory(deps: MoneyDeps): Promise<Map<LedgerAssetCode, bigint>> {
  const balances = await deps.ledger.balances(DESK_SUBJECT)
  const held = new Map<LedgerAssetCode, bigint>()
  for (const balance of balances) {
    if (balance.purpose !== 'inventory') continue
    held.set(balance.assetCode, balance.amount)
  }
  return held
}

/** One asset's inventory, as the admin surface reads it. */
export interface DeskInventoryRow {
  readonly assetCode: string
  readonly amount: string
  readonly amountFormatted: string
}

/**
 * The desk's inventory, for an operator.
 *
 * **The figure IS returned here, and that is not in tension with `deskInventoryShort` hiding it.**
 * The route this backs is `requireAdmin`-only: an operator deciding whether to fund the desk has to
 * see what is in it, and they are not an anonymous caller who can be handed a trading signal for
 * the price of one request. The two answers differ because the two audiences do.
 *
 * Sorted by asset code so a diff between two readings is a diff about the numbers.
 */
export async function deskInventory(deps: MoneyDeps): Promise<readonly DeskInventoryRow[]> {
  const held = await readDeskInventory(deps)
  return [...held.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([assetCode, amount]) => ({
      assetCode,
      amount: amount.toString(),
      amountFormatted: formatDisplay(assetCode, amount),
    }))
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * PUBLISH WHAT THE DESK IS HOLDING, SO THAT RUNNING DRY IS SEEN BEFORE IT IS FELT.
 *
 * micro-org#501. `fundDesk` is `requireAdmin` and stays that way — the argument is in the issue and
 * the short version is that both fundings this estate has booked drew on a USER's available
 * balance, so a service principal able to call it would be a machine that can debit a user without
 * that user's session. The gate is right. What was missing is that NOTHING observed the inventory:
 * an empty desk produced no series, no alert and no log line, and the first party to learn of it
 * would have been a person holding a 409.
 *
 * ── WHY THIS IS NOT THE DISCLOSURE `deskInventoryShort` REFUSES ────────────────────────────────
 *
 * That refusal hides the figure because an anonymous caller could otherwise buy a trading signal
 * for the price of one request. This is the same number and a different audience. `/metrics` is
 * bound to `127.0.0.1:<port>:4000` in the estate's compose file and carries no gateway route, so
 * the only things that can read it are Prometheus on the container network and somebody already on
 * the host. `deskInventory` above makes the identical trade for the identical reason and says so.
 *
 * **If wallet is ever given a public route, this series moves or the route excludes `/metrics`.**
 *
 * ── WHOLE UNITS, NOT THE SMALLEST UNIT ────────────────────────────────────────────────────────
 *
 * A Prometheus sample is a float64, and the desk's EMBER balance today is 2.84e22 wei — four
 * orders of magnitude past the last integer a float64 can hold exactly. Exporting raw wei would
 * publish a silently rounded number as the input to a threshold, which is the one job this series
 * has. `formatAmount` is the same conversion the operator's own surface uses, so the gauge and the
 * admin route cannot disagree about what is in the desk.
 *
 * ── AN ABSENT SERIES IS NOT A ZERO, AND THAT IS WHY THE COUNTER BESIDE IT EXISTS ──────────────
 *
 * This can only publish an asset the desk holds an account in. An asset it was never funded in at
 * all has no balance row, so no series, so `wallet_desk_inventory < x` never fires for it — the
 * silence looks identical to health. `ExchangeDeskInventoryShort` in `deploy/prometheus/rules/`
 * alerts on the REFUSAL instead, which is emitted from the conversion route whether or not an
 * account exists, and the two rules together cover both shapes.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function sampleDeskInventory(deps: MoneyDeps, metrics: Metrics): Promise<void> {
  const held = await readDeskInventory(deps)
  for (const [assetCode, amount] of held) {
    metrics.set('wallet_desk_inventory', wholeUnits(assetCode, amount), { asset: assetCode })
  }
}

/**
 * An amount as a number of whole units, for a gauge and for nothing else.
 *
 * Every other reader of an amount in this file keeps it a `bigint` all the way to the ledger, and
 * that is not negotiable — this is the one place a lossy conversion is correct, because the
 * destination is a float64 either way and the choice is only whether the loss lands in the
 * fractional digits or in the significant ones.
 */
function wholeUnits(assetCode: string, amount: bigint): number {
  return Number(formatDisplay(assetCode, amount))
}

export interface FundDeskInput {
  /** The operator. Their id namespaces the idempotency key — see `RunInput.userId`. */
  readonly adminUserId: string
  /** `platform`, or a user subject `user:<uuid>`. */
  readonly sourceAccount: string
  readonly assetCode: string
  readonly amount: bigint
  readonly reason: string
  /**
   * `in` puts stock into the desk; `out` takes it back out to the same account.
   *
   * **The reversing sibling is this field and not a second route.** A funding that could not be
   * undone by the same code path would be undone by hand-written SQL the first time an operator
   * fat-fingered an amount, and `out` posting through `run` means the reversal carries an
   * idempotency key, a correlation id, an actor and a reason exactly as the funding did. It is also
   * where the desk's own solvency check earns its keep in the other direction: drawing more out
   * than the desk holds is refused by the ledger, so a drawdown cannot leave the inventory negative.
   */
  readonly direction: 'in' | 'out'
  readonly clientKey: string
  readonly correlationId: string
  readonly actor: Actor
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The account the stock comes from or goes back to.
 *
 * Checked rather than passed through, because **the ledger creates an account it has not seen**.
 * A typo in a subject does not fail: it opens a permanent account with a misspelt name, moves real
 * money into it, and the money is then in a place no route can spend it out of. A uuid check is
 * cheap and it is the difference between a 422 and a manual correction entry.
 */
function fundingSource(raw: string, assetCode: LedgerAssetCode) {
  if (raw === 'platform') {
    return { subject: 'platform', assetCode, purpose: 'treasury', type: 'equity' } as const
  }
  const userId = raw.startsWith('user:') ? raw.slice('user:'.length) : raw
  if (!UUID.test(userId)) {
    throw new MoneyError(
      'unknown_source',
      `sourceAccount must be 'platform' or a user subject 'user:<uuid>' — '${raw}' is neither`,
      422,
    )
  }
  return userAvailable(userId, assetCode)
}

/**
 * Move stock between an account and the desk. Admin-only; the route enforces that.
 *
 * `liquidity_seed` is the kind, and it was already in `ENTRY_KINDS` — this change added no kind to
 * the ledger's vocabulary. It is the right one: what happens here is that the platform puts its own
 * assets behind a market so that market can trade, which is what seeding liquidity is, and every
 * alternative that fitted was worse. `adjustment` is the bucket an auditor reads as "somebody
 * corrected something" and this corrects nothing; `treasury_spend` says the money left, and it has
 * not left — it has moved from one platform account to another and can be moved back by this same
 * route.
 *
 * **This does NOT create the stock.** Funding from `platform` debits the treasury's equity account
 * in that asset, and equity is not overdraft-exempt either, so a treasury that has never held EMBER
 * cannot seed an EMBER desk. That is the correct refusal — a desk funded out of an account with
 * nothing in it is the unbacked liability this whole change removes, one account further back — but
 * it does mean that on a cold estate the treasury has to be given the asset first, by a deposit or
 * by a `liquidity_seed` from wherever the platform really holds it.
 */
export async function fundDesk(deps: MoneyDeps, input: FundDeskInput): Promise<MoneyResult> {
  if (input.amount <= 0n) throw new MoneyError('invalid_amount', 'amount must be positive')
  if (input.reason.trim().length === 0) {
    throw new MoneyError('invalid_reason', 'reason must not be empty')
  }
  const assetCode = input.assetCode.toUpperCase() as LedgerAssetCode
  const source = fundingSource(input.sourceAccount, assetCode)
  const inward = input.direction === 'in'
  const reason = input.reason.trim()

  // Two postings, one asset, and the pair simply swaps ends on `out`. Both accounts are
  // credit-normal, so a debit reduces and a credit increases on either side of it.
  const from = inward ? source : desk(assetCode)
  const into = inward ? desk(assetCode) : source

  return run(deps, {
    route: DESK_FUNDING_ROUTE,
    userId: input.adminUserId,
    clientKey: input.clientKey,
    // THE DIRECTION IS IN THE FINGERPRINT. Funding and its reversal are the same amount, the same
    // asset and the same account, and a key that could not tell them apart would answer the
    // reversal with the funding's entry and report the money as moved back when it had not.
    requestHash: requestFingerprint({
      sourceAccount: input.sourceAccount,
      assetCode,
      amount: input.amount,
      direction: input.direction,
      reason,
    }),
    kind: 'liquidity_seed',
    actor: input.actor,
    description: `Exchange desk ${inward ? 'funding' : 'drawdown'}: ${reason}`.slice(0, 200),
    metadata: {
      sourceAccount: input.sourceAccount,
      assetCode,
      amount: input.amount.toString(),
      direction: input.direction,
      reason,
    },
    postings: [
      { direction: 'debit', amount: input.amount, assetCode, sequence: 0, account: from },
      { direction: 'credit', amount: input.amount, assetCode, sequence: 1, account: into },
    ],
    summary: () => ({
      sourceAccount: input.sourceAccount,
      assetCode,
      amount: input.amount.toString(),
      amountFormatted: formatDisplay(assetCode, input.amount),
      direction: input.direction,
      reason,
    }),
  })
}

/* ------------------------------------------------------------------ reading them back */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE JOURNAL IS THE RECORD. THERE IS NO CONVERSIONS TABLE AND THERE IS NOT GOING TO BE ONE.
 *
 * micro-org#495 §3. A conversion already exists, in full, as a journal entry: the assets, both
 * amounts, the rate scale and the quote time are in `metadata`, and the entry's id is its identity.
 * A wallet-side copy would be a second record of the same fact, written in a second transaction,
 * free to disagree with the first — and the disagreement would be invisible, because the surface
 * would be reading the copy.
 *
 * That was not possible when the issue was written: `GET /entries` filtered on `kind`,
 * `originatingService` and `correlationId`, every one of which is a property of the ENTRY rather
 * than of whose money it was, so the only shapes available were "page the whole journal and filter
 * here" or a table. `ListEntriesQuery.subject` was added to micro-ledger for this, and the two
 * filters together — `subject: user:<id>` and `kind` — are what makes the read cheap and correct.
 *
 * `originatingService: 'wallet'` is on both reads as well. It is not about authority: it is what
 * guarantees the metadata below is metadata THIS file wrote, so the field names are known rather
 * than hoped for. Another service booking a `conversion` against the same user is a real entry and
 * a real thing that happened; it is not one of these, and reporting it as one would be reading
 * somebody else's shape.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** A conversion, read back out of the journal entry that IS it. */
export interface ConversionView {
  readonly id: string
  readonly occurredAt: string
  readonly recordedAt: string
  readonly fromAssetCode: string
  readonly fromAmount: string
  readonly fromAmountFormatted: string
  readonly toAssetCode: string
  readonly toAmount: string
  readonly toAmountFormatted: string
  readonly rateScale: string
  readonly quotedAt: string | null
}

export interface ConversionPage {
  readonly conversions: readonly ConversionView[]
  /** Absent on the last page. Callers page until it is null, never by counting. */
  readonly nextCursor: string | null
}

/** A transfer, from the point of view of one of its two ends. */
export interface TransferView {
  readonly id: string
  readonly occurredAt: string
  readonly recordedAt: string
  /** `out` when this user sent it, `in` when they received it. */
  readonly direction: 'out' | 'in'
  readonly assetCode: string
  readonly amount: string
  readonly amountFormatted: string
  /** The other end, or null if the entry does not say who it was. */
  readonly counterpartyUserId: string | null
}

export interface TransferPage {
  readonly transfers: readonly TransferView[]
  readonly nextCursor: string | null
}

export interface ListInput {
  readonly userId: string
  readonly limit: number
  readonly cursor?: string
}

export async function listConversions(deps: MoneyDeps, input: ListInput): Promise<ConversionPage> {
  const page = await deps.ledger.listEntries({
    limit: input.limit,
    kind: 'conversion',
    originatingService: 'wallet',
    subject: `user:${input.userId}`,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  })
  return {
    conversions: page.entries.map(conversionView),
    nextCursor: page.nextCursor,
  }
}

/**
 * One conversion, by entry id.
 *
 * **Ownership is proved from `correlationId`, and the reason is a gap in what the ledger returns.**
 * `GET /entries/:id` gives each posting an `accountId` — a uuid — and no subject, so the entry
 * alone cannot answer "is one of these accounts this user's" without a second lookup this service
 * has no route for. What it does carry is the correlation id, which for every money entry this
 * service posts is `namespacedKey(userId, route, clientKey)` — the user's id, a colon, the route.
 * A uuid contains no colon, so the prefix is exact.
 *
 * Fail-closed in all three directions: not this service's entry, not a conversion, or not this
 * user's, and the answer is the same `null` that a nonexistent id gets. A caller must not be able
 * to tell "somebody else's conversion" from "no such conversion", because the first is an oracle
 * for entry ids.
 */
export async function readConversion(
  deps: MoneyDeps,
  input: { readonly userId: string; readonly entryId: string },
): Promise<ConversionView | null> {
  const entry = await deps.ledger.readEntry(input.entryId)
  if (!entry) return null
  if (entry.originatingService !== 'wallet' || entry.kind !== 'conversion') return null
  if (!entry.correlationId.startsWith(`${input.userId}:`)) return null
  return conversionView(entry)
}

/**
 * This user's transfers, sent and received.
 *
 * Both directions, out of one query, because the ledger's subject filter is an ENTRY-level filter:
 * an entry with a posting against `user:<id>` is returned whole, whichever end of it that posting
 * is. A "transfers" list that showed only what a user had sent would be a strange thing to hand
 * somebody looking for the money their friend said they sent them.
 */
export async function listTransfers(deps: MoneyDeps, input: ListInput): Promise<TransferPage> {
  const page = await deps.ledger.listEntries({
    limit: input.limit,
    kind: 'transfer',
    originatingService: 'wallet',
    subject: `user:${input.userId}`,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  })
  return {
    transfers: page.entries.map((entry) => transferView(entry, input.userId)),
    nextCursor: page.nextCursor,
  }
}

/**
 * Read a metadata field this file wrote, or say which one is missing.
 *
 * Loud rather than lenient. The alternative — defaulting a missing amount to `'0'` or a missing
 * asset to the empty string — puts a wrong number in front of a person and calls it a conversion,
 * and there is no value of a missing amount that is safe to invent. Both list reads filter on
 * `originatingService: 'wallet'` and on the kind, so every entry that reaches here was written a
 * few hundred lines above with all of these fields present; if one is ever absent, that is a defect
 * in this file and a 500 saying which field is the correct report of it.
 */
function metaField(entry: LedgerEntry, field: string): string {
  const value = entry.metadata[field]
  if (typeof value !== 'string') {
    throw new MoneyError(
      'entry_unreadable',
      `journal entry ${entry.id} has no ${field} in its metadata`,
      500,
    )
  }
  return value
}

function optionalMetaField(entry: LedgerEntry, field: string): string | null {
  const value = entry.metadata[field]
  return typeof value === 'string' ? value : null
}

function conversionView(entry: LedgerEntry): ConversionView {
  const fromAssetCode = metaField(entry, 'fromAssetCode')
  const toAssetCode = metaField(entry, 'toAssetCode')
  const fromAmount = metaField(entry, 'fromAmount')
  const toAmount = metaField(entry, 'toAmount')
  return {
    id: entry.id,
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt,
    fromAssetCode,
    fromAmount,
    // Formatted on the way out rather than stored twice. `chainSpec` has the decimals and the
    // entry does not need a second copy of a number the first one already determines.
    fromAmountFormatted: formatDisplay(fromAssetCode, BigInt(fromAmount)),
    toAssetCode,
    toAmount,
    toAmountFormatted: formatDisplay(toAssetCode, BigInt(toAmount)),
    rateScale: metaField(entry, 'rateScale'),
    quotedAt: optionalMetaField(entry, 'quotedAt'),
  }
}

function transferView(entry: LedgerEntry, userId: string): TransferView {
  const assetCode = metaField(entry, 'assetCode')
  const amount = metaField(entry, 'amount')
  // The sender is whoever the entry was correlated for — see `readConversion` for why that prefix
  // is exact — and the recipient is in the metadata `transfer` wrote.
  const sender = entry.correlationId.split(':')[0] ?? ''
  const recipient = optionalMetaField(entry, 'toUserId')
  const outgoing = sender === userId
  return {
    id: entry.id,
    occurredAt: entry.occurredAt,
    recordedAt: entry.recordedAt,
    direction: outgoing ? 'out' : 'in',
    assetCode,
    amount,
    amountFormatted: formatDisplay(assetCode, BigInt(amount)),
    counterpartyUserId: outgoing ? recipient : sender || null,
  }
}

/* ------------------------------------------------------------------ the shared path */

interface RunInput {
  readonly route: string
  /**
   * Whose idempotency key this is.
   *
   * For the three user routes it is the user whose money moves. For `fundDesk` it is the ADMIN who
   * asked, because the key namespace is per principal and the desk has no user — two operators
   * funding the desk with the same client key must be two operations, not one replaying the other's.
   */
  readonly userId: string
  readonly clientKey: string
  readonly requestHash: string
  readonly kind: 'purchase' | 'transfer' | 'conversion' | 'liquidity_seed'
  readonly actor: Actor
  readonly description: string
  readonly metadata: Record<string, string | number | boolean | null>
  readonly postings: readonly PostingRequest[]
  readonly summary: () => Record<string, unknown>
  /**
   * The domain event this operation announces, if it announces one.
   *
   * Takes the entry id because that is not known until the ledger has answered, and it is both the
   * event's key and the identity of the thing that happened. Optional, and only `convert` supplies
   * one today: `spend` and `transfer` have never emitted and adding topics for them is not this
   * change.
   */
  readonly event?: (entryId: string) => DomainEvent
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
 *
 * **The outbox row is written inside that same transaction**, which is rule 5 of 03 §2 and the
 * reason `writeEvent` is exported at all: a publish after commit is a publish that is skipped when
 * the process dies in between. It is written whenever the LOCAL claim is fresh, including on the
 * crash path above where the ledger replays a posting this process made and then lost — that is
 * exactly the case where no event was ever written, so writing one is what makes the emit
 * exactly-once rather than at-most-once.
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
    run: async (tx) => {
      if (input.event) await writeEvent(tx, deps.producer, input.event(posted.id))
      return {
        entryId: posted.id,
        replayed: posted.replayed,
        summary: input.summary(),
      }
    },
  })

  return { ...outcome.result, replayed: outcome.replayed || posted.replayed }
}
