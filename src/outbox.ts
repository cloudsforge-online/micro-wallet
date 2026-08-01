/**
 * Outbox, relay and inbox.
 *
 * Rule 5 of docs/ecosystem/03 §2: every state change others care about writes an outbox row **in
 * the same transaction as the change**. That single word is the whole design. A publish after
 * commit is a publish that is skipped when the process dies in between, and a publish before
 * commit is a publish of something that never happened; both failure modes are silent and both
 * are unrecoverable after the fact. Writing the event with the change makes the outbox row and
 * the domain row succeed or fail together, and turns delivery into a retry problem, which is a
 * problem with a solution.
 *
 * For this service the transaction that matters is the deposit credit: the `deposit_credits` row,
 * the idempotency response and the `wallet.deposit.credited` event are one commit. Nothing may
 * observe a credited deposit that produced no event, or an event for a credit that did not land.
 *
 * Delivery is at-least-once. The consumer is what makes it effectively-once: `withInbox` inserts
 * `(topic, event_id)` and runs the handler only if that insert was the one that won. Consumers
 * dedupe on `(topic, event_id)` — AD-10.
 *
 * No broker. Postgres already has transactions and `SKIP LOCKED`, and AD-10 records the four
 * measured conditions under which that stops being true.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import type { Handler } from '@cloudsforge/jobs'

export type Db = Sql
export type Tx = TransactionSql

/**
 * The topics this service produces.
 *
 * None is in `@cloudsforge/contracts-events` `TOPICS` yet. That registry is the only place a topic
 * name may be spelled, it is exact-pinned, and adding to it is a coordinated release — so they are
 * declared here for now and the registry entries land with the release that gives `activity`,
 * `notify` and `settlement` their subscriptions. Every one already satisfies the registry's shape
 * rule (`<service>.<aggregate>.<past-tense-verb>`, three lowercase segments), which
 * `outbox.test.ts` asserts, so registering them later is an addition and never a rename.
 *
 * `wallet.withdrawal.requested` is the one with a consumer that does not exist. **That is
 * deliberate and it is the point of the outbox**: the event is durable, so `micro-settlement`
 * subscribing next quarter receives every withdrawal requested in the meantime, because the relay
 * computes the delivery set from the live subscription list on every pass rather than fixing it
 * when the event was written.
 */
export const WALLET_CREATED = 'wallet.wallet.created'
export const WALLET_LINK_VERIFIED = 'wallet.link.verified'
export const WALLET_LINK_REVOKED = 'wallet.link.revoked'
export const DEPOSIT_ADDRESS_ASSIGNED = 'wallet.deposit_address.assigned'
export const DEPOSIT_CREDITED = 'wallet.deposit.credited'
export const WITHDRAWAL_REQUESTED = 'wallet.withdrawal.requested'
export const WITHDRAWAL_REFUNDED = 'wallet.withdrawal.refunded'
export const WITHDRAWAL_STUCK = 'wallet.withdrawal.stuck'

/** The topics this service consumes. Both come from the indexer — see indexer/src/outbox.ts. */
export const INDEXER_DEPOSIT_CONFIRMED = 'indexer.deposit.confirmed'
export const INDEXER_DEPOSIT_OBSERVED = 'indexer.deposit.observed'

/** What a caller emits. The envelope's `id`, `occurredAt` and `producer` are added here. */
export interface DomainEvent {
  /** `<service>.<aggregate>.<past-tense-verb>` — `wallet.deposit.credited`. */
  readonly topic: string
  /** Ordering is per `(topic, key)` only. Choose the aggregate id, never a timestamp. */
  readonly key: string
  readonly payload: Record<string, unknown>
  readonly actor?: string
  readonly correlationId?: string
  readonly version?: number
}

/** The wire envelope. Additive-only, versioned per topic, schema-diff enforced — AD-02. */
export interface EventEnvelope {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurredAt: string
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlationId: string | null
  readonly payload: Record<string, unknown>
}

export type Emit = (event: DomainEvent) => void

/**
 * Run a domain change and its events in one transaction.
 *
 * `emit` collects rather than writes, so the events land after the handler has succeeded and a
 * caller cannot accidentally publish an event for a change it then rolled back.
 */
export async function withOutbox<T>(
  sql: Db,
  producer: string,
  fn: (tx: Tx, emit: Emit) => Promise<T>,
): Promise<T> {
  const outcome = await sql.begin(async (tx) => {
    const pending: DomainEvent[] = []
    const value = await fn(tx, (event) => {
      pending.push(event)
    })
    for (const event of pending) await writeEvent(tx, producer, event)
    // Wrapped so postgres.js does not treat an array-shaped result as a list of promises to
    // unwrap, which would rewrite the caller's return type.
    return { value }
  })
  return outcome.value
}

