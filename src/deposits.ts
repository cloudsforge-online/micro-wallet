/**
 * Deposit address assignment, rotation, and **the credit decision**.
 *
 * ## The division of labour, which is the whole design
 *
 * The indexer watches the chain and reports. **This service decides whether that report becomes
 * money.** The indexer's own header states the reason: "a service that both watches the chain and
 * moves the money is a service where a bug in the first half spends the second half." So
 * `indexer.deposit.confirmed` is evidence, not an instruction, and every clause in `decide()`
 * below is this service re-asking a question the indexer already answered — including the
 * confirmation depth, which it re-checks against the same exact-pinned `contracts-chain` constant
 * rather than trusting the number in the payload.
 *
 * ## Exactly once, twice over
 *
 * A redelivered event must credit once. Two independent mechanisms guarantee it and **neither is
 * redundant**:
 *
 *   1. `withInbox` on `(topic, event_id)` — stops a *redelivery of the same event*.
 *   2. `deposit_credits.credit_key`, unique, derived from `(chain, network, txHash, logIndex)` —
 *      stops *two different events describing the same on-chain movement*. That is not
 *      hypothetical: the indexer re-emits `confirmed` when a reorg drops a transaction and it
 *      later returns to depth, and those are two events with two ids and one movement.
 *
 * The same `credit_key` is the idempotency key sent to the ledger, so the third mechanism — the
 * ledger's own — keys on the same value and cannot disagree with this one.
 *
 * ## Rotation is a new row, never an edit
 *
 * 04-domain-model §3.4 says why, and forge-pay shows what the alternative costs. There, the
 * address is a column on `deposit_addresses` and the *same row* carries `last_seen`, the observed
 * high-water mark. Rotating the address leaves the mark from the old one, so every probe
 * afterwards reads a balance below the mark, `observeDeposit` reports a `regression`, and
 * crediting stops — permanently, for that user and that coin, until an operator reconciles it by
 * hand. Here the assignment is its own row, a rotation inserts a new one with `supersedes_id` set,
 * and the old one keeps crediting for as long as money keeps arriving at it.
 */

import {
  type AssetCode,
  type Network,
  chainSpec,
  explorerTxUrl,
  formatAmount,
  isConfirmed,
  txUrn,
} from '@cloudsforge/contracts-chain'
import type { Actor } from '@cloudsforge/contracts-money'
import { canonicaliseAddress, chainForAsset, type ChainId } from './addresses.ts'
import { uuidv7 } from './ids.ts'
import { CustodyRefusedError, type CustodyAddress, type CustodyClient } from './custodyclient.ts'
import type { IndexerClient } from './indexerclient.ts'
import type { LedgerClient } from './ledgerclient.ts'
import {
  DEPOSIT_ADDRESS_ASSIGNED,
  DEPOSIT_CREDITED,
  withInbox,
  withOutbox,
  writeEvent,
  type Db,
  type Tx,
} from './outbox.ts'
import { insertWallet, type WalletRecord } from './wallets.ts'

export class DepositError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'DepositError'
    this.code = code
    this.status = status
  }
}

export interface AssignmentRecord {
  readonly id: string
  readonly userId: string
  readonly assetCode: AssetCode
  readonly chain: ChainId
  readonly network: Network
  readonly walletId: string
  readonly address: string
  readonly custodyKeyUrn: string
  readonly status: 'active' | 'rotated' | 'retired'
  readonly assignedAt: string
  readonly rotatedAt: string | null
  readonly supersedesId: string | null
  /** Null until the indexer has been told to watch it. An unwatched address produces no events. */
  readonly watchedAt: string | null
}

interface AssignmentRow {
  readonly id: string
  readonly user_id: string
  readonly asset_code: string
  readonly chain: string
  readonly network: string
  readonly wallet_id: string
  readonly address: string
  readonly address_key: string
  readonly custody_key_urn: string
  readonly status: string
  readonly assigned_at: Date
  readonly rotated_at: Date | null
  readonly supersedes_id: string | null
  readonly watched_at: Date | null
}

const ASSIGNMENT_COLUMNS = `id, user_id, asset_code, chain, network, wallet_id, address,
                            address_key, custody_key_urn, status, assigned_at, rotated_at,
                            supersedes_id, watched_at`

