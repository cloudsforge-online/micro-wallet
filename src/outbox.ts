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
 * the idempotency response and the `wallet.deposit.confirmed` event are one commit. Nothing may
 * observe a credited deposit that produced no event, or an event for a credit that did not land.
 *
 * Delivery is at-least-once. The consumer is what makes it effectively-once: `withInbox` inserts
 * `(topic, event_id)` and runs the handler only if that insert was the one that won. Consumers
 * dedupe on `(topic, event_id)` — AD-10.
 *
 * No broker. Postgres already has transactions and `SKIP LOCKED`, and AD-10 records the four
 * measured conditions under which that stops being true.
 */

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TOPIC_HEADER,
  signDelivery,
  validateEnvelope,
  type EventEnvelope,
  type EventVersion,
} from '@cloudsforge/contracts-events'
import type { Sql, TransactionSql } from 'postgres'
import { HttpClient } from '@cloudsforge/http'
import type { Logger } from '@cloudsforge/telemetry'
import type { Handler } from '@cloudsforge/jobs'

export type Db = Sql
export type Tx = TransactionSql

/**
 * The topics this service produces.
 *
 * Three of them ARE in `@cloudsforge/contracts-events` now — `wallet.wallet.created`,
 * `wallet.deposit.confirmed` and `wallet.withdrawal.requested` — and the second of those is why
 * this comment changed. It used to say none of these was registered and that "registering them
 * later is an addition and never a rename". Two of the three were already registered, and the
 * deposit one WAS a rename: the registry, `notify` and `activity` all spelled it
 * `wallet.deposit.confirmed` while this service emitted `wallet.deposit.credited`, so every
 * confirmed deposit was written, signed, delivered and refused as unclassifiable. It is exactly
 * the defect identity found in `identity.mfa.changed`, and the resolution is the same one: the
 * registry is the only place a topic name is spelled, so the producer moves to the registered
 * name rather than the estate learning a second one.
 *
 * The rest are still unregistered and still shape-legal (`<service>.<aggregate>.<past-tense-verb>`,
 * three lowercase segments), which `outbox.test.ts` asserts.
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
/**
 * Registered as `wallet.deposit.confirmed` — one of the eight FIRST topics of 02 §5.
 *
 * The constant keeps its name because "credited" is what this service does and what the row is
 * called (`deposit_credits`); the WIRE name is the registry's, and the registry's keying is what
 * this emit already used — `keyedBy: 'wallet_id'`, deposits.ts.
 */
export const DEPOSIT_CREDITED = 'wallet.deposit.confirmed'
/**
 * A token transfer arrived at a deposit address and **was not credited** — micro-org#200.
 *
 * The exact opposite fact to `DEPOSIT_CREDITED`, and it needs its own topic for that reason: a
 * consumer that saw only one deposit topic would have to read a field to know whether the news is
 * "your money is spendable" or "your money is here and is not". Two topics make the wrong reading
 * unavailable rather than merely discouraged.
 *
 * **Registered in `contracts-events` before this landed, and that ordering was not optional.**
 * `validateEnvelope` refuses an unregistered name and `createRelay` below quarantines on exactly
 * that verdict rather than delivering — measured on 2026-08-10 against the registry as it then
 * stood, `topic: "wallet.deposit.token_uncredited" is not in this registry; contracts-events may
 * be behind`. An emit added first would have written rows nothing could publish and no user could
 * be told about, which is a quieter version of the silence micro-org#200 is about. micro-contracts
 * #5 registered the topic; micro-notify holds the rule that turns it into the user's mail.
 *
 * The payload carries `userId` explicitly rather than leaving `notify` to derive it. That service
 * falls back to the envelope key only for topics the registry declares `keyed_by: user_id`, and
 * this one is keyed by `wallet_id` — as `wallet.deposit.confirmed` is, so the two opposite deposit
 * facts for one wallet stay ordered against each other instead of racing. Attributing a wallet id
 * to a user is the one mistake a notification service must never make, so the id it needs is sent
 * rather than inferred.
 */
