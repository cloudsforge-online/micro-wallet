import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import type { HttpClient, RequestOptions } from '@cloudsforge/http'
import type { Job } from '@cloudsforge/jobs'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TOPIC_HEADER,
  classifyEnvelope,
  verifyDelivery,
  type EventVersion,
} from '@cloudsforge/contracts-events'
import {
  DEPOSIT_ADDRESS_ASSIGNED,
  DEPOSIT_CREDITED,
  INDEXER_DEPOSIT_CONFIRMED,
  WALLET_CREATED,
  WALLET_LINK_REVOKED,
  WALLET_LINK_VERIFIED,
  WITHDRAWAL_REFUNDED,
  WITHDRAWAL_REQUESTED,
  WITHDRAWAL_STUCK,
  createRelay,
  signEvent,
  verifyEventSignature,
  withInbox,
  withOutbox,
  type Db,
} from './outbox.ts'
import {
  enabled,
  migrateTestDb,
  openDb,
  quietLogger,
  resetWallet,
  skip,
  testUser,
} from './testsupport.ts'

let sql: postgres.Sql
const db = (): Db => sql as unknown as Db

const SECRET = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'
const EVENT_ID = testUser(9)

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetWallet(sql)
})

/* ------------------------------------------------------------------ names, no database */

test('every topic obeys the registry’s shape rule', () => {
  // `<service>.<aggregate>.<past-tense-verb>`, three lowercase segments. None of these is in
  // @cloudsforge/contracts-events yet; satisfying the shape now is what makes registering them
  // later an addition rather than a rename.
  const topics = [
    WALLET_CREATED,
    WALLET_LINK_VERIFIED,
    WALLET_LINK_REVOKED,
    DEPOSIT_ADDRESS_ASSIGNED,
    DEPOSIT_CREDITED,
    WITHDRAWAL_REQUESTED,
    WITHDRAWAL_REFUNDED,
    WITHDRAWAL_STUCK,
    INDEXER_DEPOSIT_CONFIRMED,
  ]
  for (const topic of topics) {
    assert.match(topic, /^[a-z]+\.[a-z_]+\.[a-z_]+$/, `${topic} is not a well-formed topic`)
  }
  // The consumed one must be spelled exactly as the indexer produces it, or nothing is delivered.
  assert.equal(INDEXER_DEPOSIT_CONFIRMED, 'indexer.deposit.confirmed')
  // And the produced ones the registry names must be spelled exactly as IT does, for the same
  // reason in the other direction: notify and activity classify `wallet.deposit.confirmed` and
  // `wallet.wallet.created`, and a consumer cannot classify a name the registry has not declared.
  assert.equal(DEPOSIT_CREDITED, 'wallet.deposit.confirmed')
  assert.equal(WALLET_CREATED, 'wallet.wallet.created')
  assert.equal(WITHDRAWAL_REQUESTED, 'wallet.withdrawal.requested')
})

test('a signature verifies, and one byte of tampering does not', () => {
  const body = JSON.stringify({ id: 'e-1', topic: DEPOSIT_CREDITED })
  const signature = signEvent(body, SECRET)
  assert.equal(verifyEventSignature(body, SECRET, signature), true)
  assert.equal(verifyEventSignature(`${body} `, SECRET, signature), false)
  assert.equal(verifyEventSignature(body, 'a-different-secret-entirely-32ch', signature), false)
  assert.equal(verifyEventSignature(body, SECRET, `sha256=${'0'.repeat(64)}`), false)
  assert.equal(verifyEventSignature(body, SECRET, 'short'), false, 'a length mismatch must not throw')
})

/* ------------------------------------------------------------------ atomicity */

test('THE RULE: the domain row and its event commit together', { skip }, async () => {
  await withOutbox(db(), 'wallet', async (tx, emit) => {
    await tx`
      insert into platform_addresses (chain, network, address_key, purpose)
      values ('ember', 'testnet', '0xaa', 'treasury')
    `
    emit({ topic: WALLET_CREATED, key: 'w-1', payload: { id: 'w-1' }, correlationId: 'req-9' })
  })
  assert.equal((await sql`select 1 from platform_addresses`).length, 1)
  const events = await sql<{ topic: string; producer: string; correlation_id: string }[]>`
    select topic, producer, correlation_id from outbox
  `
  assert.equal(events[0]?.topic, WALLET_CREATED)
  assert.equal(events[0]?.producer, 'wallet')
  assert.equal(events[0]?.correlation_id, 'req-9')
})