function toAssignment(row: AssignmentRow): AssignmentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    assetCode: row.asset_code as AssetCode,
    chain: row.chain as ChainId,
    network: row.network as Network,
    walletId: row.wallet_id,
    address: row.address,
    custodyKeyUrn: row.custody_key_urn,
    status: row.status as AssignmentRecord['status'],
    assignedAt: row.assigned_at.toISOString(),
    rotatedAt: row.rotated_at ? row.rotated_at.toISOString() : null,
    supersedesId: row.supersedes_id,
    watchedAt: row.watched_at ? row.watched_at.toISOString() : null,
  }
}

export interface DepositDeps {
  readonly sql: Db
  readonly producer: string
  readonly network: Network
  readonly custody: CustodyClient
  readonly indexer: IndexerClient
  readonly ledger: LedgerClient
}

/* ------------------------------------------------------------------ assignment */

export interface AssignInput {
  readonly userId: string
  readonly assetCode: string
  readonly correlationId: string
  /** Forces a new assignment even though an active one exists. See `rotate`. */
  readonly rotate?: boolean
}

/**
 * The active deposit assignment for a `(user, asset, network)`, minting one if there is none.
 *
 * Find-or-create rather than always-create: a user who taps "deposit" twice must get one address,
 * not two, because the second would be an address nobody has told them about and money sent to it
 * would still be theirs but nobody would be looking. The custody call carries an idempotency key
 * derived from the same triple, so even a retry that races past the row check gets one address —
 * a sentence that was aspirational until custody's migration 6 and is now enforced by a unique
 * index on custody's own table.
 */
