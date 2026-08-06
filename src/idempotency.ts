/**
 * Run a money-moving operation at most once per key.
 *
 * **The shape is taken from `repos/forge-pay/services/pay/src/store.ts`.** That function is
 * the best code in the existing estate and this service inherits its behaviour rather than
 * inventing a second one. What it gets right, and what is preserved here in full:
 *
 *   1. **The claim INSERT and the work share ONE transaction.** The stored response can therefore
 *      never disagree with what actually committed. A design that claims the key in its own
 *      transaction and then does the work has a window in which the key exists and the change does
 *      not — and a retry arriving in that window is answered "already done" for work that never
 *      happened.
 *   2. **A concurrent duplicate blocks rather than races.** The second INSERT waits on the first
 *      transaction's uncommitted row; when that commits, the duplicate reads the stored response
 *      and replays it. A retry can therefore never double-debit or double-credit.
 *   3. **A reused key with a different body is refused, not replayed.** Returning the first
 *      request's answer to a second, different request is worse than an error: the caller believes
 *      the thing it asked for happened.
 *   4. **A claim with no response yet is "in flight", not "done".** If the original transaction
 *      rolled back between the insert and this read, nothing committed, so the honest answer is
 *      "retry" rather than a guess.
 *   5. **Keys are namespaced with the user id**, so one user can neither read nor squat on
 *      another's.
 *
 * ## What this service adds, and why
 *
 * The route is part of the key. forge-pay already does this, and the reason is worth stating: a
 * client that generates one key per user action and reuses it across two endpoints would have its
 * second call answered with the first call's response. `POST /v1/spend` and `POST /v1/transfers`
 * both move Shards, and a caller that sent `retry-42` to both must get two operations.
 *
 * ## What this does NOT replace
 *
 * The ledger has its own idempotency, keyed by the key this service sends it. Both are needed.
 * This one stops the wallet doing its local work twice — writing a withdrawal row, calling
 * custody. The ledger's stops the *posting* happening twice even if this service is restarted
 * mid-request and retries from scratch. Relying on either alone leaves a hole: without this one a
 * retry mints a second withdrawal row against one reservation; without the ledger's, a wallet
 * that crashed after posting but before storing its response re-posts on retry.
 */

import { createHash } from 'node:crypto'
import type { Db, Tx } from './outbox.ts'

/** The claim exists but its transaction has not committed a response yet. The caller retries. */
export class IdempotencyInFlightError extends Error {
  constructor() {
    super('a request with this idempotency key is still in flight; retry shortly')
    this.name = 'IdempotencyInFlightError'
  }
}

/** The same key was presented with a different body. 409, always. */
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('this idempotency key was already used with a different request body')
    this.name = 'IdempotencyKeyReuseError'
  }
}

/** No key at all on a route that requires one. 400 — see `requireIdempotencyKey`. */
export class IdempotencyKeyRequiredError extends Error {
  constructor(route: string) {
    super(
      `${route} requires an Idempotency-Key header of 8 to 200 characters; without one a retry moves money twice`,
    )
    this.name = 'IdempotencyKeyRequiredError'
  }
}

export const MIN_KEY_LENGTH = 8
export const MAX_KEY_LENGTH = 200

/**
 * Read the client's key, or refuse.
 *
 * **Every money route in this service goes through here, including `POST /v1/spend`.** In
 * forge-pay, `/spend` is the one money route that accepts a missing key — its own comment says
 * "without one a retry debits twice" and then proceeds anyway. Games call it on every action, over
 * mobile networks, with clients that retry on timeout; it is the most-retried money route in the
 * estate and the only one that will silently do the work again. That is the defect this function
 * exists to close, and `server.test.ts` asserts the 400.
 */
export function requireIdempotencyKey(route: string, presented: string | undefined): string {
  const key = presented?.trim()
  if (!key || key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    throw new IdempotencyKeyRequiredError(route)
  }
  return key
}

/**
 * A stable fingerprint of a request body, so a reused key with a changed payload is caught.
 *
 * Keys are sorted at every depth before hashing. `JSON.stringify` preserves insertion order, so
 * two semantically identical bodies that serialised their fields in a different order would
 * fingerprint differently and a legitimate retry would be rejected as reuse. Sorting removes a
 * class of false 409 that would be maddening to diagnose from the caller's side.
 *
 * `bigint` is rendered as a string rather than thrown on, because every amount in this service is
 * one and a fingerprint that cannot hash an amount is a fingerprint that cannot see a changed
 * amount.
 */
export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalise(value)).digest('hex')
}

