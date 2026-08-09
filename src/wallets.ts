/**
 * The wallet registry — 04-domain-model §3.1.
 *
 * This table is what resolves the "wallet means three things" collision recorded in
 * 00-current-state §5. In the estate today `wallet` is simultaneously a Shard balance row, a
 * deposit address and a keyvault key, and no code can say which is meant without reading its
 * neighbours. Here it is one thing: a wallet a *user* has, of a stated origin, on a stated network,
 * with a lifecycle.
 *
 * Three properties of this file are load-bearing.
 *
 * **There is no balance column.** Not an omission — the point. Every balance question goes to the
 * ledger. 04-domain-model §11 names the consequence of the alternative: a cached balance in a
 * product database is the bug that made Crucible's bot state diverge from Pay's, and once two
 * places hold a number there is no procedure that can say which is right.
 *
 * **`network` is never inferred.** §3.1: "`network` is `mainnet` or `testnet`, never inferred". It
 * is a column, a check constraint, and part of every unique index. 00-current-state §3.5 records
 * what inference costs: on XRP the same seed produces the same address on both networks, so a
 * record without a network binding is a record that describes two different pots of money.
 *
 * **`custody_key_urn` is present exactly when `origin = 'managed'`,** enforced by a check
 * constraint rather than by discipline. An external wallet carrying a custody key would claim the
 * platform holds a key it does not; a managed wallet without one is a wallet nothing can sign for.
 */

import {
  type CanonicalAddress,
  type ChainId,
  canonicaliseAddress,
  isChainId,
} from './addresses.ts'
import type { Network } from '@cloudsforge/contracts-chain'
import { uuidv7 } from './ids.ts'
import { WALLET_CREATED, writeEvent, type Db, type Tx } from './outbox.ts'

export type WalletOrigin = 'managed' | 'external' | 'watch'

export const WALLET_ORIGINS: readonly WalletOrigin[] = Object.freeze([
  'managed',
  'external',
  'watch',
])

export type WalletStatus =
  | 'provisioning'
  | 'active'
  | 'frozen'
  | 'exported'
  | 'retiring'
  | 'retired'

/**
 * The lifecycle, as a table rather than as scattered `if` statements.
 *
 * `provisioning → active → { frozen, exported, retiring → retired }`, from §3.1. Each terminal is
 * terminal for a different reason and they are not interchangeable:
 *
 *   * `frozen` — policy or an operator. **Cannot send, can still receive.** Reversible, which is
 *     why `frozen → active` is here and `exported → active` is not.
 *   * `exported` — the user has taken the private key (AD-13). **Irreversible.** The platform
 *     stops sweeping into treasury from it and every surface marks it self-custodied. There is no
 *     transition out, because there is no operation that can un-know a key.
 *   * `retiring → retired` — the user has ended the platform's use of it. No new deposits are
 *     assigned to it; deposits that arrive at it anyway are still credited, because the money is
 *     the user's and refusing it would strand it.
 */
const TRANSITIONS: Readonly<Record<WalletStatus, readonly WalletStatus[]>> = Object.freeze({
  provisioning: ['active', 'retired'],
  active: ['frozen', 'exported', 'retiring'],
  frozen: ['active', 'retiring', 'exported'],
  exported: [],
  retiring: ['retired', 'active'],
  retired: [],
})

export function canTransition(from: WalletStatus, to: WalletStatus): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to)
}

export class WalletError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WalletError'
    this.code = code
  }
}

export class WalletNotFoundError extends WalletError {
  constructor(id: string) {
    super('wallet_not_found', `no wallet ${id}`)
  }
}

export interface WalletRecord {
  readonly id: string
  readonly userId: string
  readonly origin: WalletOrigin
  readonly chain: ChainId
  readonly network: Network
  /** Display form: EIP-55 for EVM and Ember. */
  readonly address: string
  readonly label: string | null
  readonly isPrimary: boolean
  readonly status: WalletStatus
  /** Present only when `origin = 'managed'`. */
  readonly custodyKeyUrn: string | null
  readonly createdAt: string
  readonly verifiedAt: string | null
  readonly exportedAt: string | null
  readonly retiredAt: string | null
}

