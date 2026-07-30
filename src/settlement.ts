/**
 * The boundary with `micro-settlement`, which does not exist yet.
 *
 * 03-repository-responsibilities §1.1 gives settlement "treasuries, sweeps, outbound transaction
 * building, signing requests, broadcast, confirmation tracking, stuck/abandon adjudication".
 * 04-domain-model §4.4 gives it `outbound_transaction` and its state machine. **None of that is in
 * this repository and none of it ever will be.** What is here is the contract: the fee this
 * service quotes, the event it emits, and the callbacks it will accept — written down now, so that
 * building settlement is implementing a stated interface rather than negotiating one.
 *
 * ## Why the interface is written before the implementation
 *
 * Because the alternative is what forge-pay did. There, `requestWithdrawal` debits the balance and
 * `withdrawer.ts` picks the row up from the same database — one process's schema is the other's
 * API, and the coupling is invisible until the split. 04-domain-model §4.4 records the invariant
 * that arrangement fails to hold: "One in-flight outbound transaction per
 * `(chain, network, from_address)` at a time, enforced by the job lease keyed on the chain. This
 * is the fix for the lost-payment race." Two withdrawal workers signing against one nonce is a
 * permanently lost payment, and the lease that prevents it belongs to settlement — which means
 * settlement has to be the one holding the state, which means the handover has to be an event.
 *
 * ## The handover, in full
 *
 *   1. wallet validates the destination, quotes a fee, **reserves through the ledger**, and writes
 *      a `queued` withdrawal row.
 *   2. wallet emits `wallet.withdrawal.requested`. The outbox makes this durable, and the relay
 *      computes its delivery set from the live subscription list on every pass — so settlement
 *      subscribing later still receives every withdrawal requested in the meantime. That is why
 *      emitting into the void today is correct rather than merely tolerable.
 *   3. settlement builds, signs and broadcasts, holding the chain lease.
 *   4. settlement emits `settlement.outbound.confirmed` or `.failed`, which this service consumes
 *      to settle the reservation or to refund it.
 *
 * **The reservation is the safety property.** Between (1) and (4) the money is in the user's
 * `reserved` account: it is not spendable, it is not lost, and it is visible in a trial balance. A
 * settlement that never happens leaves a reservation an operator can release. forge-pay debits the
 * balance outright at step (1), so a withdrawal that fails has to be repaired by writing a
 * compensating credit by hand.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { AssetCode, Network } from '@cloudsforge/contracts-chain'
import type { ChainId } from './addresses.ts'

/** No usable fee. A withdrawal refuses with 503 rather than being priced by guessing. */
export class FeeUnavailableError extends Error {
  readonly assetCode: string
  constructor(assetCode: string, message: string) {
    super(message)
    this.name = 'FeeUnavailableError'
    this.assetCode = assetCode
  }
}

/**
 * What one outbound payment will cost, in the asset's smallest units.
 *
 * A port rather than a function, because the answer comes from a different place at each stage of
 * the migration: an operator-stated table today, settlement's live estimate once it exists. The
 * withdrawal path does not change when that swaps over.
 */
export interface FeeQuoter {
  quote(chain: ChainId, network: Network, assetCode: AssetCode): Promise<bigint>
}

/**
 * Fees from configuration.
 *
 * **This is the honest interim, not a placeholder.** Until settlement can ask a node what a
 * transaction costs, somebody has to state the number, and an operator stating it in a variable
 * the deploy can see is better in every way than this service inventing one. An asset absent from
 * the table throws — the same fail-closed rule as `withinTolerance` in contracts-money and for the
 * same reason: an asset silently exempt from a check is an asset with no check.
 */
export function staticFeeQuoter(table: Readonly<Record<string, bigint>>): FeeQuoter {
  return {
    async quote(_chain, _network, assetCode) {
      const fee = table[assetCode]
      if (fee === undefined) {
        throw new FeeUnavailableError(
          assetCode,
          `no ${assetCode} network fee is configured; withdrawals for it are refused rather than priced by guessing`,
        )
      }
      return fee
    },
  }
}

/**
 * Fees from settlement, once it exists.
 *
 * Unused today and deliberately shipped anyway: it is the one line of `index.ts` that changes when
 * settlement lands, and having it here makes that visible.
 */
export function httpFeeQuoter(options: {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}): FeeQuoter {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'settlement',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  return {
    async quote(chain, network, assetCode) {
      try {
        const body = await client.get<{ fee: string }>(`/v1/fees/${chain}/${network}/${assetCode}`)
        return BigInt(body.fee)
      } catch (err) {
        if (err instanceof HttpError && err.peerDecided) {
          throw new FeeUnavailableError(assetCode, err.message)
        }
        throw new FeeUnavailableError(
          assetCode,
          `the ${assetCode} network fee cannot be quoted right now`,
        )
      }
    },
  }
}

/**
 * The payload of `wallet.withdrawal.requested`.
 *
 * **This is the interface `micro-settlement` implements.** Everything settlement needs to build,
 * sign and broadcast one payment is here, and nothing else is:
 *
 *   * `net` is what leaves the address; `amount` is what left the user's balance. The fee comes
 *     out of the amount rather than on top, so a user can always withdraw their whole balance —
 *     forge-pay gets this right and the split preserves it.
 *   * `reservationEntryId` is the ledger entry holding the funds. Settlement quotes it back on
 *     confirmation so the settle and the reservation cannot be matched up wrongly.
 *   * `idempotencyKey` is this service's, and settlement must use it as the key of its own
 *     outbound transaction. A redelivered event must not produce a second payment, and the only
 *     value both services can agree on is this one.
 *
 * Additive-only, versioned per topic, schema-diff enforced — AD-02. A field may be added here; one
 * may never be removed or repurposed.
 */
export interface WithdrawalRequestedPayload {
  readonly withdrawalId: string
  readonly userId: string
  readonly chain: ChainId
  readonly network: Network
  readonly assetCode: AssetCode
  readonly destination: string
  /** Smallest units, decimal strings. A uint256 does not fit in a JSON number. */
  readonly amount: string
  readonly fee: string
  readonly net: string
  readonly reservationEntryId: string
  readonly idempotencyKey: string
  readonly requestedAt: string
}

/**
 * The two events this service will consume from settlement.
 *
 * Declared here rather than in `outbox.ts` because they are settlement's names, not this
 * service's, and the file that owns the boundary should be the file that spells them.
 */
export const SETTLEMENT_CONFIRMED = 'settlement.outbound.confirmed'
export const SETTLEMENT_FAILED = 'settlement.outbound.failed'

export interface SettlementConfirmedPayload {
  readonly withdrawalId: string
  readonly txHash: string
  readonly confirmedAt: string
}

export interface SettlementFailedPayload {
  readonly withdrawalId: string
  readonly reason: string
  /**
   * Whether the payment is known **not** to have reached the chain.
   *
   * The single most important field in this contract. A refund is only safe when settlement can
   * say the transaction was never broadcast, or was broadcast and definitively dropped. "We do not
   * know" is not a refund — it is a `stuck` withdrawal and an operator, because refunding a
   * payment that actually landed pays the user twice.
   */
  readonly refundable: boolean
}
