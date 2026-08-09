/**
 * Withdrawals: request, validate, quote, **reserve**, queue — and the state machine that follows.
 *
 * Sending the payment is `micro-settlement`'s and is not in this repository. See `settlement.ts`
 * for the interface it will implement. What is here is everything up to the handover, plus the two
 * things that go wrong afterwards: a withdrawal that never settles, and one that fails.
 *
 * ## The reservation is the whole point
 *
 * 04-domain-model §2.1: "The available/reserved split is modelled as two accounts, not two
 * columns. Reserving funds is a posting from `available` to `reserved`, which means a reservation
 * is auditable, reversible and impossible to lose track of. Today no reservation concept exists at
 * all."
 *
 * forge-pay debits the balance outright when the withdrawal is requested. Three consequences, all
 * live:
 *
 *   * A withdrawal that fails has to be repaired by writing a compensating credit by hand, and
 *     nothing checks that it was written.
 *   * A trial balance cannot see money in flight, because there is nowhere for it to be.
 *   * The same balance can be committed twice, because "committed" is not a state anything holds.
 *
 * Here the money moves `available → reserved` through the ledger, as a posting pair, and comes
 * back the same way on a refund. **This service performs no arithmetic on a balance at any point**
 * — it asks the ledger to move value and reads the answer.
 *
 * ## Ordering: claim, then reserve
 *
 * The withdrawal row is claimed under the idempotency key first and committed; the reservation
 * follows. Reserving inside that transaction would hold a database transaction open across an HTTP
 * call to the ledger, which under a ledger outage is every connection in the pool held for the
 * full deadline. A crash between the two leaves a `requested` row with no reservation, which is a
 * visible state a job can finish or an operator can cancel — where the reverse, a reservation with
 * no row, would be a user's money held with nothing recording why.
 */

import {
  type AssetCode,
  type Network,
  chainSpec,
  formatAmount,
} from '@cloudsforge/contracts-chain'
import type { Actor } from '@cloudsforge/contracts-money'
import { canonicaliseAddress, chainForAsset, type ChainId } from './addresses.ts'
import { uuidv7 } from './ids.ts'
import { namespacedKey, requestFingerprint, withIdempotency } from './idempotency.ts'
import { LedgerRefusedError, type LedgerClient } from './ledgerclient.ts'
import { authorisationHolds } from './links.ts'
import {
  WITHDRAWAL_REFUNDED,
  WITHDRAWAL_REQUESTED,
  WITHDRAWAL_STUCK,
  withOutbox,
  type Db,
  type Tx,
} from './outbox.ts'
import { FeeUnavailableError, type FeeQuoter, type WithdrawalRequestedPayload } from './settlement.ts'
import { isPlatformAddress } from './wallets.ts'

export const WITHDRAW_ROUTE = 'POST /v1/withdrawals'

export class WithdrawalError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'WithdrawalError'
    this.code = code
    this.status = status
  }
}

export type WithdrawalState =
  | 'requested'
  | 'reserved'
  | 'queued'
  | 'settling'
  | 'settled'
  | 'stuck'
  | 'failed'
  | 'refunded'
  | 'cancelled'

/**
 * The state machine, as a table.
 *
 * `stuck` is not a terminal and that is the important entry. A stuck withdrawal has a reservation
 * held and a payment whose fate is unknown; it must be able to become `settled` (it landed after
 * all) or `failed` (it definitively did not). forge-pay had no way out of `stuck` at all until
 * CF-07 — no route and no worker could move a row out of it, only a hand-written UPDATE — and the
 * consequence was a reservation held for ever against a user who had been debited.
 *
 * `failed → refunded` is the only path that returns money, and it is a ledger release rather than
 * a credit: releasing a reservation is the exact inverse of making one, so the pair nets to
 * nothing in the journal. A compensating credit would balance the entry while leaving two
 * unrelated movements an auditor has to connect by hand.
 */
const TRANSITIONS: Readonly<Record<WithdrawalState, readonly WithdrawalState[]>> = Object.freeze({
  requested: ['reserved', 'failed', 'cancelled'],
  reserved: ['queued', 'failed', 'cancelled'],
  queued: ['settling', 'settled', 'stuck', 'failed'],
  settling: ['settled', 'stuck', 'failed'],
  stuck: ['settled', 'failed'],
  settled: [],
  failed: ['refunded'],
  refunded: [],
  cancelled: ['refunded'],
})