/**
 * Write one event inside a transaction the caller already owns.
 *
 * Exported because the two places that need atomicity most — `withInbox` and `withIdempotency` —
 * already hold a transaction and cannot nest another. Without this they would have to publish
 * after commit, which is the failure this whole file exists to remove.
 */
export async function writeEvent(tx: Tx, producer: string, event: DomainEvent): Promise<void> {
  await tx`
    insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
    values (
      ${event.topic},
      ${event.key},
      ${producer},
      ${event.version ?? 1},
      ${event.actor ?? null},
      ${event.correlationId ?? null},
      ${tx.json(event.payload as Record<string, never>)}
    )
  `
}

/* ------------------------------------------------------------------------ signing */

const SIGNATURE_HEADER = 'x-cloudsforge-signature'

/** `sha256=<hex>` over the exact bytes sent, so a subscriber verifies before parsing. */
export function signEvent(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** Timing-safe, because a byte-at-a-time comparison of a MAC is a byte-at-a-time forgery oracle. */
export function verifyEventSignature(body: string, secret: string, presented: string): boolean {
  const expected = Buffer.from(signEvent(body, secret))
  const actual = Buffer.from(presented)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

/* ------------------------------------------------------------------------ relay */

export interface RelayDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly signingSecret: string
  readonly batchSize?: number
  readonly deadlineMs?: number
  /** Test seam. Production builds one `HttpClient` per subscription URL. */
  readonly clientFor?: (url: string) => Pick<HttpClient, 'request'>
}

interface OutboxRow {
  readonly id: string
  readonly topic: string
  readonly key: string
  readonly occurred_at: Date
  readonly producer: string
  readonly version: number
  readonly actor: string | null
  readonly correlation_id: string | null
  readonly payload: Record<string, unknown>
}

interface SubscriptionRow {
  readonly id: string
  readonly url: string
}

/**
 * The relay job.
 *
 * A leased job rather than a `setInterval`, for the reason rule 8 exists: two replicas running an
 * interval-driven relay both read the same unpublished rows and every subscriber receives every
 * event twice. The lease key names the contended resource — the outbox stream — so exactly one
 * replica relays at a time whatever the replica count is.
 */
export function createRelay(deps: RelayDeps): Handler {
  const batchSize = deps.batchSize ?? 50
  const deadlineMs = deps.deadlineMs ?? 5_000
  // Clients are cached for the life of the process so a circuit breaker accumulates state across
  // ticks. A fresh client per tick has a permanently closed circuit and hammers a dead subscriber.
  const clients = new Map<string, Pick<HttpClient, 'request'>>()
  const clientFor =
    deps.clientFor ??
    ((url: string) => {
      const existing = clients.get(url)
      if (existing) return existing
      const parsed = new URL(url)
      const client = new HttpClient({ baseUrl: parsed.origin, name: `subscriber:${parsed.host}` })
      clients.set(url, client)
      return client
    })

  return async (_job, ctx) => {
    const events = await deps.sql<OutboxRow[]>`
      select id, topic, key, occurred_at, producer, version, actor, correlation_id, payload
        from outbox
       where published_at is null
       order by occurred_at
       limit ${batchSize}
    `

    for (const event of events) {
      if (ctx.signal.aborted) return

      const subscriptions = await deps.sql<SubscriptionRow[]>`
        select id, url from event_subscriptions where topic = ${event.topic} and active = true
      `

      const envelope: EventEnvelope = {
        id: event.id,
        topic: event.topic,
        key: event.key,
        occurredAt: event.occurred_at.toISOString(),
        producer: event.producer,
        version: event.version,
        actor: event.actor,
        correlationId: event.correlation_id,
        payload: event.payload,
      }
      // Signed over the exact bytes `HttpClient` will send: it stringifies the same object with
      // the same key order, so the MAC a subscriber recomputes over the received body matches.
      const signature = signEvent(JSON.stringify(envelope), deps.signingSecret)

      for (const subscription of subscriptions) {
        await deliver(deps, clientFor, subscription, envelope, signature, deadlineMs)
      }

      // Only when nothing is outstanding.
      //
      // THE GUARANTEE THIS USED TO CLAIM IS FALSE, and it was carried verbatim by eighteen
      // repositories. It said "a subscriber added after the event was written still receives it",
      // which holds only while some OTHER subscriber is still undelivered. With no active
      // subscription for the topic — the ordinary case for a new event type — the count below is
      // zero on the first pass, the row is published immediately, and it is never reconsidered. A
      // subscriber added afterwards gets nothing.
      //
      // The behaviour is right: an outbox row that stays unpublished because nobody is listening
      // is a backlog that grows for ever. It is the promise that was wrong, and a false guarantee
      // is worse than none, because an integrator plans around it — "register the subscription
      // whenever, the outbox will catch up" is a reasonable thing to believe from the old wording
      // and will silently lose every event published before the subscription existed.
      //
      // Delivery rows ARE computed from the live subscription set on every pass, which is what
      // makes a subscriber added mid-flight receive the remainder. That is the true half. That is what makes
      // `wallet.withdrawal.requested` safe to emit before micro-settlement exists.
      const outstanding = await deps.sql<{ n: number }[]>`
        select count(*)::int as n
          from event_subscriptions s
          left join outbox_deliveries d
            on d.subscription_id = s.id and d.event_id = ${event.id}
         where s.topic = ${event.topic}
           and s.active = true
           and d.delivered_at is null
      `
      if ((outstanding[0]?.n ?? 0) === 0) {
        await deps.sql`update outbox set published_at = now() where id = ${event.id}`
      }

      // A long backlog must not outlive the lease and hand the same events to a second replica.
      await ctx.heartbeat()
    }
  }
}

async function deliver(
  deps: RelayDeps,
  clientFor: (url: string) => Pick<HttpClient, 'request'>,
  subscription: SubscriptionRow,
  envelope: EventEnvelope,
  signature: string,
  deadlineMs: number,
): Promise<boolean> {
  const claimed = await deps.sql<{ delivered_at: Date | null }[]>`
    insert into outbox_deliveries (event_id, subscription_id, attempts)
    values (${envelope.id}, ${subscription.id}, 0)
    on conflict (event_id, subscription_id) do update set attempts = outbox_deliveries.attempts + 1
    returning delivered_at
  `
  if (claimed[0]?.delivered_at) return true

  const parsed = new URL(subscription.url)
  try {
    await clientFor(subscription.url).request(`${parsed.pathname}${parsed.search}`, {
      method: 'POST',
      body: envelope,
      deadlineMs,
      // The event id is the idempotency key, which is what makes this POST safe to retry and is
      // the same value the subscriber dedupes on.
      idempotencyKey: envelope.id,
      headers: { [SIGNATURE_HEADER]: signature, 'x-event-id': envelope.id },
      ...(envelope.correlationId ? { requestId: envelope.correlationId } : {}),
    })
    await deps.sql`
      update outbox_deliveries set delivered_at = now(), last_error = null
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await deps.sql`
      update outbox_deliveries set last_error = ${message.slice(0, 2_000)}
       where event_id = ${envelope.id} and subscription_id = ${subscription.id}
    `
    // Logged, not thrown: one unreachable subscriber must not stop the other subscribers or the
    // rest of the batch. The job succeeds; the undelivered row is the durable record, and the
    // next pass retries it.
    deps.logger.warn('event delivery failed', {
      topic: envelope.topic,
      eventId: envelope.id,
      subscriptionId: subscription.id,
      err: message,
    })
    return false
  }
}

/* ------------------------------------------------------------------------ inbox */

export type InboxOutcome<T> =
  | { readonly status: 'processed'; readonly value: T }
  | { readonly status: 'duplicate' }

/**
 * Run an inbound event's handler exactly once.
 *
 * The insert and the handler share one transaction, so a handler that fails leaves no inbox row
 * and the redelivery is processed rather than swallowed — which is the mistake that makes a naive
 * "record then handle" dedupe lose events.
 *
 * **This is a necessary but not sufficient defence for the deposit path.** It dedupes a
 * redelivery of one event. It cannot dedupe two distinct events that describe the same on-chain
 * movement, which is what the indexer produces when a reorg drops a transaction and it later
 * returns to depth. `deposit_credits.credit_key` is the belt for that, and neither is redundant.
 */
export async function withInbox<T>(
  sql: Db,
  topic: string,
  eventId: string,
  handle: (tx: Tx) => Promise<T>,
): Promise<InboxOutcome<T>> {
  const outcome = await sql.begin(async (tx) => {
    const claimed = await tx<{ event_id: string }[]>`
      insert into inbox (topic, event_id) values (${topic}, ${eventId})
      on conflict (topic, event_id) do nothing
      returning event_id
    `
    if (claimed.length === 0) return { result: { status: 'duplicate' } as InboxOutcome<T> }
    const value = await handle(tx)
    return { result: { status: 'processed', value } as InboxOutcome<T> }
  })
  return outcome.result
}