interface WalletRow {
  readonly id: string
  readonly user_id: string
  readonly origin: string
  readonly chain: string
  readonly network: string
  readonly address: string
  readonly address_key: string
  readonly label: string | null
  readonly is_primary: boolean
  readonly status: string
  readonly custody_key_urn: string | null
  readonly created_at: Date
  readonly verified_at: Date | null
  readonly exported_at: Date | null
  readonly retired_at: Date | null
}

const COLUMNS = `id, user_id, origin, chain, network, address, address_key, label, is_primary,
                 status, custody_key_urn, created_at, verified_at, exported_at, retired_at`

export function toWallet(row: WalletRow): WalletRecord {
  return {
    id: row.id,
    userId: row.user_id,
    origin: row.origin as WalletOrigin,
    chain: row.chain as ChainId,
    network: row.network as Network,
    address: row.address,
    label: row.label,
    isPrimary: row.is_primary,
    status: row.status as WalletStatus,
    custodyKeyUrn: row.custody_key_urn,
    createdAt: row.created_at.toISOString(),
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    exportedAt: row.exported_at ? row.exported_at.toISOString() : null,
    retiredAt: row.retired_at ? row.retired_at.toISOString() : null,
  }
}

export interface CreateWalletInput {
  readonly userId: string
  readonly origin: WalletOrigin
  readonly chain: ChainId
  readonly network: Network
  readonly address: string
  readonly label?: string | null
  readonly isPrimary?: boolean
  readonly status?: WalletStatus
  readonly custodyKeyUrn?: string | null
  readonly actor: string
  readonly correlationId: string
}

/**
 * Insert a wallet, or return the one that already exists for this address.
 *
 * Find-or-create rather than a hard conflict, because the same address arriving twice is almost
 * always a retry: a user tapping "connect" again, or a deposit-address provision whose response
 * was lost. Minting a second row would give one address two lifecycles.
 *
 * Runs inside the caller's transaction so that a wallet and whatever it belongs to — an assignment,
 * a link challenge — commit together.
 */
