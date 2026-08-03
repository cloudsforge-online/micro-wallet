/**
 * The ledger, as this service uses it.
 *
 * **The ledger owns every balance in the platform and this service owns none.** 04-domain-model
 * §11: "No 'user balance' column anywhere outside the ledger's projection. Every service that
 * wants a balance asks the ledger. A cached balance in a product database is the bug that made
 * Crucible's bot state diverge from Pay's." Everything below is a question asked over HTTP, and
 * nothing it returns is written to this service's database as a total.
 *
 * ## Why this is an interface and not just an HttpClient
 *
 * Every test in this repository stubs it. A wallet test that needed a running ledger would be a
 * test nobody runs, and the interesting cases here — a reservation that loses a race, a ledger
 * that answers 409 `insufficient_funds`, a redelivered deposit that must post exactly once — are
 * about what this service does with the ledger's *answers*, which a fake gives faithfully and far
 * more cheaply than a real double-entry system.
 *
 * ## Amounts are strings on the wire, in both directions
 *
 * A JSON number is an IEEE 754 double. An 18-decimal EMBER balance above about 9 EMBER does not
 * survive one, and it does not fail — it comes back subtly wrong. The ledger's own server says the
 * same thing in its header, and `bigint` is what these methods take and return so the conversion
 * happens once, here, rather than at every call site.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type {
  AccountPurpose,
  AccountType,
  Actor,
  EntryKind,
  EntryMetadata,
  LedgerAssetCode,
} from '@cloudsforge/contracts-money'
import type { Scope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry. Named here so the deploy can be derived from it.
 *
 * All three are used, one per family of call site: `POST /entries` is gated on
 * `POST_SCOPE = 'ledger:post'`, `POST /reservations` and `POST /reservations/:id/release` on
 * `RESERVE_SCOPE = 'ledger:reserve'`, and `GET /accounts/:subject/balances` on
 * `READ_SCOPE = 'ledger:read'` (`ledger/src/server.ts:78-80, 346, 431, 470, 499`).
 *
 * `readonly Scope[]` rather than `readonly string[]`: see the header of `custodyclient.ts`.
 */
export const LEDGER_SCOPES: readonly Scope[] = Object.freeze([
  'ledger:post',
  'ledger:read',
  'ledger:reserve',
])

/**
 * The ledger refused on the state of the world rather than on the request.
 *
 * Separate from a transport failure because the two demand opposite responses: this one must be
 * shown to the user and never retried, and a transport failure must be retried and never shown.
 * Collapsing them is how "you have insufficient funds" gets displayed for a network blip.
 */
export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

/** The ledger could not be reached, or answered 5xx. The caller does not know what happened. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export interface AccountRef {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  /** The ledger creates the account if it does not exist, which is why the type travels with it. */
  readonly account: AccountRef
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly metadata?: EntryMetadata
  readonly postings: readonly PostingRequest[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
}

export interface ReserveRequest {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly amount: bigint
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly kind?: EntryKind
  readonly metadata?: EntryMetadata
}

export interface Reservation {
  /** The reservation IS the entry — there is no separate reservations table in the ledger. */
  readonly reservationId: string
  readonly entryId: string
  readonly replayed: boolean
}

export interface ReleaseRequest {
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
}

export interface LedgerBalance {
  readonly accountId: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
  readonly status: string
  /** Smallest units, in the account's own normal direction. */
  readonly amount: bigint
  readonly updatedAt: string | null
}

export interface LedgerClient {
  balances(subject: string): Promise<readonly LedgerBalance[]>
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
  reserve(request: ReserveRequest): Promise<Reservation>
  release(reservationId: string, request: ReleaseRequest): Promise<PostedEntry>
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  /** The service name this ledger's entries are attributed to. Always `wallet`. */
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  const post = async <T>(path: string, body: unknown, idempotencyKey: string): Promise<T> => {
    try {
      // The idempotency key is passed to `HttpClient` as well as sitting in the body, and both
      // matter. In the body it is what the ledger stores and dedupes on; on the request it is what
      // makes the POST retriable at all — `HttpClient` attempts a non-idempotent method exactly
      // once unless a key is present, which is the rule that stops a retried debit charging twice.
      return await client.request<T>(path, { method: 'POST', body, idempotencyKey })
    } catch (err) {
      throw translate(err)
    }
  }

  return {
    async balances(subject) {
      try {
        const body = await client.get<{ balances: readonly RawBalance[] }>(
          `/accounts/${encodeURIComponent(subject)}/balances`,
        )
        return body.balances.map((raw) => ({
          accountId: raw.accountId,
          assetCode: raw.assetCode,
          purpose: raw.purpose,
          type: raw.type,
          status: raw.status,
          amount: BigInt(raw.amount),
          updatedAt: raw.updatedAt,
        }))
      } catch (err) {
        throw translate(err)
      }
    },

    async postEntry(request) {
      const body = await post<{ entry: RawEntry; replayed: boolean }>(
        '/entries',
        {
          kind: request.kind,
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
          postings: request.postings.map((posting) => ({
            direction: posting.direction,
            amount: posting.amount.toString(),
            assetCode: posting.assetCode,
            sequence: posting.sequence,
            account: posting.account,
          })),
        },
        request.idempotencyKey,
      )
      return {
        id: body.entry.id,
        kind: body.entry.kind,
        recordedAt: body.entry.recordedAt,
        replayed: body.replayed,
      }
    },

    async reserve(request) {
      const body = await post<{ reservationId: string; entry: RawEntry; replayed: boolean }>(
        '/reservations',
        {
          subject: request.subject,
          assetCode: request.assetCode,
          amount: request.amount.toString(),
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.kind !== undefined ? { kind: request.kind } : {}),
          ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
        },
        request.idempotencyKey,
      )
      return { reservationId: body.reservationId, entryId: body.entry.id, replayed: body.replayed }
    },

    async release(reservationId, request) {
      const body = await post<{ entry: RawEntry; replayed: boolean }>(
        `/reservations/${encodeURIComponent(reservationId)}/release`,
        {
          originatingService: options.originatingService,
          actor: request.actor,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
          ...(request.description !== undefined ? { description: request.description } : {}),
        },
        request.idempotencyKey,
      )
      return {
        id: body.entry.id,
        kind: body.entry.kind,
        recordedAt: body.entry.recordedAt,
        replayed: body.replayed,
      }
    },
  }
}

interface RawBalance {
  readonly accountId: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
  readonly status: string
  readonly amount: string
  readonly updatedAt: string | null
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

/**
 * Turn an HTTP failure into one of the two things a caller can act on.
 *
 * `HttpError.peerDecided` is the discriminator and it is the right one: a 4xx means the ledger
 * looked at the request and said no, which is a fact worth showing a user. Anything else — 5xx, a
 * timeout, an open circuit — means we do not know whether the entry posted, and the only safe
 * response is to retry with the same idempotency key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