export function canTransition(from: WithdrawalState, to: WithdrawalState): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to)
}

export interface WithdrawalRecord {
  readonly id: string
  readonly userId: string
  readonly chain: ChainId
  readonly network: Network
  readonly assetCode: AssetCode
  readonly destination: string
  readonly destinationWalletId: string | null
  readonly amount: string
  readonly amountFormatted: string
  readonly fee: string
  readonly net: string
  readonly netFormatted: string
  readonly state: WithdrawalState
  readonly reservationEntryId: string | null
  readonly txHash: string | null
  readonly failureReason: string | null
  readonly requestedAt: string
  readonly updatedAt: string
}

interface WithdrawalRow {
  readonly id: string
  readonly user_id: string
  readonly chain: string
  readonly network: string
  readonly asset_code: string
  readonly destination_address: string
  readonly destination_key: string
  readonly destination_wallet_id: string | null
  readonly amount: string
  readonly fee: string
  readonly net: string
  readonly state: string
  readonly reservation_entry_id: string | null
  readonly tx_hash: string | null
  readonly failure_reason: string | null
  readonly idempotency_key: string
  readonly requested_at: Date
  readonly updated_at: Date
}

const COLUMNS = `id, user_id, chain, network, asset_code, destination_address, destination_key,
                 destination_wallet_id, amount::text as amount, fee::text as fee,
                 net::text as net, state, reservation_entry_id, tx_hash, failure_reason,
                 idempotency_key, requested_at, updated_at`