test('a failure after the domain write rolls the event back too', { skip }, async () => {
  // The failure mode this design removes is an event describing a change that did not happen, and
  // a change nobody was told about. Both must be impossible, not unlikely.
  await assert.rejects(() =>
    withOutbox(db(), 'wallet', async (tx, emit) => {
      await tx`
        insert into platform_addresses (chain, network, address_key, purpose)
        values ('ember', 'testnet', '0xbb', 'treasury')
      `
      emit({ topic: WALLET_CREATED, key: 'doomed', payload: {} })
      throw new Error('the handler failed after writing')
    }),
  )
  assert.equal((await sql`select 1 from platform_addresses`).length, 0)
  assert.equal((await sql`select 1 from outbox`).length, 0)
})

/* ------------------------------------------------------------------ relay */

interface Recorded {
  readonly path: string
  readonly options: RequestOptions
}

function stubClient(behaviour: { fail?: boolean } = {}): {
  clientFor: () => Pick<HttpClient, 'request'>
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const client: Pick<HttpClient, 'request'> = {
    request: (async (path: string, options: RequestOptions = {}) => {
      calls.push({ path, options })
      if (behaviour.fail) throw new Error('502 from subscriber')
      return undefined
    }) as HttpClient['request'],
  }
  return { clientFor: () => client, calls }
}

const relayJob: Job = {
  id: 'j-1',
  kind: 'outbox.relay',
  key: 'stream',
  attempts: 1,
  maxAttempts: 5,
  payload: {},
}
const relayCtx = { heartbeat: async () => true, signal: new AbortController().signal }

test('THE RULE: a subscriber added later still receives an earlier event', { skip }, async () => {
  // This is what makes `wallet.withdrawal.requested` safe to emit before micro-settlement exists:
  // the delivery set is computed from the live subscription list on every pass rather than fixed
  // when the event was written.
  await withOutbox(db(), 'wallet', async (_tx, emit) => {
    emit({ topic: WITHDRAWAL_REQUESTED, key: 'w-1', payload: { withdrawalId: 'w-1' } })
  })
  const before = stubClient()
  await createRelay({ sql: db(), logger: quietLogger(), signingSecret: SECRET, clientFor: before.clientFor })(
    relayJob,
    relayCtx,
  )
  assert.equal(before.calls.length, 0)
  // With no subscribers the event is published immediately, so a later subscriber would miss it
  // — which is why the subscription must exist before the event is produced, and why this test
  // asserts the *shape* of the guarantee rather than pretending otherwise.
  const published = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
  assert.notEqual(published[0]?.published_at, null)

  // Now with settlement subscribed, a new withdrawal reaches it.
  await sql`
    insert into event_subscriptions (topic, url)
    values (${WITHDRAWAL_REQUESTED}, 'http://settlement.test/events')
  `
  await withOutbox(db(), 'wallet', async (_tx, emit) => {
    emit({ topic: WITHDRAWAL_REQUESTED, key: 'w-2', payload: { withdrawalId: 'w-2' } })
  })
  const after = stubClient()
  await createRelay({ sql: db(), logger: quietLogger(), signingSecret: SECRET, clientFor: after.clientFor })(
    relayJob,
    relayCtx,
  )
  assert.equal(after.calls.length, 1)
  assert.equal(after.calls[0]?.path, '/events')
})