export async function assignDepositAddress(
  deps: DepositDeps,
  input: AssignInput,
): Promise<AssignmentRecord> {
  const assetCode = input.assetCode.toUpperCase()
  const chain = chainForAsset(assetCode)
  if (chain === null) {
    // SHARD lands here, and must: a Shard deposit address would be an address on no chain.
    throw new DepositError(
      'not_depositable',
      `${assetCode} does not settle on a chain and has no deposit address`,
      400,
    )
  }

  if (!input.rotate) {
    const existing = await activeAssignment(deps.sql, input.userId, assetCode, deps.network)
    if (existing) {
      // Registration is idempotent on the indexer's side, so a previously-unwatched assignment is
      // repaired on the next read rather than waiting for the job's next pass. Re-read afterwards
      // rather than returning the snapshot: `watchedAt` is the field a caller checks to know
      // whether this address will ever produce a deposit event, and a stale null there is a
      // dashboard reporting a problem that has just been fixed.
      if (existing.watchedAt === null) {
        await watch(deps, existing)
        return (await findAssignment(deps.sql, existing.id)) ?? existing
      }
      return existing
    }
  }

  const previous = input.rotate
    ? await activeAssignment(deps.sql, input.userId, assetCode, deps.network)
    : null

  /*
   * THE ASSIGNMENT ID IS MINTED BEFORE THE ADDRESS IS, BECAUSE CUSTODY HAS TO BE TOLD IT.
   *
   * `orderId` is one of the five fields custody compares character for character before it will
   * sign anything with this key (SD-09, `12-security-decisions.md:398`; the comparison is at
   * `custody/src/gates.ts:182`). settlement must restate it to sweep the address and has nothing
   * to derive it from — "a guessed binding is a sweep refused every tick for ever"
   * (`settlement/src/server.ts:739`) — so the value has to be one this service can still produce
   * for this address indefinitely. The assignment's own primary key is that value, and using it
   * means the binding needs no column of its own and cannot drift from the row it belongs to.
   *
   * The order of the two writes is the same trade custody makes when it writes the key blob before
   * the row that names it (`custody/src/keys.ts:88-98`). A crash between them leaves an address
   * custody holds and this service never filed: one unused key, at an address nobody was told and
   * nothing can be sent to. The other order — the row first, then the mint — would publish an
   * assignment naming an address that does not exist.
   */
  const id = uuidv7()

  /*
   * THE KEY IS DERIVED FROM THE POSITION IN THE CHAIN OF ASSIGNMENTS, NOT FROM `id`.
   *
   * `id` is minted fresh on every attempt, so keying on it would give two racing calls two keys and
   * custody two requests. The triple plus the assignment being SUPERSEDED is stable across attempts
   * and different across rotations: retrying one rotation carries one key, and rotating twice
   * carries two. Custody honours it now (its migration 6) and the find-or-create check above is no
   * longer the only thing between a retry and a second address.
   *
   * `'first'` is reused only if a (user, asset, network) can return to having no assignment at all,
   * and it cannot: a rotation marks the old row `'rotated'` and nothing in this service ever writes
   * `'retired'` to an assignment.
   */
  const idempotencyKey = `wallet:deposit:${input.userId}:${assetCode}:${deps.network}:${previous?.id ?? 'first'}`

  let minted: CustodyAddress
  try {
    minted = await deps.custody.createAddress({
      userId: input.userId,
      chain,
      network: deps.network,
      purpose: 'deposit',
      orderId: id,
      idempotencyKey,
    })
  } catch (err) {
    /*
     * A 409 MEANS SOMEBODY ELSE IS ALREADY DOING THIS, AND THEY WON.
     *
     * Two calls that both got past the find-or-create check above — a user tapping "deposit" twice
     * — mint two assignment ids and therefore send custody two DIFFERENT `orderId`s under one key.
     * Custody refuses the second rather than answering it with the first one's address, because
     * that address is bound to the first one's order and settlement would restate this one's and be
     * refused for ever. So the loser's job is not to retry: it is to go and read what the winner
     * wrote, which is the address this call was always going to return.
     *
     * If the winner has not committed yet the refusal is re-raised, and the caller's own retry
     * takes the find-or-create path. That is a moment of unavailability rather than a second
     * address, which is the right way round.
     */
    if (err instanceof CustodyRefusedError && err.code === 'idempotency_conflict') {
      const winner = await activeAssignment(deps.sql, input.userId, assetCode, deps.network)
      if (winner) return winner
    }
    throw err
  }
  // Re-canonicalised rather than trusted: custody's spelling and this service's comparison form
  // must be produced by one function, or the `address_key` written here will not match the one a
  // deposit event is looked up by.
  const canonical = canonicaliseAddress(chain, minted.address)

  const assignment = await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    if (previous) {
      // Marked rotated, never deleted and never rewritten. The old address is still ours, is still
      // watched, and money arriving at it is still credited — which is the entire point.
      await tx`
        update deposit_address_assignments
           set status = 'rotated', rotated_at = now()
         where id = ${previous.id} and status = 'active'
      `
    }

    const { wallet } = await insertWallet(tx, deps.producer, {
      userId: input.userId,
      origin: 'managed',
      chain,
      network: deps.network,
      address: canonical.address,
      label: `${assetCode} deposit`,
      status: 'active',
      custodyKeyUrn: minted.custodyKeyUrn,
      actor: `service:${deps.producer}`,
      correlationId: input.correlationId,
    })

    const rows = await tx<AssignmentRow[]>`
      insert into deposit_address_assignments (
        id, user_id, asset_code, chain, network, wallet_id, address, address_key,
        custody_key_urn, status, supersedes_id
      )
      values (
        ${id}, ${input.userId}, ${assetCode}, ${chain}, ${deps.network}, ${wallet.id},
        ${canonical.address}, ${canonical.key}, ${minted.custodyKeyUrn}, 'active',
        ${previous?.id ?? null}
      )
      returning ${tx.unsafe(ASSIGNMENT_COLUMNS)}
    `
    const row = rows[0]!
    emit({
      topic: DEPOSIT_ADDRESS_ASSIGNED,
      key: `${row.chain}:${row.network}:${row.address_key}`,
      payload: {
        assignmentId: row.id,
        userId: row.user_id,
        assetCode: row.asset_code,
        chain: row.chain,
        network: row.network,
        address: row.address,
        walletId: row.wallet_id,
        scheme: minted.scheme,
        supersedesId: row.supersedes_id,
      },
      actor: `service:${deps.producer}`,
      correlationId: input.correlationId,
    })
    return toAssignment(row)
  })

  await watch(deps, assignment)
  return (await findAssignment(deps.sql, assignment.id)) ?? assignment
}

/**
 * Register an assignment with the indexer.
 *
 * Failures are swallowed and left to the retry job. The alternative — failing the request — would
 * mean an address that exists in custody and in this database but was never handed to the user,
 * and re-requesting would find the row and return it *still unwatched*. Recording `watched_at`
 * only on success is what makes the job's "everything with a null" query correct.
 */