export const DEPOSIT_TOKEN_UNCREDITED = 'wallet.deposit.token_uncredited'
export const WITHDRAWAL_REQUESTED = 'wallet.withdrawal.requested'
export const WITHDRAWAL_REFUNDED = 'wallet.withdrawal.refunded'
export const WITHDRAWAL_STUCK = 'wallet.withdrawal.stuck'
/**
 * A user swapped one asset for another — micro-org#495 §4.
 *
 * **The category it feeds has existed with nothing producing into it.** `activity/src/categories.ts`
 * has listed `conversion` since that service was written and no topic was ever classified into it,
 * so a user who converted one coin into another — often the largest thing they did that day — read
 * a feed that did not mention it and a filter tab that was always empty.
 *
 * Registered in `contracts-events` BEFORE this emit existed, which is not optional and this file's
 * header says why: `validateEnvelope` refuses an unregistered name and `createRelay` quarantines on
 * exactly that verdict, so an emit added first writes rows nothing can publish. micro-contracts#15
 * registered it; micro-activity classifies it; micro-notify has recorded, in writing, that it does
 * NOT notify — the user pressed convert and read the answer in the same request, so there is no
 * news in it and nobody else to tell.
 *
 * Keyed by the LEDGER ENTRY id, which is the registry's `keyed_by: entry_id`, and which is the
 * conversion's whole identity: this service keeps no conversions table, and the same id is what
 * `GET /v1/conversions/:id` takes.
 */
export const CONVERSION_COMPLETED = 'wallet.conversion.completed'

/** The topics this service consumes. Both come from the indexer — see indexer/src/outbox.ts. */
export const INDEXER_DEPOSIT_CONFIRMED = 'indexer.deposit.confirmed'
export const INDEXER_DEPOSIT_OBSERVED = 'indexer.deposit.observed'

/** What a caller emits. The envelope's `id`, `occurredAt` and `producer` are added here. */
export interface DomainEvent {
  /** `<service>.<aggregate>.<past-tense-verb>` — `wallet.deposit.confirmed`. */
  readonly topic: string
  /** Ordering is per `(topic, key)` only. Choose the aggregate id, never a timestamp. */
  readonly key: string
  readonly payload: Record<string, unknown>
  readonly actor?: string
  readonly correlationId?: string
  readonly version?: number
}

/**
 * The wire version, in the CONTRACT's shape.
 *
 * `@cloudsforge/contracts-events` types `EventEnvelope.version` as `${number}.${number}` — a
 * "major.minor" STRING — and `validateEnvelope` refuses an envelope without one, reporting
 * "version: missing". This service typed it `number` end to end and sent `1`, so every event it
 * has ever relayed was rejected at the envelope by every consumer, however correct the signature
 * was. identity hit the same thing and fixed it the same way (identity/src/outbox.ts).
 *
 * The stored column stays an integer — storage records the major — and the mapping to the
 * contract's shape happens here, at the wire, in one place.
 */
const wireVersion = (v: number): EventVersion => `${v}.0`

/**
 * The wire envelope is `@cloudsforge/contracts-events`' — re-exported, not redeclared.
 *
 * A hand-rolled copy is the drift the contract package exists to prevent, and the estate has just
 * paid for it: `market`, `trade`, `community` and `devplatform` were all stamping the wire
 * `version` as an INTEGER where `EventVersion` requires "major.minor", so their events were refused
 * at the envelope and NEVER DELIVERED TO ANYONE — invisible, because every suite tests against its
 * own fake bus. Importing the type makes that a compile error rather than a silent nothing.
 */
export type { EventEnvelope } from '@cloudsforge/contracts-events'

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

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LEGACY MAC IS GONE FROM THIS REPOSITORY, IN BOTH DIRECTIONS. NOTHING HERE CAN MINT ONE.
 *
 * `signEvent` and `verifyEventSignature` lived here — `sha256=<hex>` over the body under
 * `x-cloudsforge-signature` — and this file's header used to say the inbound half was
 * "deliberately unchanged… it moves when indexer moves, not before". Indexer moved. So did
 * settlement, ledger and identity: all four sign with the contract's `signDelivery` under
 * `cf-signature`, and this service was the last verifier of the old scheme in the estate.
 *
 * **What that cost was measured, not inferred.** Against the running estate, a correctly
 * contract-signed `POST /events` carrying a real deposit envelope answered `401 bad_signature`,
 * while the legacy MAC answered 200 — so every deposit confirmation, every settlement outcome and
 * every event any producer has sent this service since they migrated was refused, and the relays
 * have been retrying them ever since. The intake looked healthy the whole time.
 *
 * **No legacy arm was kept, and that is the deliberate part.** `micro-settlement` kept one and
 * metered it, which is defensible where producers remain on the old scheme. None remain here.
 * The old MAC covers the body ALONE with no timestamp, so a captured POST to an intake that
 * CREDITS MONEY stays valid for ever — the same permanent replay credential `micro-admin-api`
 * removed from its audit intake tonight. An arm with no producer to serve is that credential kept
 * alive for nobody, and `verifyDelivery`'s freshness window is the whole reason to move.
 *
 * The functions are deleted rather than left unexported so that nothing in this repository —
 * including a test — can produce the old signature. `outbox.test.ts` pins that absence.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/* ------------------------------------------------------------------------ relay */

