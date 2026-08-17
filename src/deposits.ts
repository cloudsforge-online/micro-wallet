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
import { chainTokenAssetCode } from '@cloudsforge/contracts-money'
import { ON_CHAIN_ASSETS } from '@cloudsforge/contracts-chain'
import type { Metrics } from '@cloudsforge/telemetry'
import {
  CHAIN_IDS,
  assetOf,
  canonicaliseAddress,
  chainForAsset,
  isChainId,
  type ChainId,
} from './addresses.ts'
import { uuidv7 } from './ids.ts'
import { CustodyRefusedError, type CustodyAddress, type CustodyClient } from './custodyclient.ts'
import type { IndexerClient } from './indexerclient.ts'
import {
  unobservableDetail,
  type ChainObservability,
  type UnobservableReason,
} from './observability.ts'
import type { LedgerClient } from './ledgerclient.ts'
import {
  DEPOSIT_ADDRESS_ASSIGNED,
  DEPOSIT_CREDITED,
  DEPOSIT_TOKEN_UNCREDITED,
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
  /**
   * Whether this estate will take a deposit on the chain an address would be on. TWO questions,
   * composed in `index.ts` and both answered from configuration rather than from a list here: can
   * it SEE the chain (an address nothing watches is money that disappears with no error on either
   * side) and can it SEND the chain's own coin back out (an address it can watch and cannot spend
   * from is a balance nobody can withdraw — micro-org#373 §6.1). See `observability.ts`.
   */
  readonly observability: ChainObservability
  /**
   * The same two questions, asked the way a CATALOGUE has to ask them — `chainAvailability` rather
   * than `payableChainsOnly`. micro-org#481.
   *
   * It reaches the identical verdict and differs only in the reason it can give, because the gate
   * above short-circuits before consulting the indexer and therefore cannot tell "we do not follow
   * this chain" from "we follow it and cannot pay it out". That short circuit is right for
   * `assignDepositAddress`, which is a per-user path where the answer cannot change the outcome, and
   * wrong for `depositableAssets`, whose whole output is the reason.
   *
   * Two fields rather than one port used two ways, so that a future edit to either cannot silently
   * change the other: the gate is the thing that must never loosen, and it is named separately from
   * the thing that only describes.
   */
  readonly availability: ChainObservability
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
 * **Refuse a deposit address for an asset this estate cannot observe.**
 *
 * `503`, not `400`: nothing about the request is malformed, and the answer changes the moment an
 * operator configures a provider — which is what a 5xx says and a 4xx does not. The message names
 * the asset and says the state is temporary, because from the person's side that is the whole of
 * what is true and actionable; which chains an indexer follows is not their problem to solve.
 *
 * `not_followed`, `not_retrievable` and `unknown` are separated on the WIRE, not just in the log.
 * They are three different facts — "nothing here watches that chain", "we watch it and could not
 * send anything back out of it", "we could not confirm either right now" — and a support
 * conversation that cannot tell them apart is one where "try again later" is advice for the third
 * and a lie for the other two.
 */
async function assertObservable(
  deps: DepositDeps,
  chain: ChainId,
  assetCode: string,
): Promise<void> {
  const observation = await deps.observability.observe(chain, deps.network)
  if (observation.observable) return
  // The three sentences live in `observability.ts` and are shared with `depositableAssets`, so the
  // catalogue that says an asset is not offered and the refusal somebody gets when they ask for it
  // anyway cannot drift into two different explanations of one fact. micro-org#481.
  if (observation.reason === 'not_retrievable') {
    // Separate from `asset_not_observable` on the wire for the same reason those two are separate
    // from each other: it is a different fact about the deployment. This estate has stated no way
    // to send anything back out on the chain (micro-org#373 §6.1), so an address would be watched,
    // and credited, and the balance would be one nobody could withdraw. The person is told the
    // asset is unavailable and not why, deliberately — which chains a deployment can pay out on is
    // an operational fact, and the log line carries it.
    throw new DepositError(
      'asset_not_withdrawable',
      unobservableDetail(assetCode, 'not_retrievable'),
      503,
    )
  }
  if (observation.reason === 'unknown') {
    throw new DepositError('observability_unknown', unobservableDetail(assetCode, 'unknown'), 503)
  }
  throw new DepositError('asset_not_observable', unobservableDetail(assetCode, 'not_followed'), 503)
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

  // BEFORE the find-or-create, deliberately. The harm is SHOWING somebody an address to send to,
  // and an address that already exists is exactly as unwatched as one minted now — so a chain that
  // stopped being observable must stop being handed out, not merely stop being minted.
  await assertObservable(deps, chain, assetCode)

  if (!input.rotate) {
    const existing = await activeAssignment(deps.sql, input.userId, assetCode, deps.network)
    if (existing) {
      // Registration is idempotent on the indexer's side, so a previously-unwatched assignment is
      // repaired on the next read rather than waiting for the job's next pass. Re-read afterwards
      // rather than returning the snapshot: `watchedAt` is the field a caller checks to know
      // whether this address will ever produce a deposit event, and a stale null there is a
      // dashboard reporting a problem that has just been fixed.
      if (existing.watchedAt === null) {
        // NOT freshly derived. This row already existed when the request arrived, which means the
        // user was handed this address on an earlier call — see `watchAssignment` for why a claim
        // about an address already in circulation is the dangerous one.
        await watch(deps, existing, false)
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
   * sign anything with this key (SD-09, `12-security-decisions.md`; the comparison is at
   * `custody/src/gates.ts`). settlement must restate it to sweep the address and has nothing
   * to derive it from — "a guessed binding is a sweep refused every tick for ever"
   * (`settlement/src/server.ts`) — so the value has to be one this service can still produce
   * for this address indefinitely. The assignment's own primary key is that value, and using it
   * means the binding needs no column of its own and cannot drift from the row it belongs to.
   *
   * The order of the two writes is the same trade custody makes when it writes the key blob before
   * the row that names it (`custody/src/keys.ts`). A crash between them leaves an address
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

  // `freshlyDerived: true`, and this is the only call site that passes it. It runs in the same
  // request that minted the key, seconds after custody derived it and before the address has been
  // returned to anyone — so "nothing can have paid it before now" is a statement of fact rather
  // than an assumption. It is what lets the indexer derive a UTXO balance for this address on a
  // chain it did not walk from genesis; `indexerclient.watch` carries what the claim costs if it
  // is ever untrue.
  await watch(deps, assignment, true)
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
async function watch(
  deps: DepositDeps,
  assignment: AssignmentRecord,
  freshlyDerived: boolean,
): Promise<void> {
  try {
    await deps.indexer.watch(
      assignment.chain,
      assignment.network,
      assignment.address,
      `deposit:${assignment.userId}`,
      freshlyDerived,
    )
    await deps.sql`
      update deposit_address_assignments set watched_at = now() where id = ${assignment.id}
    `
  } catch {
    // Deliberately silent here; `jobs.ts` logs and retries. A log line per failed registration on
    // a busy provisioning path would drown the one that matters, which is the job giving up.
  }
}

/**
 * Which assets this deployment will actually issue a deposit address for, right now.
 *
 * **This exists because the UI had no way to ask, and guessed.** `hub-web`'s Receive built its
 * list from the user's HOLDINGS, which is circular: you could only receive an asset you already
 * held, so a new asset was unreachable through the interface no matter how completely the estate
 * supported it. A person with only EMBER was offered only EMBER, for ever.
 *
 * The obvious alternative — ship a static list in the bundle — was tried and correctly rejected:
 * it would offer assets the service then refuses, and "never offer an asset the service will
 * refuse" is the rule that keeps a wallet honest. The list has to come from whatever `assign`
 * itself would decide, or the two drift the moment a chain is added or a provider fails.
 *
 * So this asks the same two gates `assertObservable` asks, per chain, and reports the answer with
 * its reason. `unavailable` is not a synonym for `unsupported`: the first may be true for ten
 * minutes, the second until someone deploys a node, and a person deciding whether to wait deserves
 * to know which.
 *
 * ── IT ASKS `availability`, NOT `observability`, AND THE DIFFERENCE IS THE WHOLE OF #481 ────────
 *
 * This read `deps.observability` — the deposit GATE — until micro-org#481, on the reasoning that a
 * catalogue built from anything other than what `assign` would decide will drift away from it. That
 * reasoning is right about the VERDICT and was wrong about the REASON, and the two are not the same
 * question. `payableChainsOnly` short-circuits before it consults the indexer, so on a chain with no
 * fee quote it reports `not_retrievable` — "we watch it and cannot pay it out" — without having
 * asked whether anything watches it.
 *
 * Measured on the mainnet estate, 2026-08-17: `WALLET_FEE_QUOTES` opens `ember, btc, ltc`, and
 * `INDEXER_CHAINS` is `ember:mainnet, ltc:mainnet, btc:mainnet`. So DOGE, ETC, SOL and XRP were all
 * reported `not_retrievable`, and for all four the first half of that sentence is false — the
 * indexer answers `followed: false, providers: []` for every one of them. The owner asked why there
 * was no Dogecoin anywhere in the wallet, and the answer this route was giving pointed at the fee
 * table when the truth is that no dogecoind is reachable from this estate at all.
 *
 * `chainAvailability` reaches the identical verdict — the gate does not loosen by one chain, and
 * `depositable` is byte-for-byte what it was — and picks the reason that is actually true. The
 * verdict comes from the gate's own composition and never from this loop.
 *
 * ── AND EVERY ROW NOW CARRIES A SENTENCE, BECAUSE AN ENUM WAS NOT REACHING ANYBODY ──────────────
 *
 * The reported symptom was "no Dogecoin reference in the wallet", and the DOGE row was in this
 * response the whole time. `hub-web`'s Receive panel does `assets.filter((a) => a.depositable)`
 * before it draws, so every refused asset — and its reason — is discarded by the only consumer.
 * That filter is not wrong on its own terms: `reason` is a machine word, and a client holding
 * `'not_followed'` has to invent the prose, which is prose no client writes.
 *
 * `detail` is that prose, shared verbatim with the 503 `assign` raises for the same asset. It does
 * not force any surface to render the row, and it removes the excuse for not doing so — which is
 * exactly what `pool/src/chains.ts` did for the browser-mining refusal and `micro-pool-web` renders
 * verbatim today.
 */
export interface DepositableAsset {
  readonly assetCode: string
  readonly chain: ChainId
  readonly depositable: boolean
  /** The machine word. `null` exactly when `depositable` is true. */
  readonly reason: UnobservableReason | null
  /**
   * The same fact as a sentence a surface can render without writing its own. `null` exactly when
   * `depositable` is true — an asset that IS on offer needs no explanation, and a string there
   * would be a caption looking for somewhere to be drawn.
   */
  readonly detail: string | null
}

/**
 * Narrowed to the two fields it actually reads, and not to `DepositDeps` entire.
 *
 * A catalogue that took the whole bundle could grow a database read or a custody call without the
 * signature changing, and this route must stay a pure description of configuration: it is
 * unauthenticated per user, called on page load, and answers the same thing for everybody.
 */
export type CatalogueDeps = Pick<DepositDeps, 'availability' | 'network'>

export async function depositableAssets(deps: CatalogueDeps): Promise<readonly DepositableAsset[]> {
  const out: DepositableAsset[] = []
  // Cached per chain: several assets can share one (an ERC-20 and ETH), and asking the indexer
  // once per ASSET would multiply the same question by the size of the catalogue.
  const seen = new Map<ChainId, { observable: boolean; reason: UnobservableReason | null }>()
  for (const assetCode of ON_CHAIN_ASSETS) {
    const chain = chainForAsset(assetCode)
    if (chain === null) continue
    let observation = seen.get(chain)
    if (observation === undefined) {
      try {
        const answer = await deps.availability.observe(chain, deps.network)
        observation = { observable: answer.observable, reason: answer.observable ? null : answer.reason }
      } catch {
        // An indexer that cannot be reached is `unknown`, never `unsupported`. Reporting a
        // transient outage as "this estate does not support Litecoin" would be a lie with a long
        // half-life — people remember being told something is unsupported.
        observation = { observable: false, reason: 'unknown' }
      }
      seen.set(chain, observation)
    }
    out.push({
      assetCode,
      chain,
      depositable: observation.observable,
      reason: observation.reason,
      detail: observation.reason === null ? null : unobservableDetail(assetCode, observation.reason),
    })
  }
  return Object.freeze(out)
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

/**
 * How many deposit addresses are waiting on a registration, per chain.
 *
 * **A count, not the length of a page.** The gauge this feeds was previously the `.length` of
 * `unwatchedAssignments(db, 500)`, which is `min(backlog, 500)` — a number that stops moving at
 * the exact point the backlog becomes serious, and reports the same 500 for five hundred addresses
 * and for fifty thousand. A gauge whose whole job is "how big is this" must not saturate.
 *
 * Scoped to the deployment's network. A single process settles exactly one network — `claimCredit`
 * refuses anything else with `wrong_network`, and `assign` only ever writes `deps.network` — so a
 * row on another network is not this deployment's backlog to repair, and counting it would page
 * the wrong estate. The partial index `deposit_address_assignments_unwatched_idx` serves the
 * predicate.
 *
 * No status filter, matching `unwatchedAssignments`: money arriving at a rotated address is still
 * the user's, so a rotated row with a null `watched_at` is still a registration that is missing.
 */
export async function unwatchedByChain(
  sql: Db,
  network: Network,
): Promise<ReadonlyMap<string, number>> {
  const rows = await sql<{ chain: string; waiting: string }[]>`
    select chain, count(*)::text as waiting
      from deposit_address_assignments
     where watched_at is null and network = ${network}
     group by chain
  `
  return new Map(rows.map((row) => [row.chain, Number(row.waiting)]))
}

/**
 * Addresses this deployment has issued and not withdrawn, per chain.
 *
 * `status = 'active'` and not every row: `rotated` and `retired` assignments stay in the table as
 * history and are no longer the address anybody was given, so counting them would inflate the
 * outstanding promise by exactly the addresses that are not outstanding. `watched_at` is NOT part
 * of this — an unwatched address is a different defect with its own gauge, and an address can be
 * perfectly watched and still be on a chain nothing can pay out of, which is the whole point.
 *
 * Filtered to this deployment's network for the reason `unwatchedByChain` is: a row for the other
 * network is not this process's promise and it cannot act on it.
 */
export async function activeByChain(
  sql: Db,
  network: Network,
): Promise<ReadonlyMap<string, number>> {
  const rows = await sql<{ chain: string; issued: string }[]>`
    select chain, count(*)::text as issued
      from deposit_address_assignments
     where status = 'active' and network = ${network}
     group by chain
  `
  return new Map(rows.map((row) => [row.chain, Number(row.issued)]))
}

/**
 * Publish the deposit-address backlog at scrape time.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TWO GAUGES WERE WRITTEN FROM TWO PLACES THAT DISAGREED, AND ONE OF THEM WAS A LEASED JOB.**
 *
 * `wallet_deposit_addresses_unwatched` was set by the `deposit.watch` handler from
 * `unwatchedAssignments(sql, BATCH)` — capped at 50 — and separately by `index.ts`'s `beforeScrape`
 * from `unwatchedAssignments(db, 500)`. Same series name, two definitions of the number, alternating
 * as the job ran. `wallet_deposit_addresses_unobservable` was set ONLY by the job, and the job is
 * leased: exactly one replica ever claimed it, so that series existed on one scrape target and was
 * absent on every other. Prometheus scrapes each replica separately, so the estate held N series
 * with N different values for one fact, and `unwatched - unobservable` — the expression that
 * separates a backlog somebody must fix from one an owner has decided not to — could not be
 * evaluated at all on the replicas where the second series was missing.
 *
 * Both are now written here, from one query, on every scrape, on every replica, so the two numbers
 * are of the same instant and their difference means something. The job no longer writes either;
 * a batch-capped count of the page it happens to be holding is not the backlog.
 *
 * **Labelled by chain**, which is the dimension the condition actually has: the indexer follows one
 * chain per estate today, so "eleven addresses unwatched" was a number an operator could do nothing
 * with until they queried the database to find out which chain. A zero is written for every member
 * of `CHAIN_IDS` on every scrape, so no series is ever absent (absent and healthy are the same
 * shape to an alert) and none goes stale when a chain's backlog clears — a labelled gauge cannot be
 * removed once set, so the zero has to be written rather than implied.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `unobservable` is the part of the backlog on a chain this estate follows no source for. It is an
 * owner's decision rather than a fault, and it carries the whole backlog for that chain rather
 * than a separate count, so `unwatched - unobservable` per chain is exactly the repairable part.
 *
 * The observability answer is the one the DEPOSIT GATE acts on, not an independent reading of the
 * chain: it comes from the same cached `ChainObservability` the assignment path consults, and it
 * fails closed the same way, so an indexer this process cannot reach reports 0 here for the same
 * reason it refuses to hand out an address. That is deliberate — the series says what this service
 * will DO, which is the thing an operator needs — and it is why the alert built on it stays quiet
 * during an indexer outage rather than firing on a backlog nobody could have registered anyway.
 */
export async function sampleDepositAddressMetrics(
  deps: Pick<DepositDeps, 'sql' | 'network' | 'observability'>,
  metrics: Metrics,
): Promise<void> {
  const [backlog, issued] = await Promise.all([
    unwatchedByChain(deps.sql, deps.network),
    activeByChain(deps.sql, deps.network),
  ])
  // In parallel: the answers are cached for 60s, so this is at most one round trip per chain per
  // minute per replica, and a scrape must not cost eight sequential ones.
  const observed = await Promise.all(
    CHAIN_IDS.map(
      async (chain) => [chain, await deps.observability.observe(chain, deps.network)] as const,
    ),
  )
  for (const [chain, observation] of observed) {
    const waiting = backlog.get(chain) ?? 0
    metrics.set('wallet_deposit_addresses_unwatched', waiting, { chain })
    metrics.set(
      'wallet_deposit_addresses_unobservable',
      observation.observable ? 0 : waiting,
      { chain },
    )
    metrics.set('wallet_chain_observable', observation.observable ? 1 : 0, { chain })
    // **Read this before believing a 0 above.** `observable: false` is two conditions with opposite
    // repairs — "the indexer follows no source for this chain", which is an owner's decision and
    // the steady state for seven of these eight, and "this process has never managed to ask and has
    // no cached answer to fall back on", which is a fault that is refusing deposits right now. A
    // gauge cannot say "unknown", so the second one gets its own series rather than a value on the
    // first: the same shape `ledger_reconciliation_observed` uses beside
    // `ledger_reconciliation_drift`, and for the same reason.
    metrics.set('wallet_chain_observability_unknown', observation.reason === 'unknown' ? 1 : 0, {
      chain,
    })
    // The third condition, and it needs its own series for the same reason `unknown` does. Since
    // micro-org#373 §6.1 the gate is `observable AND payable-out`, so a 0 above is now ALSO how a
    // chain the indexer follows perfectly well reads when this deployment has stated no withdrawal
    // fee for it — a deliberate refusal whose repair is a `WALLET_FEE_QUOTES` entry, not a node.
    // Without this series an operator staring at `wallet_chain_observable{chain="btc"} 0` after
    // switching the indexer on would go looking at the indexer, and find nothing wrong with it.
    //
    // **This was `wallet_chain_not_retrievable` and it never reached a single scrape.** The name was
    // never passed to `metrics.register`, and `Metrics.set` drops an unregistered write on its first
    // line — reported once to stderr, rendered never. So the series the paragraph above says an
    // operator needs did not exist, on any replica, from 2.5.18 until now. Measured on mainnet
    // 2026-08-11: `/metrics` carried `wallet_chain_observable` and
    // `wallet_chain_observability_unknown` and no third series at all. It is positive sense now —
    // see the spec in `server.ts` — so the gate reads as the conjunction it is.
    metrics.set('wallet_chain_retrievable', observation.reason === 'not_retrievable' ? 0 : 1, {
      chain,
    })
    // Promises already outstanding on a chain that is closed NOW. The gate refuses new addresses;
    // it cannot recall the ones handed out before it existed, and micro-org#373 §6.2 is one of
    // those. A zero is written for every chain on every scrape for the same reason the gauges above
    // write theirs — absent and healthy must not be the same shape to an alert.
    metrics.set(
      'wallet_deposit_addresses_unretrievable',
      observation.reason === 'not_retrievable' ? (issued.get(chain) ?? 0) : 0,
      { chain },
    )
  }
  // A chain in the table that this build does not know — the `deposit_address_assignments_chain_ck`
  // constraint makes it unreachable today, and it becomes reachable the moment a migration widens
  // the constraint ahead of a deploy. Reported as fully repairable rather than dropped: a backlog
  // silently missing from the total is the defect this whole change exists to remove, and an
  // over-report is a question somebody answers where an under-report is one nobody asks.
  for (const [chain, waiting] of backlog) {
    if ((CHAIN_IDS as readonly string[]).includes(chain)) continue
    metrics.set('wallet_deposit_addresses_unwatched', waiting, { chain })
    metrics.set('wallet_deposit_addresses_unobservable', 0, { chain })
  }
}

/**
 * Exported for the job, which repairs registrations without going through the request path.
 *
 * **No `freshlyDerived` here, deliberately.** This runs some unknown time after the address was
 * minted, and the user already has it — the request path returns the assignment whether or not the
 * registration succeeded. So "nothing can have paid it before now" is exactly the claim that may
 * have stopped being true, and on a UTXO chain a false claim of that shape lets the indexer derive
 * a total with a real deposit missing from it: an understatement, which is positive drift at the
 * ledger and freezes the asset. Saying nothing instead makes the indexer refuse with
 * `history_unknown` on a cold-started chain, which is loud, and correct.
 */
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
    //
    // **The refusal is unchanged. What changed is that it is now written down** — micro-org#200.
    // This branch used to return here and nothing else happened: no row, no event, no number, and
    // a user whose tokens had arrived at an address only micro-custody can sign for had no way to
    // learn that they had. Recording the sighting credits nothing and posts nothing; see
    // `recordTokenSighting`.
    return recordTokenSighting(tx, deps, input)
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

/* --------------------------------------------------- token deposits, seen and not credited */

/**
 * The identity of one token sighting: `(chain, network, txHash, logIndex)`.
 *
 * Deliberately the same tuple `depositCreditKey` uses, with a different prefix. Same tuple because
 * it is the same on-chain movement being identified and there is only one right answer to "is this
 * the thing I already saw"; different prefix because a sighting and a credit are different
 * decisions about it, and one namespace shared between them would let a future crediting path
 * collide with the record of the interval before it existed.
 */
export function tokenSightingKey(
  chain: string,
  network: string,
  txHash: string,
  logIndex: number,
): string {
  return `wallet:token-sighting:${chain}:${network}:${txHash.toLowerCase()}:${logIndex}`
}

/**
 * Record a token transfer that arrived at a deposit address, and tell the user — micro-org#200.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS FUNCTION CREDITS NOTHING, POSTS NOTHING AND MOVES NO MONEY, AND THAT IS THE DESIGN.**
 *
 * A credit needs the token's decimals, and this service has no source for them: `assetDecimals` in
 * contracts-money throws for a `TOKEN:` code rather than return 18, because Tether is six decimals
 * on Ethereum and eighteen on BSC and a wrong exponent on a stablecoin is a balance wrong by a
 * factor of 10^12. It also needs a `chain_assets` row only `micro-ledger` may write, a `micro-
 * pricing` route that answers for a `TOKEN:` urn — it answers `404 not_found` today — and a
 * withdrawal path for tokens, which does not exist in any form. Crediting on an observation this
 * estate cannot complete is the failure this whole path is built to refuse.
 *
 * What was wrong was never the refusal. It was that the refusal was SILENT: the event was
 * consumed, `token_deposit_unsupported` was returned, and nothing anywhere held the fact that a
 * user's tokens were sitting at an address only `micro-custody` can sign for. So this writes the
 * evidence and emits the news, and the decision the caller returns is still "ignored".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── Fail closed on attribution, not just on money ────────────────────────────────────────────
 *
 * Nothing is recorded unless an assignment for that exact address is on file, and then the row is
 * filed against the user that assignment names. A sighting attributed to a guessed user is a
 * message telling one person about another person's money, which is worse than the silence this
 * replaces. `unknown_address` is the honest answer and it is already the answer the native path
 * gives.
 *
 * ── The depth is re-checked against the CHAIN's native asset ─────────────────────────────────
 *
 * A token transfer is a log inside a block, so the block's depth is the token's depth: the exact
 * number `requiredConfirmations(scope.chain)` the indexer used before it emitted. Re-derived here
 * from the same exact-pinned `contracts-chain` for the same reason the native path re-derives it —
 * the payload's `confirmations` is what the indexer computed from its tip at its moment, and this
 * is where a stale one gets caught. It gates a message rather than money here, but a message
 * saying tokens arrived, sent for a transaction a reorg then removed, is a message that cannot be
 * taken back.
 */
async function recordTokenSighting(
  tx: Tx,
  deps: DepositDeps,
  input: CreditInput,
): Promise<CreditDecision> {
  const payload = input.payload
  // A chain this build has no address vocabulary for. `canonicaliseAddress` below would throw on
  // it, and a throw rolls back the inbox row and redelivers for ever.
  if (!isChainId(payload.chain)) return { kind: 'ignored', reason: 'unknown_chain' }
  const chain: ChainId = payload.chain

  // A token movement is a log. One without a log index cannot be identified against a second
  // movement of the same token in the same transaction, so it is refused rather than merged.
  if (payload.logIndex === null) return { kind: 'ignored', reason: 'token_deposit_without_log' }

  const confirmations = payload.confirmations ?? 0
  if (!isConfirmed(assetOf(chain), confirmations)) {
    return { kind: 'ignored', reason: 'below_confirmation_depth' }
  }

  let amount: bigint
  try {
    amount = BigInt(payload.amount)
  } catch {
    return { kind: 'ignored', reason: 'unparseable_amount' }
  }
  if (amount <= 0n) return { kind: 'ignored', reason: 'non_positive_amount' }

  // `TOKEN:<chain>:<network>:<0x contract>`, and it throws on anything else — including on a brand
  // name, which is the promoted rule the issue turns on. A symbol read off the contract would be
  // mutable, spoofable and off-chain; the deployment address is the only name that cannot lie.
  let tokenAssetCode: string
  try {
    tokenAssetCode = chainTokenAssetCode({
      chain,
      network: deps.network,
      contract: payload.tokenAddress ?? '',
    })
  } catch {
    return { kind: 'ignored', reason: 'token_deposit_unidentified' }
  }

  const addressKey = canonicaliseAddress(chain, payload.address).key
  // Every assignment ever made for this address, exactly as the credit path does: money at a
  // rotated address is still the user's, and that is no less true of money that cannot be credited.
  //
  // **`asset_code` is deliberately NOT compared.** The credit path refuses a mismatch because it
  // is about to post to a ledger account named by that code. Here the mismatch is the scenario
  // itself — a token arriving at the address issued for the chain's native asset is precisely what
  // micro-org#200 describes — and refusing on it would restore the silence.
  const rows = await tx<AssignmentRow[]>`
    select ${tx.unsafe(ASSIGNMENT_COLUMNS)} from deposit_address_assignments
     where chain = ${chain} and network = ${payload.network} and address_key = ${addressKey}
     order by assigned_at desc
     limit 1
  `
  const assignment = rows[0]
  if (!assignment) return { kind: 'ignored', reason: 'unknown_address' }

  const sightingKey = tokenSightingKey(chain, payload.network, payload.txHash, payload.logIndex)
  const id = uuidv7()
  const inserted = await tx<{ id: string }[]>`
    insert into deposit_token_sightings (
      id, user_id, assignment_id, wallet_id, chain, network, address_key, token_address,
      token_asset_code, amount, tx_hash, log_index, block_height, confirmations, sighting_key
    )
    values (
      ${id}, ${assignment.user_id}, ${assignment.id}, ${assignment.wallet_id}, ${chain},
      ${payload.network}, ${addressKey}, ${(payload.tokenAddress ?? '').toLowerCase()},
      ${tokenAssetCode}, ${amount.toString()}::numeric(78,0), ${payload.txHash},
      ${payload.logIndex}, ${payload.blockHeight}, ${confirmations}, ${sightingKey}
    )
    on conflict (sighting_key) do nothing
    returning id
  `
  // Already on file. A reorg that put the transaction back at depth produces exactly this, and the
  // user has already been told once — telling them again for one arrival is how a message that
  // matters becomes one that gets ignored.
  if (inserted.length === 0) return { kind: 'ignored', reason: 'token_deposit_duplicate' }

  // **Written in the same transaction as the row it announces.** The credit path emits after its
  // commit because a ledger call sits between the two and must not hold a transaction open; there
  // is no such call here, so the strictly better ordering is available and is taken: the estate
  // cannot end up with a sighting nobody was told about, or a message about a sighting that was
  // rolled back.
  await writeEvent(tx, deps.producer, {
    topic: DEPOSIT_TOKEN_UNCREDITED,
    key: assignment.wallet_id,
    actor: `service:${deps.producer}`,
    correlationId: input.correlationId,
    payload: {
      sightingId: id,
      userId: assignment.user_id,
      walletId: assignment.wallet_id,
      chain,
      network: payload.network,
      tokenAddress: (payload.tokenAddress ?? '').toLowerCase(),
      assetCode: tokenAssetCode,
      // **Unscaled, and there is no `amountFormatted` beside it.** Every other money event in this
      // service carries one; this one cannot, because formatting needs decimals nothing here is
      // entitled to supply. A consumer that renders this must render the integer, or say nothing.
      amount: amount.toString(),
      txHash: payload.txHash,
      txUrn: txUrn(assetOf(chain), payload.network as Network, payload.txHash),
      explorerUrl: explorerTxUrl(assetOf(chain), payload.network as Network, payload.txHash),
      confirmations,
      // The one field a consumer must not have to infer. Everything downstream of this event is
      // about a deposit that did NOT happen to the user's balance.
      credited: false,
    },
  })

  return { kind: 'ignored', reason: 'token_deposit_unsupported' }
}

export interface TokenSightingView {
  readonly id: string
  readonly assetCode: string
  readonly tokenAddress: string
  /** Smallest units of the token, UNSCALED — this service does not know its decimals. */
  readonly amount: string
  readonly chain: string
  readonly network: string
  readonly txHash: string
  readonly txUrn: string
  readonly explorerUrl: string | null
  readonly confirmations: number
  readonly firstSeenAt: string
  /** Always false. Present so a reader cannot mistake this page for the credits page. */
  readonly credited: false
}

interface SightingRow {
  readonly id: string
  readonly chain: string
  readonly network: string
  readonly token_address: string
  readonly token_asset_code: string
  readonly amount: string
  readonly tx_hash: string
  readonly confirmations: number
  readonly first_seen_at: Date
}

/**
 * A page of a user's uncredited token sightings, newest first. Keyset on `id`, which is UUIDv7.
 *
 * The twin of `listCredits`, and a SEPARATE route rather than rows mixed into that one. Mixing
 * them would put "this is in your balance" and "this is not and cannot be withdrawn" in one list
 * distinguished by a boolean, and the whole of micro-org#200 is that a user could not tell the
 * difference. Two lists cannot be skim-read into one.
 */
export async function listTokenSightings(
  sql: Db,
  userId: string,
  limit: number,
  cursor: string | null,
): Promise<{ sightings: readonly TokenSightingView[]; nextCursor: string | null }> {
  const rows = await sql<SightingRow[]>`
    select id, chain, network, token_address, token_asset_code, amount::text as amount, tx_hash,
           confirmations, first_seen_at
      from deposit_token_sightings
     where user_id = ${userId}
       and (${cursor}::uuid is null or id < ${cursor}::uuid)
     order by id desc
     limit ${limit + 1}
  `
  const page = rows.slice(0, limit)
  return {
    sightings: page.map((row) => {
      const native = assetOf(row.chain as ChainId)
      return {
        id: row.id,
        assetCode: row.token_asset_code,
        tokenAddress: row.token_address,
        // No `amountFormatted`. See the event payload above: a formatted figure here would be this
        // service asserting a decimals value it has no source for.
        amount: row.amount,
        chain: row.chain,
        network: row.network,
        txHash: row.tx_hash,
        // The transaction is on the chain whether or not the token is one this estate knows, so
        // the explorer link is the chain's. It is the only thing on this page a user can act on.
        txUrn: txUrn(native, row.network as Network, row.tx_hash),
        explorerUrl: explorerTxUrl(native, row.network as Network, row.tx_hash),
        confirmations: row.confirmations,
        firstSeenAt: row.first_seen_at.toISOString(),
        credited: false,
      }
    }),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}

/**
 * How many token deposits are sitting at deposit addresses, uncredited. The gauge's only source.
 *
 * A count and not a page, for the reason `pendingCreditCount` is: a gauge whose job is "how big is
 * this" must not saturate at the size of a page. Unlike that one this number does not drain — a
 * sighting is never resolved by this service — so it is a running total of an obligation nobody
 * has recorded in the ledger, which is exactly the thing an operator should be able to alert on.
 */
export async function tokenSightingCount(sql: Db): Promise<number> {
  const [row] = await sql<{ seen: string }[]>`
    select count(*)::text as seen from deposit_token_sightings
  `
  return Number(row?.seen ?? 0)
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

/**
 * How much money has arrived and not been posted. The gauge's only source.
 *
 * **A count, not the length of a page** — which is the defect `unwatchedByChain` above was written
 * to remove on the address backlog, and the credits gauge was not carried along with it.
 * `beforeScrape` published `(await pendingCredits(db, 500)).length`, so
 * `wallet_deposit_credits_pending` was `min(backlog, 500)`: five hundred unposted credits and forty
 * thousand publish the same number, and the series goes FLAT at the exact moment it should be going
 * vertical. A flat line reads as "stable" to somebody who has thirty seconds to decide whether this
 * is the thing that woke them, and a gauge whose entire job is "how big is this" must not saturate.
 * The estate now alerts on it — `DepositCreditsUnposted` in micro-deploy's `cf.ticket.money` — and a
 * saturating input is a rule that cannot escalate.
 *
 * It also paid for the lie. Five hundred UUIDs were selected, marshalled and materialised into a JS
 * array on every scrape on every replica, to be discarded immediately after `.length`.
 *
 * `pendingCredits` is unchanged and stays: the retry job genuinely wants a page of ids to work
 * through, and a page is an honest answer to "what should this pass do". It is not an honest answer
 * to "how big is the backlog", which is why the job no longer publishes one — see `POST_CREDIT_KIND`
 * in `jobs.ts`.
 *
 * **Deliberately NOT scoped to `network`,** which is the one place this parts company with
 * `unwatchedByChain`. That function filters because `assign` only ever writes this deployment's
 * network and a foreign row is not this process's to repair. Here the retry job is the arbiter:
 * `pendingCredits` carries no network predicate, so a foreign-network row IS work this process will
 * pick up and try to post. A gauge that excluded it would hide a backlog the service is actively
 * failing to drain — the two must select the same rows or the number stops describing the queue.
 *
 * Served by `deposit_credits_unposted_idx`, the partial index migration 14 adds. Without it this is
 * a sequential scan of every deposit this service has ever credited, on every scrape on every
 * replica, and the HEALTHY case is the expensive one: with nothing pending there is no matching row
 * to stop early on, so a clean estate pays the most. `withdrawals_open_idx` is the same argument on
 * the withdrawals table — "a full-table scan here would grow with settled history for ever".
 */
export async function pendingCreditCount(sql: Db): Promise<number> {
  const [row] = await sql<{ pending: string }[]>`
    select count(*)::text as pending from deposit_credits where ledger_entry_id is null
  `
  return Number(row?.pending ?? 0)
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