async function watch(deps: DepositDeps, assignment: AssignmentRecord): Promise<void> {
  try {
    await deps.indexer.watch(
      assignment.chain,
      assignment.network,
      assignment.address,
      `deposit:${assignment.userId}`,
    )
    await deps.sql`
      update deposit_address_assignments set watched_at = now() where id = ${assignment.id}
    `
  } catch {
    // Deliberately silent here; `jobs.ts` logs and retries. A log line per failed registration on
    // a busy provisioning path would drown the one that matters, which is the job giving up.
  }
}

export async function activeAssignment(
  sql: Db | Tx,
  userId: string,
  assetCode: string,
  network: Network,
): Promise<AssignmentRecord | null> {
  const rows = await sql<AssignmentRow[]>`
    select ${sql.unsafe(ASSIGNMENT_COLUMNS)} from deposit_address_assignments
     where user_id = ${userId} and asset_code = ${assetCode} and network = ${network}
       and status = 'active'
  `
  const row = rows[0]
  return row ? toAssignment(row) : null
}

export async function findAssignment(sql: Db, id: string): Promise<AssignmentRecord | null> {
  const rows = await sql<AssignmentRow[]>`
    select ${sql.unsafe(ASSIGNMENT_COLUMNS)} from deposit_address_assignments where id = ${id}
  `
  const row = rows[0]
  return row ? toAssignment(row) : null
}

export async function listAssignments(
  sql: Db,
  userId: string,
  network: Network,
): Promise<readonly AssignmentRecord[]> {
  const rows = await sql<AssignmentRow[]>`
    select ${sql.unsafe(ASSIGNMENT_COLUMNS)} from deposit_address_assignments
     where user_id = ${userId} and network = ${network}
     order by id desc
  `
  return rows.map(toAssignment)
}

export async function unwatchedAssignments(
  sql: Db,
  limit: number,
): Promise<readonly AssignmentRecord[]> {
  const rows = await sql<AssignmentRow[]>`
    select ${sql.unsafe(ASSIGNMENT_COLUMNS)} from deposit_address_assignments
     where watched_at is null
     order by assigned_at
     limit ${limit}
  `
  return rows.map(toAssignment)
}

/** Exported for the job, which repairs registrations without going through the request path. */
export async function watchAssignment(
  deps: DepositDeps,
  assignment: AssignmentRecord,
): Promise<void> {
  await deps.indexer.watch(
    assignment.chain,
    assignment.network,
    assignment.address,
    `deposit:${assignment.userId}`,
  )
  await deps.sql`
    update deposit_address_assignments set watched_at = now() where id = ${assignment.id}
  `
}

/* ------------------------------------------------------------------ crediting */

/**
 * The payload of `indexer.deposit.confirmed`, as the indexer builds it in `evm.ts`.
 *
 * Everything here is treated as a claim to be checked, not a fact to be acted on. `confirmations`
 * in particular is re-tested against `contracts-chain` rather than trusted: it is the number the
 * indexer computed from *its* tip at *its* moment, and a stale or wrong one is the single input
 * that could credit money too early.
 */
export interface DepositEventPayload {
  readonly chain: string
  readonly network: string
  readonly address: string
  readonly direction: string
  readonly assetCode: string
  readonly assetKind: string
  readonly tokenAddress: string | null
  /** Smallest units, as a decimal string. JSON has no integer wide enough for a uint256. */
  readonly amount: string
  readonly txHash: string
  readonly logIndex: number | null
  readonly blockHeight: number
  readonly confirmations: number | null
}

/**
 * The identity of one credit: `(chain, network, txHash, logIndex)`.
 *
 * A native transfer has no log, so `logIndex` is `null` and is spelled `native` here rather than
 * left to produce a key with an empty segment. Two movements in one transaction — a native
 * transfer and a token transfer to the same address — differ in that segment and are two credits,
 * which is correct.
 *
 * **No part of this is a balance or a total.** forge-pay had to derive a synthetic id from the
 * observed balance total, with a two-hundred-line comment about the one mechanism that could walk
 * that total backwards, because its probes read a balance rather than a transaction list. A real
 * transaction hash removes the entire problem.
 */
export function depositCreditKey(
  chain: string,
  network: string,
  txHash: string,
  logIndex: number | null,
): string {
  return `wallet:deposit:${chain}:${network}:${txHash.toLowerCase()}:${logIndex ?? 'native'}`
}