export async function insertWallet(
  tx: Tx,
  producer: string,
  input: CreateWalletInput,
): Promise<{ wallet: WalletRecord; created: boolean }> {
  const canonical: CanonicalAddress = canonicaliseAddress(input.chain, input.address)
  if (input.origin === 'managed' && !input.custodyKeyUrn) {
    throw new WalletError('custody_key_required', 'a managed wallet must carry a custody key urn')
  }
  if (input.origin !== 'managed' && input.custodyKeyUrn) {
    throw new WalletError(
      'custody_key_forbidden',
      'only a managed wallet may carry a custody key urn',
    )
  }

  const id = uuidv7()
  const inserted = await tx<WalletRow[]>`
    insert into wallets (
      id, user_id, origin, chain, network, address, address_key, label, is_primary, status,
      custody_key_urn
    )
    values (
      ${id}, ${input.userId}, ${input.origin}, ${input.chain}, ${input.network},
      ${canonical.address}, ${canonical.key}, ${input.label ?? null},
      ${input.isPrimary ?? false}, ${input.status ?? 'provisioning'},
      ${input.custodyKeyUrn ?? null}
    )
    on conflict (user_id, chain, network, address_key) do nothing
    returning ${tx.unsafe(COLUMNS)}
  `

  const row = inserted[0]
  if (row) {
    await writeEvent(tx, producer, {
      topic: WALLET_CREATED,
      // Ordering is per (topic, key) only, so the key is the aggregate: two events about one
      // wallet stay in order and two wallets do not serialise against each other.
      key: row.id,
      payload: {
        walletId: row.id,
        userId: row.user_id,
        origin: row.origin,
        chain: row.chain,
        network: row.network,
        address: row.address,
        status: row.status,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return { wallet: toWallet(row), created: true }
  }

  const existing = await findByAddress(tx, input.userId, input.chain, input.network, canonical.key)
  if (!existing) {
    // Unreachable: the insert conflicted, so a row with this key exists. Reaching here means it
    // was deleted between the two statements, and wallets are never deleted.
    throw new WalletError('wallet_vanished', 'the conflicting wallet row could not be read back')
  }
  return { wallet: existing, created: false }
}

export async function findByAddress(
  sql: Db | Tx,
  userId: string,
  chain: ChainId,
  network: Network,
  addressKey: string,
): Promise<WalletRecord | null> {
  const rows = await sql<WalletRow[]>`
    select ${sql.unsafe(COLUMNS)} from wallets
     where user_id = ${userId} and chain = ${chain} and network = ${network}
       and address_key = ${addressKey}
  `
  const row = rows[0]
  return row ? toWallet(row) : null
}

export async function findWallet(sql: Db | Tx, id: string): Promise<WalletRecord | null> {
  const rows = await sql<WalletRow[]>`select ${sql.unsafe(COLUMNS)} from wallets where id = ${id}`
  const row = rows[0]
  return row ? toWallet(row) : null
}

/**
 * Is this address held by the platform, for anybody?
 *
 * **The span across every user is deliberate.** forge-pay's `isPlatformAddress` carries the same
 * note: "paying a stranger's deposit address would credit THEM." A withdrawal to another user's
 * managed address debits this user and credits that one, through a real chain transaction that
 * cost a real fee, and no reconciliation would ever flag it because the money did move.
 *
 * Covers managed wallets, every deposit address ever assigned (including rotated ones — the old
 * address is still ours), and the explicit `platform_addresses` list for treasuries and deployers.
 */
export async function isPlatformAddress(
  sql: Db | Tx,
  chain: ChainId,
  network: Network,
  addressKey: string,
): Promise<boolean> {
  const rows = await sql<{ hit: boolean }[]>`
    select true as hit
      from wallets
     where chain = ${chain} and network = ${network} and address_key = ${addressKey}
       and origin = 'managed'
     union all
    select true as hit
      from deposit_address_assignments
     where chain = ${chain} and network = ${network} and address_key = ${addressKey}
     union all
    select true as hit
      from platform_addresses
     where chain = ${chain} and network = ${network} and address_key = ${addressKey}
     limit 1
  `
  return rows.length > 0
}

export interface WalletPage {
  readonly wallets: readonly WalletRecord[]
  /** Absent on the last page. Callers page until it is missing, never by counting. */
  readonly nextCursor: string | null
}

export const MAX_PAGE_SIZE = 200
export const DEFAULT_PAGE_SIZE = 50

export interface ListWalletsQuery {
  readonly userId: string
  readonly limit: number
  readonly cursor?: string
  readonly chain?: ChainId
  readonly network?: Network
  readonly origin?: WalletOrigin
  /** Retired wallets are hidden by default; an explicit ask includes them. */
  readonly includeRetired?: boolean
}

/**
 * A page of a user's wallets.
 *
 * **Keyset pagination on `id`, not `offset`.** `id` is UUIDv7, so ordering by it descending is
 * reverse chronological with no tie-break ambiguity, and a page boundary does not shift under a
 * caller who creates a wallet between two requests. An OFFSET scan re-reads and discards every
 * preceding row, which is the shape of the defect this whole service is replacing: the current
 * wallet returns the entire unpaginated ledger on every call.
 */
export async function listWallets(sql: Db, query: ListWalletsQuery): Promise<WalletPage> {
  const limit = Math.min(Math.max(1, query.limit), MAX_PAGE_SIZE)
  // One extra row, so "is there another page" is answered without a second COUNT over a table
  // that only ever grows.
  const rows = await sql<WalletRow[]>`
    select ${sql.unsafe(COLUMNS)} from wallets
     where user_id = ${query.userId}
       and (${query.cursor ?? null}::uuid is null or id < ${query.cursor ?? null}::uuid)
       and (${query.chain ?? null}::text is null or chain = ${query.chain ?? null})
       and (${query.network ?? null}::text is null or network = ${query.network ?? null})
       and (${query.origin ?? null}::text is null or origin = ${query.origin ?? null})
       and (${query.includeRetired ?? false} or status <> 'retired')
     order by id desc
     limit ${limit + 1}
  `
  const page = rows.slice(0, limit)
  return {
    wallets: page.map(toWallet),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  }
}

/**
 * Who moved a wallet's lifecycle, and why.
 *
 * Required rather than optional, so there is no transition anywhere in this service that arrives
 * with nothing recorded about the decision behind it. Stored on the row and **not** returned in
 * `WalletRecord`: see migration 13 — the reason is free text written for the estate, and the
 * account holder is told the status, not the operator's sentence.
 */
export interface StatusChange {
  /** `user:<id>` or `service:<name>`, the same shape the outbox and the ledger use. */
  readonly actor: string
  readonly reason: string
}

/**
 * Move a wallet's lifecycle state.
 *
 * The transition is checked in the row's own UPDATE — `where status = ${from}` — rather than by a
 * read followed by a write. Two operators freezing and exporting at the same moment would
 * otherwise both read `active`, both find their transition legal, and the second would overwrite
 * the first: a wallet marked `frozen` whose key has actually left.
 *
 * `by` is not decoration. Until micro-org#315 a status change recorded nothing but the new value,
 * so a wallet could be frozen — or driven to the irreversible `exported` — with no actor and no
 * reason on the row and no event anywhere. The attribution is written in the SAME statement as the
 * status, so a row cannot exist in the new state with the old change's actor beside it.
 */
export async function transitionWallet(
  sql: Db | Tx,
  id: string,
  to: WalletStatus,
  by: StatusChange,
): Promise<WalletRecord> {
  const current = await findWallet(sql, id)
  if (!current) throw new WalletNotFoundError(id)
  if (current.status === to) return current
  if (!canTransition(current.status, to)) {
    throw new WalletError(
      'illegal_transition',
      `a ${current.status} wallet cannot become ${to}`,
    )
  }

  const rows = await sql<WalletRow[]>`
    update wallets
       set status = ${to},
           updated_at = now(),
           status_actor = ${by.actor},
           status_reason = ${by.reason},
           verified_at = case when ${to} = 'active' and verified_at is null and origin <> 'watch'
                              then now() else verified_at end,
           exported_at = case when ${to} = 'exported' then now() else exported_at end,
           retired_at  = case when ${to} = 'retired'  then now() else retired_at end,
           -- A wallet leaving service must not remain the primary one, or the next deposit
           -- assignment would target a wallet the user has told us to stop using. Cleared in the
           -- same statement so no window exists in which it is both retired and primary.
           is_primary = case when ${to} in ('retired','exported') then false else is_primary end
     where id = ${id} and status = ${current.status}
     returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) {
    throw new WalletError(
      'transition_raced',
      'the wallet changed state concurrently; read it again and retry',
    )
  }
  return toWallet(row)
}

/**
 * Make one wallet the primary for its `(user, chain, network)`.
 *
 * Both statements are in one transaction because the partial unique index would otherwise refuse
 * the set before the clear had committed — and, more importantly, because a crash between them
 * leaves the user with no primary wallet at all, which is a state no read path expects.
 */
export async function setPrimary(sql: Db, id: string): Promise<WalletRecord> {
  const outcome = await sql.begin(async (tx) => {
    const wallet = await findWallet(tx, id)
    if (!wallet) throw new WalletNotFoundError(id)
    if (wallet.status === 'retired' || wallet.status === 'exported') {
      throw new WalletError(
        'illegal_primary',
        `a ${wallet.status} wallet cannot be made primary`,
      )
    }
    await tx`
      update wallets set is_primary = false, updated_at = now()
       where user_id = ${wallet.userId} and chain = ${wallet.chain} and network = ${wallet.network}
         and is_primary
    `
    const rows = await tx<WalletRow[]>`
      update wallets set is_primary = true, updated_at = now() where id = ${id}
       returning ${tx.unsafe(COLUMNS)}
    `
    return { value: toWallet(rows[0]!) }
  })
  return outcome.value
}

export async function relabelWallet(
  sql: Db,
  id: string,
  label: string | null,
): Promise<WalletRecord> {
  const rows = await sql<WalletRow[]>`
    update wallets set label = ${label}, updated_at = now() where id = ${id}
     returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new WalletNotFoundError(id)
  return toWallet(row)
}

/** Narrow a string to a `ChainId`, or refuse. Used wherever a chain arrives from a request. */
export function requireChain(value: string): ChainId {
  if (!isChainId(value)) throw new WalletError('unknown_chain', `no such chain: ${value}`)
  return value
}