function canonicalise(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'bigint') return `"${value.toString()}"`
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`
}

/**
 * The stored key.
 *
 * Exported because the value sent on to the ledger is derived from it: the two services must agree
 * about what "this operation" means, or a retry that this service replays could still post a
 * second entry there.
 */
export function namespacedKey(userId: string, route: string, clientKey: string): string {
  return `${userId}:${route}:${clientKey}`
}

export interface IdempotentOutcome<T> {
  readonly result: T
  readonly replayed: boolean
}

export interface IdempotencyInput<T> {
  readonly userId: string
  readonly route: string
  readonly clientKey: string
  readonly requestHash: string
  /**
   * The work, and the transaction it runs in.
   *
   * `storedKey` is passed in rather than recomputed because it is what the ledger call must carry:
   * one operation, one key, in both services.
   */
  readonly run: (tx: Tx, storedKey: string) => Promise<T>
}

/**
 * Read a claim without making one.
 *
 * **This exists because of a sharp edge in the ledger's own idempotency**, and the edge is worth
 * stating because it is not obvious from its API. The ledger fingerprints the *entire request
 * body* it receives. So any field that legitimately differs between a request and its retry — a
 * fresh correlation id, a re-quoted conversion rate — produces a different fingerprint there, and
 * the ledger answers a legitimate retry with 409 `idempotency_key_reuse` rather than replaying it.
 *
 * The defence is to not re-derive the request at all on a retry. `peekIdempotency` answers
 * "has this exact operation already completed?" *before* any pricing is done or any upstream call
 * is made, so a retry returns the stored response and never builds a second, differently-shaped
 * request out of a moved market.
 *
 * It is a read and therefore racy: two concurrent first attempts both miss. That is safe, because
 * the ledger deduplicates them on the shared key and `withIdempotency` then serialises the two
 * locally. What it removes is the *common* case, which is the one that would otherwise 409.
 */
export async function peekIdempotency<T>(
  sql: Db,
  userId: string,
  route: string,
  clientKey: string,
  requestHash: string,
): Promise<IdempotentOutcome<T> | null> {
  const key = namespacedKey(userId, route, clientKey)
  const rows = await sql<{ request_hash: string; response: unknown }[]>`
    select request_hash, response from idempotency_keys where key = ${key}
  `
  const existing = rows[0]
  if (!existing) return null
  if (existing.request_hash !== requestHash) throw new IdempotencyKeyReuseError()
  if (existing.response === null || existing.response === undefined) return null
  return { result: existing.response as T, replayed: true }
}

export async function withIdempotency<T>(
  sql: Db,
  input: IdempotencyInput<T>,
): Promise<IdempotentOutcome<T>> {
  const key = namespacedKey(input.userId, input.route, input.clientKey)

  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ key: string }[]>`
      insert into idempotency_keys (key, user_id, route, request_hash)
      values (${key}, ${input.userId}, ${input.route}, ${input.requestHash})
      on conflict (key) do nothing
      returning key
    `

    if (claimed.length === 0) {
      // Someone else holds the key. By the time this read runs, their transaction has either
      // committed (so the response is here) or rolled back (so the row is gone).
      const rows = await tx<{ request_hash: string; response: unknown }[]>`
        select request_hash, response from idempotency_keys where key = ${key}
      `
      const existing = rows[0]
      if (!existing) throw new IdempotencyInFlightError()
      if (existing.request_hash !== input.requestHash) throw new IdempotencyKeyReuseError()
      if (existing.response === null || existing.response === undefined) {
        throw new IdempotencyInFlightError()
      }
      return { value: { result: existing.response as T, replayed: true } }
    }

    const result = await input.run(tx, key)

    await tx`
      update idempotency_keys
         set response = ${tx.json(result as Record<string, never>)}
       where key = ${key}
    `

    return { value: { result, replayed: false } }
  })

  // Wrapped in an object above so postgres.js does not treat an array-shaped result as a list of
  // promises to unwrap, which would rewrite the caller's return type.
  return outcome.value
}

/**
 * How many keys one DELETE claims.
 *
 * An unbounded DELETE over a table that has never been pruned is a single long transaction holding
 * a row lock on everything it removes, producing one enormous batch of dead tuples. Short
 * statements let autovacuum keep up and keep the reaper out of the way of the claim INSERT at the
 * head of every money request.
 */
const REAP_BATCH = 5_000

/**
 * Delete idempotency keys past their TTL. Returns how many rows went.
 *
 * The cutoff is the entire safety argument: expiring a key EARLY means the next replay of it does
 * the work a second time, so the TTL has to outlive every caller's retry horizon rather than be as
 * short as the table would like. Nothing in this estate retries for thirty days, and a row that
 * old with a NULL response is from a transaction that rolled back and is never coming back for its
 * answer.
 */
export async function reapIdempotencyKeys(sql: Db, ttlDays: number): Promise<number> {
  // An ISO string with an explicit cast, not a Date: postgres.js resolves a prepared statement's
  // parameter types from the server's ParameterDescription, and inside a subquery it does not come
  // back with the timestamptz serialiser — a raw Date is then handed to the text encoder and
  // throws ERR_INVALID_ARG_TYPE. The cast removes the question. The string is UTC, which is what
  // the column stores.
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000).toISOString()
  let total = 0
  for (;;) {
    const result = await sql`
      delete from idempotency_keys
       where key in (
         select key from idempotency_keys
          where created_at < ${cutoff}::timestamptz
          limit ${REAP_BATCH}
       )
    `
    total += result.count
    if (result.count < REAP_BATCH) return total
  }
}