export type CreditDecision =
  | { readonly kind: 'credited'; readonly creditId: string; readonly creditKey: string }
  /** Already on file. The redelivery path, and the one this service is measured on. */
  | { readonly kind: 'duplicate'; readonly creditKey: string }
  | { readonly kind: 'ignored'; readonly reason: string }

export interface CreditInput {
  readonly eventId: string
  readonly topic: string
  readonly payload: DepositEventPayload
  readonly correlationId: string
}

/**
 * Consume one `indexer.deposit.confirmed` and decide.
 *
 * The local claim commits first and the ledger posting follows. That ordering is deliberate and it
 * is not the obvious one, so it is worth stating why it is right:
 *
 *   * The alternative — post to the ledger *inside* the inbox transaction — holds a database
 *     transaction open across a network call to another service. Under any load that is a pool
 *     exhausted by connections waiting on HTTP, and under a ledger outage it is every connection
 *     in the pool held for the full deadline.
 *   * Committing the claim first means a crash between the two leaves a credit row with no ledger
 *     entry. That is a *visible, queryable, retriable* state — `pendingCredits` finds it and
 *     `postCredit` finishes it — and the retry is safe because the ledger dedupes on the same
 *     `credit_key`.
 *   * The reverse failure, a ledger entry with no local row, would be money credited that this
 *     service does not know it credited, and the next redelivery would credit again. That is the
 *     one outcome this ordering makes impossible.
 */
export async function handleDepositConfirmed(
  deps: DepositDeps,
  input: CreditInput,
): Promise<CreditDecision> {
  const outcome = await withInbox(deps.sql, input.topic, input.eventId, async (tx) =>
    claimCredit(tx, deps, input),
  )
  if (outcome.status === 'duplicate') {
    return { kind: 'duplicate', creditKey: depositCreditKeyOf(input.payload) }
  }
  const decision = outcome.value
  if (decision.kind === 'credited') {
    // Inline on the happy path so a deposit is credited in the ledger within milliseconds of the
    // event arriving; the job is the safety net, not the mechanism.
    await postCredit(deps, decision.creditId, input.correlationId)
  }
  return decision
}

function depositCreditKeyOf(payload: DepositEventPayload): string {
  return depositCreditKey(payload.chain, payload.network, payload.txHash, payload.logIndex)
}

/**
 * Decide, and write the claim.
 *
 * Every refusal returns `ignored` with a reason rather than throwing. A throw would roll back the
 * inbox row, and the event would be redelivered for ever — an event this service has correctly
 * decided not to act on must be *consumed*, not retried. The reason is logged and counted, which
 * is how "deposits to an address we do not know about" becomes a number on a dashboard instead of
 * a mystery.
 */