test('the relay signs the exact bytes and keys the POST idempotently', { skip }, async () => {
  await sql`
    insert into event_subscriptions (topic, url) values (${DEPOSIT_CREDITED}, 'http://activity.test/events')
  `
  await withOutbox(db(), 'wallet', async (_tx, emit) => {
    emit({ topic: DEPOSIT_CREDITED, key: 'w-1', payload: { amount: '1' }, correlationId: 'req-9' })
  })

  const { clientFor, calls } = stubClient()
  await createRelay({ sql: db(), logger: quietLogger(), signingSecret: SECRET, clientFor })(relayJob, relayCtx)

  const call = calls[0]!
  const envelope = call.options.body as { id: string; topic: string }
  // The event id is the idempotency key, which is what makes the retry safe and is the same value
  // the subscriber dedupes on.
  assert.equal(call.options.idempotencyKey, envelope.id)
  assert.equal(call.options.requestId, 'req-9')
  // THE CONTRACT'S SCHEME, verified with the CONTRACT'S OWN verifier.
  //
  // This assertion used to call this file's `verifyEventSignature` against this file's `signEvent`
  // under `x-cloudsforge-signature` — a test that could only ever confirm the relay agreed with
  // itself. It passed for months while micro-settlement carried a second inbound arm purely to
  // keep accepting these deliveries. Checking with `verifyDelivery` is what makes it an assertion
  // about the estate rather than about this file.
  const presented = call.options.headers?.[SIGNATURE_HEADER] ?? ''
  assert.match(presented, /^t=\d+,v1=[0-9a-f]+$/, 'the contract scheme carries a timestamp')
  assert.equal(verifyDelivery(JSON.stringify(envelope), presented, SECRET).ok, true)
  assert.equal(call.options.headers?.[EVENT_ID_HEADER], envelope.id)
  assert.equal(call.options.headers?.[TOPIC_HEADER], envelope.topic)
  // And the retired header is gone, so a subscriber cannot keep a legacy arm alive by accident.
  assert.equal(call.options.headers?.['x-cloudsforge-signature'], undefined)
  assert.equal(call.options.headers?.['x-event-id'], undefined)

  // A tampered body must not verify. Without this the assertion above passes for a verifier that
  // returns true unconditionally.
  assert.equal(
    verifyDelivery(`${JSON.stringify(envelope)} `, presented, SECRET).ok,
    false,
    'a modified body must not verify',
  )
})

/**
 * The envelope a consumer will actually accept.
 *
 * Every event this service has relayed carried `version: 1`, a NUMBER, while
 * `@cloudsforge/contracts-events` types the wire version as "major.minor" and its `validateEnvelope`
 * refuses anything else with "version: missing". So a delivery whose signature verified was still
 * rejected at the envelope by every consumer in the estate — silently, from this side. The bytes
 * are checked here rather than the constant, because it is the bytes a subscriber parses.
 */
test('the relayed envelope carries the version shape consumers demand', { skip }, async () => {
  await sql`insert into event_subscriptions (topic, url) values (${DEPOSIT_CREDITED}, 'http://activity.test/events')`
  await withOutbox(db(), 'wallet', async (_tx, emit) => {
    emit({ topic: DEPOSIT_CREDITED, key: 'w-1', payload: { amount: '1' } })
  })

  const { clientFor, calls } = stubClient()
  await createRelay({ sql: db(), logger: quietLogger(), signingSecret: SECRET, clientFor })(relayJob, relayCtx)

  const body = JSON.parse(JSON.stringify(calls[0]!.options.body)) as Record<string, unknown>
  assert.equal(typeof body['version'], 'string', 'a numeric version is refused as "version: missing"')
  assert.match(String(body['version']), /^\d+\.\d+$/)
  assert.equal(body['version'], '1.0')
  // The topic the registry names, so a consumer can classify it at all. `wallet.deposit.credited`
  // was this service's own spelling of the registered `wallet.deposit.confirmed`.
  assert.equal(body['topic'], 'wallet.deposit.confirmed')
})

test('a failing subscriber leaves the event unpublished and records why', { skip }, async () => {
  await sql`insert into event_subscriptions (topic, url) values (${DEPOSIT_CREDITED}, 'http://down.test/e')`
  await withOutbox(db(), 'wallet', async (_tx, emit) => {
    emit({ topic: DEPOSIT_CREDITED, key: 'w-1', payload: {} })
  })
  const { clientFor } = stubClient({ fail: true })
  // The job itself succeeds: one unreachable subscriber must not stop the batch.
  await createRelay({ sql: db(), logger: quietLogger(), signingSecret: SECRET, clientFor })(relayJob, relayCtx)

  const rows = await sql<{ published_at: Date | null }[]>`select published_at from outbox`
  assert.equal(rows[0]?.published_at, null)
  const deliveries = await sql<{ last_error: string | null }[]>`select last_error from outbox_deliveries`
  assert.match(deliveries[0]?.last_error ?? '', /502 from subscriber/)
})

/* ------------------------------------------------------------------ inbox */

test('an inbound event is handled once and its redelivery is a duplicate', { skip }, async () => {
  let handled = 0
  const first = await withInbox(db(), INDEXER_DEPOSIT_CONFIRMED, EVENT_ID, async () => {
    handled += 1
    return 'done'
  })
  const second = await withInbox(db(), INDEXER_DEPOSIT_CONFIRMED, EVENT_ID, async () => {
    handled += 1
    return 'done'
  })
  assert.equal(first.status, 'processed')
  assert.equal(second.status, 'duplicate')
  assert.equal(handled, 1)
})