/**
 * An outbox row, as the contract's envelope — or the reasons it is not one.
 *
 * The stored row is looser than the wire: `actor` and `correlation_id` are nullable columns and
 * `topic` and `producer` are free text, while `EventEnvelope` requires an `Actor`, a non-null
 * `correlationId`, a registered `TopicName` and a known `ProducerService`. Rather than cast that
 * gap away, this builds the envelope and hands it to the CONTRACT'S OWN `validateEnvelope`, so the
 * relay's idea of a valid event and a subscriber's are the same function.
 *
 * `system` for a missing actor is the contract's own value for "no principal did this" — a
 * scheduled sweep or a reconciliation — which is exactly what a null actor column means here.
 * A missing correlation id falls back to the event id: an id that ties the event to itself is
 * weaker than one that ties it to the request, but it is never absent, and an absent one is where
 * a cross-service investigation stops.
 */
function buildEnvelope(
  row: OutboxRow,
): { ok: true; value: EventEnvelope } | { ok: false; defects: readonly string[] } {
  const candidate = {
    id: row.id,
    topic: row.topic,
    key: row.key,
    occurredAt: row.occurred_at.toISOString(),
    producer: row.producer,
    version: wireVersion(row.version),
    actor: row.actor ?? 'system',
    correlationId: row.correlation_id ?? row.id,
    payload: row.payload,
  }
  const verdict = validateEnvelope(candidate)
  return verdict.ok
    ? { ok: true, value: verdict.value }
    : { ok: false, defects: verdict.errors }
}

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
         and quarantined_at is null
       order by occurred_at
       limit ${batchSize}
    `

    for (const event of events) {
      if (ctx.signal.aborted) return

      const subscriptions = await deps.sql<SubscriptionRow[]>`
        select id, url from event_subscriptions where topic = ${event.topic} and active = true
      `

      const built = buildEnvelope(event)
      if (!built.ok) {
        // REFUSED HERE RATHER THAN SENT. An envelope the contract rejects is one every subscriber
        // rejects, so relaying it burns a retry budget delivering something nobody can accept —
        // and `market`, `trade`, `community` and `devplatform` all shipped exactly that for weeks
        // without noticing, because their suites verified against their own fake buses.
        //
        // QUARANTINED, not merely skipped. Skipping left the row at the head of the relay's
        // `order by occurred_at limit N` window, so it was re-read and re-logged every tick — and
        // once N such rows accumulated the window held nothing else and the relay could no longer
        // deliver ANY event. On mainnet that had already happened: 50 unregistered-topic rows were
        // starving 194 `wallet.wallet.created` and, more to the point, a `wallet.withdrawal.
        // requested` — the one topic with a live subscriber. A poison row is not a transient
        // failure and must not be able to hold the money path behind it.
        //
        // Still unpublished, still visible, still replayable: see migration 11. Clearing
        // `quarantined_at` returns the row to the window, which is what the dead-letter drain does
        // once the producer or the registry is fixed.
        await deps.sql`
          update outbox
             set quarantined_at = now(), quarantine_reason = ${built.defects.join('; ')}
           where id = ${event.id}
        `
        // One line per row rather than one per row per tick: the row leaves the window here, so
        // this cannot repeat for it. That is the whole of the 13,650-errors-in-five-minutes flood.
        deps.logger.error('outbox row is not a valid envelope; quarantined, not relayed', {
          eventId: event.id,
          topic: event.topic,
          defects: built.defects,
        })
        continue
      }
      const envelope = built.value
      // THE CONTRACT'S SCHEME, not a local one: `t=<seconds>,v1=<hmac over "seconds.body">`.
      //
      // This relay used to roll its own `sha256=<hex>`, which is the drift `@cloudsforge/contracts-
      // events` exists to prevent — and it had a live cost: micro-settlement had migrated to the
      // contract and was carrying a second inbound arm purely to keep accepting wallet's events.
      // That arm can now be retired.
      //
      // The timestamp is INSIDE the signed message rather than beside it, so it cannot be moved
      // without invalidating the signature, which is what makes a subscriber's freshness window
      // mean anything — the old scheme had no timestamp at all and no replay bound.
      //
      // Signed over the exact bytes `HttpClient` will send: it stringifies the same object with
      // the same key order, so the MAC a subscriber recomputes over the received body matches.
      const signature = signDelivery(JSON.stringify(envelope), deps.signingSecret)

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
      headers: {
        [SIGNATURE_HEADER]: signature,
        [EVENT_ID_HEADER]: envelope.id,
        [TOPIC_HEADER]: envelope.topic,
      },
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