async function claimCredit(
  tx: Tx,
  deps: DepositDeps,
  input: CreditInput,
): Promise<CreditDecision> {
  const payload = input.payload

  if (payload.direction !== 'in') return { kind: 'ignored', reason: 'outbound_movement' }
  if (payload.network !== deps.network) {
    // A deposit on the network this deployment does not settle on. Refused rather than credited
    // against the wrong pot — 00-current-state §3.5, the XRP address that exists on both.
    return { kind: 'ignored', reason: 'wrong_network' }
  }
  if (payload.assetKind !== 'native') {
    // A token transfer to a deposit address. The amount is denominated in a token whose decimals
    // this service does not know and whose ledger asset code is `TOKEN:<urn>`, which needs the
    // mint's registry. Crediting it as the native asset would be off by a factor of 10^12 for a
    // six-decimal stablecoin.
    return { kind: 'ignored', reason: 'token_deposit_unsupported' }
  }

  const chain = payload.chain
  const asset = chainForAsset(payload.assetCode.toUpperCase())
  if (asset === null || asset !== chain) {
    return { kind: 'ignored', reason: 'asset_chain_mismatch' }
  }

  const assetCode = payload.assetCode.toUpperCase() as AssetCode
  // **Re-checked, not trusted.** `isConfirmed` reads the depth from the exact-pinned
  // contracts-chain, which is the same constant the indexer used — so this can only ever disagree
  // if the payload's number is wrong, which is precisely the case worth catching.
  const confirmations = payload.confirmations ?? 0
  if (!isConfirmed(assetCode, confirmations)) {
    return { kind: 'ignored', reason: 'below_confirmation_depth' }
  }

  let amount: bigint
  try {
    amount = BigInt(payload.amount)
  } catch {
    return { kind: 'ignored', reason: 'unparseable_amount' }
  }
  if (amount <= 0n) return { kind: 'ignored', reason: 'non_positive_amount' }

  const addressKey = canonicaliseAddress(chain as ChainId, payload.address).key
  // Every assignment ever made for this address, not just the active one. A rotated address is
  // still ours and money arriving at it is still the user's — this is the clause that rotation
  // exists to make possible.
  const rows = await tx<AssignmentRow[]>`
    select ${tx.unsafe(ASSIGNMENT_COLUMNS)} from deposit_address_assignments
     where chain = ${chain} and network = ${payload.network} and address_key = ${addressKey}
     order by assigned_at desc
     limit 1
  `
  const assignment = rows[0]
  if (!assignment) return { kind: 'ignored', reason: 'unknown_address' }
  if (assignment.asset_code !== assetCode) {
    return { kind: 'ignored', reason: 'asset_assignment_mismatch' }
  }

  const creditKey = depositCreditKeyOf(payload)
  const id = uuidv7()
  const inserted = await tx<{ id: string }[]>`
    insert into deposit_credits (
      id, user_id, assignment_id, wallet_id, chain, network, address_key, asset_code, amount,
      tx_hash, log_index, block_height, confirmations, credit_key
    )
    values (
      ${id}, ${assignment.user_id}, ${assignment.id}, ${assignment.wallet_id}, ${chain},
      ${payload.network}, ${addressKey}, ${assetCode}, ${amount.toString()}::numeric(78,0),
      ${payload.txHash}, ${payload.logIndex}, ${payload.blockHeight}, ${confirmations},
      ${creditKey}
    )
    on conflict (credit_key) do nothing
    returning id
  `
  // The second belt fired: a different event describing a movement already credited. Not an
  // error — a reorg that put a transaction back at depth produces exactly this.
  if (inserted.length === 0) return { kind: 'duplicate', creditKey }

  return { kind: 'credited', creditId: id, creditKey }
}

interface CreditRow {
  readonly id: string
  readonly user_id: string
  readonly chain: string
  readonly network: string
  readonly asset_code: string
  readonly amount: string
  readonly tx_hash: string
  readonly log_index: number | null
  readonly block_height: string
  readonly confirmations: number
  readonly credit_key: string
  readonly ledger_entry_id: string | null
  readonly wallet_id: string
}

const CREDIT_COLUMNS = `id, user_id, chain, network, asset_code, amount::text as amount, tx_hash,
                        log_index, block_height, confirmations, credit_key, ledger_entry_id,
                        wallet_id`

/**
 * Post a claimed credit to the ledger and record the entry it produced.
 *
 * **The entry is the double-entry pair 04-domain-model §2 requires**: a debit to the custody asset
 * account (we now hold more coin on chain) and a credit to the user's liability account (we now
 * owe them more). The entry balances because those are the same number, which is the whole of the
 * sign convention in `contracts-money`'s `normalBalance`.
 *
 * forge-pay writes no ledger row at all for a coin deposit — `coin_balances.amount` is simply
 * incremented — so a credited deposit there leaves no accounting trace and nothing can check it.
 */