function toWithdrawal(row: WithdrawalRow): WithdrawalRecord {
  const assetCode = row.asset_code as AssetCode
  const decimals = chainSpec(assetCode).decimals
  return {
    id: row.id,
    userId: row.user_id,
    chain: row.chain as ChainId,
    network: row.network as Network,
    assetCode,
    destination: row.destination_address,
    destinationWalletId: row.destination_wallet_id,
    amount: row.amount,
    amountFormatted: formatAmount(BigInt(row.amount), decimals),
    fee: row.fee,
    net: row.net,
    netFormatted: formatAmount(BigInt(row.net), decimals),
    state: row.state as WithdrawalState,
    reservationEntryId: row.reservation_entry_id,
    txHash: row.tx_hash,
    failureReason: row.failure_reason,
    requestedAt: row.requested_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export interface WithdrawalDeps {
  readonly sql: Db
  readonly producer: string
  readonly network: Network
  readonly ledger: LedgerClient
  readonly fees: FeeQuoter
  readonly withdrawalsEnabled: boolean
  readonly minFeeMultiple: number
  readonly stuckMinutes: number
}

export interface RequestInput {
  readonly userId: string
  readonly assetCode: string
  readonly destination: string
  /** Smallest units. The fee comes out of this, never on top. */
  readonly amount: bigint
  readonly clientKey: string
  readonly correlationId: string
  /** Whoever caused it: the user, or an operator acting for them. */
  readonly actor: Actor
}

/**
 * Validate a destination and, if it is one of the user's registered wallets, check its authority.
 *
 * **This is where "an unverified `watch` address can never be a withdrawal destination" is
 * enforced**, and the shape of the check is the substance:
 *
 *   * The address is looked up among *this user's* wallets. If it is registered, it must hold the
 *     `withdrawal_destination` authorisation on a verified, unrevoked link. A `watch` wallet has
 *     no link at all, so `authorisationHolds` is false for it by construction — there is no branch
 *     that could accidentally let one through.
 *   * If the address is not registered at all it is a one-off destination and is permitted. That
 *     is not a loophole around the rule above: the rule is about what a *link* authorises, and an
 *     address the user has explicitly registered as watch-only is an address they have told us
 *     they do not control. Honouring that statement is the point.
 *   * Either way the address must not be the platform's, and that lookup spans every user.
 *     forge-pay's `isPlatformAddress` carries the reason: "paying a stranger's deposit address
 *     would credit THEM."
 */
async function resolveDestination(
  deps: WithdrawalDeps,
  userId: string,
  chain: ChainId,
  destination: string,
): Promise<{ address: string; key: string; walletId: string | null }> {
  const canonical = canonicaliseAddress(chain, destination)

  if (await isPlatformAddress(deps.sql, chain, deps.network, canonical.key)) {
    throw new WithdrawalError(
      'invalid_destination',
      'that address is held by this platform — withdraw to a wallet you control',
      422,
    )
  }

  const rows = await deps.sql<{ id: string; origin: string; status: string }[]>`
    select id, origin, status from wallets
     where user_id = ${userId} and chain = ${chain} and network = ${deps.network}
       and address_key = ${canonical.key}
  `
  const wallet = rows[0]
  if (!wallet) return { address: canonical.address, key: canonical.key, walletId: null }

  if (wallet.status !== 'active') {
    throw new WithdrawalError(
      'destination_not_active',
      `that wallet is ${wallet.status} and cannot receive a withdrawal`,
      422,
    )
  }
  if (!(await authorisationHolds(deps.sql, wallet.id, 'withdrawal_destination'))) {
    throw new WithdrawalError(
      'destination_not_authorised',
      'that wallet is not a verified withdrawal destination — verify it by signing a challenge, and grant it withdrawal_destination',
      403,
    )
  }
  return { address: canonical.address, key: canonical.key, walletId: wallet.id }
}

/**
 * Request a withdrawal.
 *
 * Returns the row as it stands after the reservation attempt, so a caller sees `queued` on success
 * and `failed` with a reason when the ledger refused — rather than an exception for one and a
 * body for the other.
 */
export async function requestWithdrawal(
  deps: WithdrawalDeps,
  input: RequestInput,
): Promise<{ withdrawal: WithdrawalRecord; replayed: boolean }> {
  if (!deps.withdrawalsEnabled) {
    throw new WithdrawalError('withdrawals_disabled', 'withdrawals are temporarily paused', 503)
  }

  const assetCode = input.assetCode.toUpperCase()
  const chain = chainForAsset(assetCode)
  if (chain === null) {
    throw new WithdrawalError(
      'not_withdrawable',
      `${assetCode} does not settle on a chain and cannot be withdrawn`,
      422,
    )
  }
  if (input.amount <= 0n) {
    throw new WithdrawalError('invalid_amount', 'amount must be positive', 400)
  }

  const destination = await resolveDestination(deps, input.userId, chain, input.destination)

  let fee: bigint
  try {
    fee = await deps.fees.quote(chain, deps.network, assetCode as AssetCode)
  } catch (err) {
    if (err instanceof FeeUnavailableError) {
      // A fee that cannot be quoted is a withdrawal that would have to be priced by guessing.
      throw new WithdrawalError('fee_unavailable', err.message, 503)
    }
    throw err
  }

  const decimals = chainSpec(assetCode as AssetCode).decimals
  const minimum = fee * BigInt(deps.minFeeMultiple)
  if (input.amount < minimum) {
    throw new WithdrawalError(
      'amount_too_small',
      `the smallest ${assetCode} withdrawal is ${formatAmount(minimum, decimals)} ${assetCode}, because the network fee for this payment is ${formatAmount(fee, decimals)} ${assetCode}`,
      422,
    )
  }

  const idempotencyKey = namespacedKey(input.userId, WITHDRAW_ROUTE, input.clientKey)
  // Deliberately excludes the fee: the same key with the same asset, amount and destination is a
  // retry, even if the network has repriced between the two attempts. forge-pay makes the same
  // choice and states the same reason.
  const requestHash = requestFingerprint({
    assetCode,
    network: deps.network,
    destination: destination.key,
    amount: input.amount,
  })

  const claim = await withIdempotency(deps.sql, {
    userId: input.userId,
    route: WITHDRAW_ROUTE,
    clientKey: input.clientKey,
    requestHash,
    run: async (tx) => {
      const id = uuidv7()
      await tx`
        insert into withdrawals (
          id, user_id, chain, network, asset_code, destination_address, destination_key,
          destination_wallet_id, amount, fee, net, state, idempotency_key
        )
        values (
          ${id}, ${input.userId}, ${chain}, ${deps.network}, ${assetCode},
          ${destination.address}, ${destination.key}, ${destination.walletId},
          ${input.amount.toString()}::numeric(78,0), ${fee.toString()}::numeric(78,0),
          ${(input.amount - fee).toString()}::numeric(78,0), 'requested', ${idempotencyKey}
        )
      `
      // Only the id is stored as the idempotent response. The row is the source of truth for
      // everything else, and storing a snapshot of it here would let a replay report `requested`
      // for a withdrawal that has since settled.
      return { withdrawalId: id }
    },
  })

  const settled = claim.replayed
    ? await requireWithdrawal(deps.sql, claim.result.withdrawalId)
    : await reserveAndQueue(deps, claim.result.withdrawalId, input)

  return { withdrawal: settled, replayed: claim.replayed }
}

/**
 * Reserve through the ledger, then queue and hand over.
 *
 * The ledger call carries the same idempotency key the row does, so a retry of this step is a
 * replay there rather than a second reservation. That is what makes the "claim first, reserve
 * second" ordering safe: the step that can be repeated is the step that is idempotent.
 */
async function reserveAndQueue(
  deps: WithdrawalDeps,
  withdrawalId: string,
  input: RequestInput,
): Promise<WithdrawalRecord> {
  const withdrawal = await requireWithdrawal(deps.sql, withdrawalId)
  if (withdrawal.state !== 'requested') return withdrawal

  let reservationEntryId: string
  try {
    const reservation = await deps.ledger.reserve({
      subject: `user:${withdrawal.userId}`,
      assetCode: withdrawal.assetCode,
      amount: BigInt(withdrawal.amount),
      actor: input.actor,
      correlationId: input.correlationId,
      idempotencyKey: `${withdrawal.id}:reserve`,
      kind: 'withdrawal_requested',
      description: `Withdrawal ${withdrawal.id} to ${withdrawal.destination}`,
      metadata: { withdrawalId: withdrawal.id, destination: withdrawal.destination },
    })
    reservationEntryId = reservation.entryId
  } catch (err) {
    if (err instanceof LedgerRefusedError) {
      // The ledger looked at the request and said no: insufficient funds, a frozen asset, an
      // account that cannot be posted to. **This is the branch that makes concurrent requests
      // safe.** Two requests for more than the balance both reach here; the ledger serialises
      // them and exactly one is refused, because the reservation is a posting against a real
      // account rather than a check against a number this service read a moment ago.
      //
      // The row is marked `failed` before the throw, so the refusal is durable: a client that
      // retries with the same key replays a `failed` withdrawal rather than reserving again.
      //
      // The ledger's CODE is carried through and its MESSAGE is not — see `refusalMessage`. Both
      // the durable row and the thrown error take the same sentence, because `failure_reason` is
      // read back by the owner through `GET /v1/withdrawals/:id` and a disclosure written there is
      // permanent in a way the 409 body is not.
      const message = refusalMessage(err.code, withdrawal.assetCode)
      await transition(deps, withdrawal.id, 'failed', {
        failureReason: `${err.code}: ${message}`,
      })
      throw new WithdrawalError(err.code, message, err.status)
    }
    // The ledger could not be reached. The row stays `requested`, which is exactly right: nothing
    // is known about whether the reservation landed, and the retry job re-runs this step with the
    // same key.
    throw err
  }

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const rows = await tx<WithdrawalRow[]>`
      update withdrawals
         set state = 'queued',
             reservation_entry_id = ${reservationEntryId},
             reserved_at = now(),
             queued_at = now(),
             updated_at = now()
       where id = ${withdrawal.id} and state = 'requested'
       returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) {
      // Another replica queued it. Read it back rather than failing: the reservation is idempotent
      // and the event has already been emitted by whoever won.
      const current = await tx<WithdrawalRow[]>`
        select ${tx.unsafe(COLUMNS)} from withdrawals where id = ${withdrawal.id}
      `
      return toWithdrawal(current[0]!)
    }

    const payload: WithdrawalRequestedPayload = {
      withdrawalId: row.id,
      userId: row.user_id,
      chain: row.chain as ChainId,
      network: row.network as Network,
      assetCode: row.asset_code as AssetCode,
      destination: row.destination_address,
      amount: row.amount,
      fee: row.fee,
      net: row.net,
      reservationEntryId,
      idempotencyKey: row.idempotency_key,
      requestedAt: row.requested_at.toISOString(),
    }
    emit({
      topic: WITHDRAWAL_REQUESTED,
      // Keyed on the withdrawal, so two withdrawals do not serialise against each other and two
      // events about one withdrawal stay in order.
      key: row.id,
      payload: payload as unknown as Record<string, unknown>,
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return toWithdrawal(row)
  })
}

/**
 * What the person who asked for the withdrawal is told when the ledger refuses it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **KEYED ON THE REFUSAL CODE. THE UPSTREAM'S MESSAGE IS NEVER PASSED THROUGH.**
 *
 * The code is the ledger's classification of the refusal and is a fact about this request. The
 * message is free text, written for whoever the ledger expected to read it next — and for one
 * refusal that reader is an operator, not the account holder.
 *
 * `asset_frozen` carries `asset_freezes.reason` verbatim inside `Error.message`, and that string is
 * the reconciliation diagnostic `ledger/src/reconcile.ts` builds for an operator: the estate's
 * TOTAL CUSTODY POSITION in the asset, the total observed on chain, the drift between the two, and
 * a per-bucket breakdown with address counts. Returning it answered a withdrawal request with the
 * platform's treasury position, and `failure_reason` stored it on a row the owner can read back for
 * ever, so sampling the endpoint across a freeze window yielded a time series of the estate's
 * holdings and address topology with no privileged access at all. The one thing it did convey to
 * the person reading it — that the books and the chain disagree about what the platform holds — is
 * a solvency signal delivered without framing to a user who has done nothing wrong.
 *
 * The freeze itself is correct and is not weakened here: halting withdrawals when the ledger cannot
 * prove it holds what it owes is the whole point of it. What changes is what is said about it.
 *
 * **The DEFAULT is the safe sentence, not the upstream text.** A refusal code the ledger adds
 * tomorrow therefore says nothing it should not, rather than leaking until somebody notices. No
 * detail is lost: the `LedgerRefusedError` is logged with the request's correlation id, and
 * `GET /reconciliation` on the ledger is where the freeze reason belongs and still lives.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function refusalMessage(code: string, assetCode: AssetCode): string {
  switch (code) {
    case 'asset_frozen':
      return (
        `withdrawals in ${assetCode} are paused while the platform reconciles its records. ` +
        'This is not a decision about your account, and your balance is unchanged.'
      )
    case 'insufficient_funds':
      return `there is not enough available ${assetCode} to cover this withdrawal`
    case 'idempotency_key_reuse':
      return 'this idempotency key was already used for a different withdrawal'
    default:
      return `this ${assetCode} withdrawal could not be reserved`
  }
}

/* ------------------------------------------------------------------ the state machine */

interface TransitionExtras {
  readonly failureReason?: string
  readonly txHash?: string
}

/**
 * Move a withdrawal's state.
 *
 * The `where state = ${from}` in the UPDATE is the concurrency control. A read-then-write would
 * let a settlement confirmation and a stuck sweep both read `queued`, both find their transition
 * legal, and the later write win — a withdrawal marked `stuck` whose payment has confirmed, whose
 * reservation an operator then releases, paying the user twice.
 */
export async function transition(
  deps: WithdrawalDeps,
  id: string,
  to: WithdrawalState,
  extras: TransitionExtras = {},
): Promise<WithdrawalRecord> {
  const current = await requireWithdrawal(deps.sql, id)
  if (current.state === to) return current
  if (!canTransition(current.state, to)) {
    throw new WithdrawalError(
      'illegal_transition',
      `a ${current.state} withdrawal cannot become ${to}`,
      409,
    )
  }
  const rows = await deps.sql<WithdrawalRow[]>`
    update withdrawals
       set state = ${to},
           updated_at = now(),
           failure_reason = coalesce(${extras.failureReason ?? null}, failure_reason),
           tx_hash = coalesce(${extras.txHash ?? null}, tx_hash),
           settled_at  = case when ${to} = 'settled'  then now() else settled_at end,
           failed_at   = case when ${to} = 'failed'   then now() else failed_at end,
           refunded_at = case when ${to} = 'refunded' then now() else refunded_at end
     where id = ${id} and state = ${current.state}
     returning ${deps.sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) {
    throw new WithdrawalError(
      'transition_raced',
      'the withdrawal changed state concurrently; read it again',
      409,
    )
  }
  return toWithdrawal(row)
}

/**
 * Settlement confirmed the payment.
 *
 * The reservation is *consumed*, not released: value leaves the user's `reserved` liability and
 * leaves the custody asset account, because the coin is genuinely gone from the chain. The whole
 * `amount` moves rather than `net`, and that is not a rounding decision — `net` went to the user
 * and `fee` went to the miners, but both left custody, so both must leave the books.
 */
export async function settleWithdrawal(
  deps: WithdrawalDeps,
  input: {
    readonly withdrawalId: string
    readonly txHash: string
    readonly correlationId: string
    readonly actor: Actor
  },
): Promise<WithdrawalRecord> {
  const withdrawal = await requireWithdrawal(deps.sql, input.withdrawalId)
  if (withdrawal.state === 'settled') return withdrawal

  const amount = BigInt(withdrawal.amount)
  await deps.ledger.postEntry({
    kind: 'withdrawal_settled',
    actor: input.actor,
    correlationId: input.correlationId,
    idempotencyKey: `${withdrawal.id}:settle`,
    description: `Withdrawal ${withdrawal.id} settled in ${input.txHash}`,
    metadata: { withdrawalId: withdrawal.id, txHash: input.txHash },
    postings: [
      {
        direction: 'debit',
        amount,
        assetCode: withdrawal.assetCode,
        sequence: 0,
        account: {
          subject: `user:${withdrawal.userId}`,
          assetCode: withdrawal.assetCode,
          purpose: 'reserved',
          type: 'liability',
        },
      },
      {
        direction: 'credit',
        amount,
        assetCode: withdrawal.assetCode,
        sequence: 1,
        account: {
          subject: 'custody',
          assetCode: withdrawal.assetCode,
          purpose: 'available',
          type: 'asset',
        },
      },
    ],
  })

  return transition(deps, withdrawal.id, 'settled', { txHash: input.txHash })
}

/**
 * Settlement could not send the payment.
 *
 * `refundable` is settlement's assertion that the transaction never reached the chain, and it is
 * the only thing that authorises a refund. "We do not know" is `stuck` and an operator, because
 * refunding a payment that actually landed pays the user twice — and that error is unrecoverable,
 * since the coin is already at an address the platform does not control.
 */
export async function failWithdrawal(
  deps: WithdrawalDeps,
  input: {
    readonly withdrawalId: string
    readonly reason: string
    readonly refundable: boolean
    readonly correlationId: string
    readonly actor: Actor
  },
): Promise<WithdrawalRecord> {
  const withdrawal = await requireWithdrawal(deps.sql, input.withdrawalId)
  if (!input.refundable) {
    return transition(deps, withdrawal.id, 'stuck', { failureReason: input.reason })
  }

  const failed = await transition(deps, withdrawal.id, 'failed', { failureReason: input.reason })
  return refundWithdrawal(deps, {
    withdrawalId: failed.id,
    correlationId: input.correlationId,
    actor: input.actor,
  })
}

/**
 * Return a failed withdrawal's funds by releasing its reservation.
 *
 * A release rather than a compensating credit. `releasePostings` in contracts-money is the exact
 * mirror of `reservePostings`, so the pair nets to nothing in the journal and an auditor reading
 * the account sees "held, then not held" rather than two unrelated movements to connect by hand.
 */
export async function refundWithdrawal(
  deps: WithdrawalDeps,
  input: {
    readonly withdrawalId: string
    readonly correlationId: string
    readonly actor: Actor
  },
): Promise<WithdrawalRecord> {
  const withdrawal = await requireWithdrawal(deps.sql, input.withdrawalId)
  if (withdrawal.state === 'refunded') return withdrawal
  if (withdrawal.reservationEntryId === null) {
    // Nothing was ever reserved, so there is nothing to give back. The row is marked refunded so
    // it leaves the open set rather than being retried for ever.
    return transition(deps, withdrawal.id, 'refunded')
  }

  await deps.ledger.release(withdrawal.reservationEntryId, {
    actor: input.actor,
    correlationId: input.correlationId,
    idempotencyKey: `${withdrawal.id}:refund`,
    description: `Withdrawal ${withdrawal.id} refunded`,
  })

  const refunded = await transition(deps, withdrawal.id, 'refunded')
  await withOutbox(deps.sql, deps.producer, async (_tx, emit) => {
    emit({
      topic: WITHDRAWAL_REFUNDED,
      key: refunded.id,
      payload: {
        withdrawalId: refunded.id,
        userId: refunded.userId,
        assetCode: refunded.assetCode,
        amount: refunded.amount,
        reason: refunded.failureReason,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
  })
  return refunded
}

/**
 * Withdrawals that have sat in a non-terminal state past the deadline.
 *
 * The deadline is not a guess: it is how long settlement is allowed to take before "in progress"
 * stops being a plausible explanation. Crossing it does not refund anything — the payment may have
 * landed — it moves the row to `stuck` and emits, so an operator is told rather than a reservation
 * quietly ageing. A `settling` withdrawal nobody is watching is forge-pay's failure mode, where
 * the only symptom is a balance a user cannot spend and cannot explain.
 */
export async function sweepStuck(deps: WithdrawalDeps): Promise<number> {
  const rows = await deps.sql<{ id: string; user_id: string }[]>`
    select id, user_id from withdrawals
     where state in ('queued','settling')
       and updated_at < now() - make_interval(mins => ${deps.stuckMinutes})
     order by updated_at
     limit 100
  `
  let moved = 0
  for (const row of rows) {
    const updated = await deps.sql<WithdrawalRow[]>`
      update withdrawals
         set state = 'stuck',
             failure_reason = coalesce(failure_reason, 'no settlement within the deadline'),
             updated_at = now()
       where id = ${row.id} and state in ('queued','settling')
       returning ${deps.sql.unsafe(COLUMNS)}
    `
    if (updated.length === 0) continue
    moved += 1
    await withOutbox(deps.sql, deps.producer, async (_tx, emit) => {
      emit({
        topic: WITHDRAWAL_STUCK,
        key: row.id,
        payload: {
          withdrawalId: row.id,
          userId: row.user_id,
          stuckMinutes: deps.stuckMinutes,
        },
        actor: `service:${deps.producer}`,
      })
    })
  }
  return moved
}

/** Withdrawals claimed but never reserved. The retry job finishes what a crash interrupted. */
export async function unreservedWithdrawals(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from withdrawals
     where state = 'requested' and requested_at < now() - make_interval(secs => 30)
     order by requested_at
     limit ${limit}
  `
  return rows.map((row) => row.id)
}

/* ------------------------------------------------------------------ reads */

export async function findWithdrawal(
  sql: Db | Tx,
  id: string,
): Promise<WithdrawalRecord | null> {
  const rows = await sql<WithdrawalRow[]>`
    select ${sql.unsafe(COLUMNS)} from withdrawals where id = ${id}
  `
  const row = rows[0]
  return row ? toWithdrawal(row) : null
}

async function requireWithdrawal(sql: Db, id: string): Promise<WithdrawalRecord> {
  const found = await findWithdrawal(sql, id)
  if (!found) throw new WithdrawalError('withdrawal_not_found', `no withdrawal ${id}`, 404)
  return found
}

export async function listWithdrawals(
  sql: Db,
  userId: string,
  limit: number,
  cursor: string | null,
): Promise<{ withdrawals: readonly WithdrawalRecord[]; nextCursor: string | null }> {
  const rows = await sql<WithdrawalRow[]>`
    select ${sql.unsafe(COLUMNS)} from withdrawals
     where user_id = ${userId}
       and (${cursor}::uuid is null or id < ${cursor}::uuid)
     order by id desc
     limit ${limit + 1}
  `
  const page = rows.slice(0, limit)
  return {
    withdrawals: page.map(toWithdrawal),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}