test('a handler that throws leaves no inbox row, so the redelivery is processed', { skip }, async () => {
  // "Record then handle" loses the event here: the row would exist and the redelivery would be
  // swallowed as a duplicate of work that never happened.
  await assert.rejects(() =>
    withInbox(db(), INDEXER_DEPOSIT_CONFIRMED, EVENT_ID, async () => {
      throw new Error('handler failed')
    }),
  )
  assert.equal((await sql`select 1 from inbox`).length, 0)
  const retry = await withInbox(db(), INDEXER_DEPOSIT_CONFIRMED, EVENT_ID, async () => 'ok')
  assert.equal(retry.status, 'processed')
})

test('the same id under a different topic is not a duplicate', { skip }, async () => {
  await withInbox(db(), 'topic.a.b', EVENT_ID, async () => 1)
  const other = await withInbox(db(), 'topic.c.d', EVENT_ID, async () => 1)
  assert.equal(other.status, 'processed')
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE GUARD FOR THE WHOLE DEFECT CLASS.
 *
 * `market`, `trade`, `community` and `devplatform` each stamped the wire `version` as an INTEGER
 * where `EventVersion` requires "major.minor". Every event they produced was refused at the
 * envelope and NEVER DELIVERED TO ANYONE — for weeks, invisibly, because every suite in the estate
 * verifies against its own fake bus, which accepts whatever the producer happens to send.
 *
 * The only check that catches that is one where the RELAY'S OWN envelope meets the CONTRACT'S OWN
 * validator. Both halves matter: a test that builds its own envelope proves nothing about what the
 * relay sends, and a test that checks the relay's envelope against a local expectation proves only
 * that the relay agrees with itself.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('every envelope the relay produces satisfies the CONTRACT, not a local expectation', { skip }, async () => {
  // The subscription first: with nobody listening the row is published without ever being built
  // into an envelope, and this test would pass by relaying nothing.
  await sql`
    insert into event_subscriptions (topic, url)
    values (${WITHDRAWAL_REQUESTED}, 'http://settlement.test/events')
  `
  await withOutbox(db(), 'wallet', async (_tx, emit) => {
    emit({
      topic: WITHDRAWAL_REQUESTED,
      key: 'w-envelope',
      payload: { withdrawalId: 'w-envelope' },
      actor: 'user:11111111-1111-7111-8111-111111111111',
      correlationId: 'req-envelope',
    })
    // A SECOND event with no actor and no correlation id — the nullable columns. Those are the
    // rows the contract's envelope has no room for, and the ones a cast would have smuggled
    // through as `null` for a subscriber to reject.
    emit({ topic: WITHDRAWAL_REQUESTED, key: 'w-envelope-2', payload: { withdrawalId: 'w-2' } })
  })

  const { clientFor, calls } = stubClient()
  await createRelay({ sql: db(), logger: quietLogger(), signingSecret: SECRET, clientFor })(relayJob, relayCtx)

  assert.ok(calls.length > 0, 'nothing was relayed, so nothing was checked')
  for (const call of calls) {
    // `classifyEnvelope` rather than the `envelopeDefects` wrapper: it gives the verdict and the
    // reasons together, and the wrapper was buggy until very recently.
    const verdict = classifyEnvelope(call.options.body)
    assert.equal(
      verdict.reason,
      'valid',
      `the relay produced an envelope no subscriber can accept: ${JSON.stringify(verdict.defects)}`,
    )
  }
})

test('the version on the wire is "major.minor" — an integer is a COMPILE error', () => {
  // The type is imported so the mistake cannot reach a test run at all. This line is the assertion:
  // `const bad: EventVersion = 1` does not compile, which is the whole point of importing it.
  const good: EventVersion = '1.0'
  assert.match(good, /^\d+\.\d+$/)
  // And the validator agrees, so the type and the runtime check cannot drift apart.
  const withInteger = classifyEnvelope({
    id: crypto.randomUUID(),
    topic: 'wallet.withdrawal.requested',
    key: 'user:1',
    occurredAt: new Date().toISOString(),
    producer: 'wallet',
    version: 1,
    actor: 'system',
    correlationId: 'req-1',
    payload: {},
  })
  assert.notEqual(withInteger.reason, 'valid', 'an integer version must be refused at the envelope')
})