export async function postCredit(
  deps: DepositDeps,
  creditId: string,
  correlationId: string,
): Promise<void> {
  const rows = await deps.sql<CreditRow[]>`
    select ${deps.sql.unsafe(CREDIT_COLUMNS)} from deposit_credits where id = ${creditId}
  `
  const credit = rows[0]
  if (!credit) throw new DepositError('credit_not_found', `no deposit credit ${creditId}`, 404)
  if (credit.ledger_entry_id !== null) return

  const assetCode = credit.asset_code as AssetCode
  const amount = BigInt(credit.amount)
  const actor: Actor = `service:${deps.producer}`

  const entry = await deps.ledger.postEntry({
    kind: 'deposit_credited',
    actor,
    correlationId,
    // The same key the local row is deduped on, so the two services cannot disagree about whether
    // this movement has been credited.
    idempotencyKey: credit.credit_key,
    description: `Deposit ${credit.tx_hash}`,
    metadata: {
      chain: credit.chain,
      network: credit.network,
      txHash: credit.tx_hash,
      txUrn: txUrn(assetCode, credit.network as Network, credit.tx_hash),
      explorerUrl: explorerTxUrl(assetCode, credit.network as Network, credit.tx_hash) ?? '',
      blockHeight: credit.block_height,
      confirmations: credit.confirmations,
      walletId: credit.wallet_id,
    },
    postings: [
      {
        direction: 'debit',
        amount,
        assetCode,
        sequence: 0,
        // An asset account: coin arriving in a custody wallet is a debit to custody, and the sum
        // of these is one half of the reconciliation invariant.
        account: { subject: 'custody', assetCode, purpose: 'available', type: 'asset' },
      },
      {
        direction: 'credit',
        amount,
        assetCode,
        sequence: 1,
        // A liability: a user's balance is money we owe them, so crediting a deposit increases
        // our obligation. This reads backwards to anyone thinking of a bank statement, and
        // `normalBalance` in contracts-money is the one place that settles it.
        account: {
          subject: `user:${credit.user_id}`,
          assetCode,
          purpose: 'available',
          type: 'liability',
        },
      },
    ],
  })

  await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    const updated = await tx<{ id: string }[]>`
      update deposit_credits set ledger_entry_id = ${entry.id}
       where id = ${creditId} and ledger_entry_id is null
       returning id
    `
    // Another replica finished it first. The ledger deduped, so no second entry exists; there is
    // simply nothing left to announce.
    if (updated.length === 0) return
    emit({
      topic: DEPOSIT_CREDITED,
      key: credit.wallet_id,
      payload: {
        creditId,
        userId: credit.user_id,
        walletId: credit.wallet_id,
        assetCode,
        amount: credit.amount,
        amountFormatted: formatAmount(amount, chainSpec(assetCode).decimals),
        chain: credit.chain,
        network: credit.network,
        txHash: credit.tx_hash,
        txUrn: txUrn(assetCode, credit.network as Network, credit.tx_hash),
        explorerUrl: explorerTxUrl(assetCode, credit.network as Network, credit.tx_hash),
        confirmations: credit.confirmations,
        ledgerEntryId: entry.id,
      },
      actor,
      correlationId,
    })
  })
}

/** Credits whose ledger posting has not landed. The retry job's whole input. */
export async function pendingCredits(sql: Db, limit: number): Promise<readonly string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from deposit_credits where ledger_entry_id is null order by id limit ${limit}
  `
  return rows.map((row) => row.id)
}

export interface DepositCreditView {
  readonly id: string
  readonly assetCode: string
  readonly amount: string
  readonly amountFormatted: string
  readonly chain: string
  readonly network: string
  readonly txHash: string
  readonly txUrn: string
  readonly explorerUrl: string | null
  readonly confirmations: number
  readonly credited: boolean
}

/** A page of a user's credited deposits, newest first. Keyset on `id`, which is UUIDv7. */
export async function listCredits(
  sql: Db,
  userId: string,
  limit: number,
  cursor: string | null,
): Promise<{ credits: readonly DepositCreditView[]; nextCursor: string | null }> {
  const rows = await sql<CreditRow[]>`
    select ${sql.unsafe(CREDIT_COLUMNS)} from deposit_credits
     where user_id = ${userId}
       and (${cursor}::uuid is null or id < ${cursor}::uuid)
     order by id desc
     limit ${limit + 1}
  `
  const page = rows.slice(0, limit)
  return {
    credits: page.map((row) => {
      const assetCode = row.asset_code as AssetCode
      return {
        id: row.id,
        assetCode: row.asset_code,
        amount: row.amount,
        amountFormatted: formatAmount(BigInt(row.amount), chainSpec(assetCode).decimals),
        chain: row.chain,
        network: row.network,
        txHash: row.tx_hash,
        txUrn: txUrn(assetCode, row.network as Network, row.tx_hash),
        explorerUrl: explorerTxUrl(assetCode, row.network as Network, row.tx_hash),
        confirmations: row.confirmations,
        // False while the ledger posting is still outstanding. Shown rather than hidden: a user
        // whose deposit is detected but not yet in their balance deserves to see that state
        // rather than an unexplained gap.
        credited: row.ledger_entry_id !== null,
      }
    }),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}

/**
 * Write an event without a domain change.
 *
 * Used by the job when it gives up on an assignment registration, so an operator's alert is an
 * event on the bus rather than a log line somebody has to be looking at.
 */
export async function emitBare(
  sql: Db,
  producer: string,
  topic: string,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await writeEvent(tx, producer, { topic, key, payload })
    return { done: true }
  })
}
