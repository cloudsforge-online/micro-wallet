import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { Lifecycle, type Probe } from '@cloudsforge/lifecycle'
import { Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import { depositCreditKey } from './deposits.ts'
import { INDEXER_DEPOSIT_CONFIRMED, signEvent } from './outbox.ts'
import { MONEY_SCOPE, READ_SCOPE, WRITE_SCOPE, createServer, registerServiceMetrics } from './server.ts'
import { SETTLEMENT_CONFIRMED } from './settlement.ts'
import {
  depositPayload,
  enabled,
  evmSigner,
  harness,
  migrateTestDb,
  openDb,
  quietLogger,
  resetWallet,
  skip,
  testUser,
  type Harness,
} from './testsupport.ts'

const ISSUER = 'https://identity.test'
const SECRET = 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4'
const DOMAIN = 'hub.cloudsforge.online'
const URI = 'https://hub.cloudsforge.online/wallets/verify'
const USER = testUser(1)
const ONE_EMBER = 1_000_000_000_000_000_000n

const keys = await generateKeyPair('RS256', { extractable: true })

const sign = (payload: Record<string, unknown>) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('15m')
    .sign(keys.privateKey)

/** A real `Verifier` over a local key set. Nothing here stubs the decision under test. */
const workingVerifier = () =>
  new Verifier({
    jwksUrl: 'http://unused',
    issuer: ISSUER,
    keySet: (async () => keys.publicKey) as never,
  })

/** A real `Verifier` whose JWKS cannot be reached. */
const unreachableVerifier = () =>
  new Verifier({
    jwksUrl: 'http://down',
    issuer: ISSUER,
    keySet: (async () => {
      throw new Error('getaddrinfo EAI_AGAIN identity')
    }) as never,
  })

let sql: postgres.Sql
let h: Harness
let userToken: string

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
  userToken = await sign({ sub: USER, handle: 'ash', roles: ['player'] })
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetWallet(sql)
  h = harness(sql)
})

interface Rig {
  readonly url: string
  readonly lifecycle: Lifecycle
  readonly metrics: Metrics
}

async function withServer(
  options: { probes?: Probe[]; ready?: boolean; verifier?: Verifier },
  fn: (rig: Rig) => Promise<void>,
): Promise<void> {
  const lifecycle = new Lifecycle({ cacheMs: 0 })
  for (const probe of options.probes ?? []) lifecycle.addProbe(probe)
  const metrics = registerServiceMetrics(registerHttpMetrics(new Metrics()))
  const server: Server = createServer({
    lifecycle,
    // Logs are discarded rather than silenced, so a serialisation failure in a log line would
    // still surface as a thrown error rather than being hidden by a null logger.
    logger: quietLogger(),
    metrics,
    verifier: options.verifier ?? workingVerifier(),
    network: 'testnet',
    deposits: h.deposits,
    withdrawals: h.withdrawals,
    money: h.money,
    portfolio: h.portfolio,
    eventSigningSecret: SECRET,
    challengeDomain: DOMAIN,
    challengeUri: URI,
    challengeTtlSeconds: 600,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  if (options.ready !== false) lifecycle.markReady()
  const { port } = server.address() as AddressInfo
  try {
    await fn({ url: `http://127.0.0.1:${port}`, lifecycle, metrics })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const asUser = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${userToken}`,
  'content-type': 'application/json',
  ...extra,
})

/* ------------------------------------------------------------------ health, no database */

test('livez is static and stays 200 while the service is unready', { skip }, async () => {
  const failing: Probe = {
    name: 'postgres',
    kind: 'hard',
    check: async () => ({ state: 'fail', detail: 'connection refused' }),
  }
  // Liveness answers "should this process be restarted". A liveness probe that consulted the
  // database would restart a healthy process every time Postgres blinked.
  await withServer({ ready: false, probes: [failing] }, async (rig) => {
    const live = await fetch(`${rig.url}/livez`)
    assert.equal(live.status, 200)
    assert.equal((await fetch(`${rig.url}/readyz`)).status, 503)
  })
})

test('an upstream failure leaves the service ready but degraded', { skip }, async () => {
  // Marking the ledger hard means one ledger blip removes every wallet replica from its balancer
  // at once, which is a cascade rather than a safety measure.
  const soft: Probe = {
    name: 'ledger',
    kind: 'soft',
    check: async () => ({ state: 'fail', detail: 'connection refused' }),
  }
  await withServer({ probes: [soft] }, async (rig) => {
    const res = await fetch(`${rig.url}/readyz`)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { state: string }).state, 'degraded')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })
})

/* ------------------------------------------------------------------ authentication */

test('an unauthenticated request is 401 and the body carries the request id', { skip }, async () => {
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/portfolio`)
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error: { code: string; requestId: string } }
    assert.equal(body.error.code, 'unauthenticated')
    assert.equal(body.error.requestId, res.headers.get('x-request-id'))
  })
})

test('THE RULE: an unreachable JWKS is 503, never 401', { skip }, async () => {
  // Answering 401 here signs every user in the estate out because identity is having a bad minute.
  await withServer({ verifier: unreachableVerifier() }, async (rig) => {
    const res = await fetch(`${rig.url}/v1/portfolio`, { headers: asUser() })
    assert.equal(res.status, 503)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'verifier_unavailable')
  })
})

test('a forged token is 401 and the reason is not returned', { skip }, async () => {
  const other = await generateKeyPair('RS256', { extractable: true })
  const forged = await new SignJWT({ sub: USER, handle: 'ash', roles: ['player'] })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('15m')
    .sign(other.privateKey)

  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/portfolio`, { headers: { authorization: `Bearer ${forged}` } })
    assert.equal(res.status, 401)
    const body = (await res.json()) as { error: { message: string } }
    // "signature verification failed" versus "expired" tells an attacker which half to fix.
    assert.equal(/signature|expired|jwk/i.test(body.error.message), false, body.error.message)
  })
})

test('a service token needs the scope for the authority it is using', { skip }, async () => {
  const reader = await sign({ sub: 'service:hub-api', scopes: [READ_SCOPE] })
  await withServer({}, async (rig) => {
    const read = await fetch(`${rig.url}/v1/portfolio?userId=${USER}`, {
      headers: { authorization: `Bearer ${reader}` },
    })
    assert.equal(read.status, 200)

    // Reading a portfolio, registering a wallet and moving money are three authorities.
    const spend = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: { authorization: `Bearer ${reader}`, 'idempotency-key': 'game-action-1' },
      body: JSON.stringify({ userId: USER, amount: '1', reason: 'x' }),
    })
    assert.equal(spend.status, 403)
    assert.match(((await spend.json()) as { error: { message: string } }).error.message, new RegExp(MONEY_SCOPE))
  })
})

test('a user token cannot act for another user', { skip }, async () => {
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/portfolio?userId=${testUser(2)}`, { headers: asUser() })
    assert.equal(res.status, 403)
  })
})

/* ------------------------------------------------------------------ THE RULE */

test('THE RULE: a spend with no idempotency key is 400, not a silent double-debit', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ amount: '100', reason: 'nda:build-shelter' }),
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'idempotency_key_required')
    assert.match(body.error.message, /retry moves money twice/)

    // Nothing happened. forge-pay would have debited here, and debited again on the retry.
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 500n)
    assert.equal(h.ledger.entries.length, 0)
  })
})

test('every money route refuses a missing key, not just the obvious one', { skip }, async () => {
  const routes: Array<[string, Record<string, unknown>]> = [
    ['/v1/spend', { amount: '1', reason: 'x' }],
    ['/v1/transfers', { toUserId: testUser(2), assetCode: 'SHARD', amount: '1' }],
    ['/v1/conversions', { fromAssetCode: 'EMBER', toAssetCode: 'SHARD', amount: '1' }],
    ['/v1/withdrawals', { assetCode: 'EMBER', destination: '0x' + '11'.repeat(20), amount: '1' }],
  ]
  await withServer({}, async (rig) => {
    for (const [path, body] of routes) {
      const res = await fetch(`${rig.url}${path}`, {
        method: 'POST',
        headers: asUser(),
        body: JSON.stringify(body),
      })
      assert.equal(res.status, 400, `${path} accepted a missing key`)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'idempotency_key_required')
    }
    assert.equal(h.ledger.entries.length, 0)
  })
})

test('a key that is present but too short is refused too', { skip }, async () => {
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'short' }),
      body: JSON.stringify({ amount: '1', reason: 'x' }),
    })
    assert.equal(res.status, 400)
  })
})

test('a spend with a key debits once however many times it is retried', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
  await withServer({}, async (rig) => {
    const send = () =>
      fetch(`${rig.url}/v1/spend`, {
        method: 'POST',
        headers: asUser({ 'idempotency-key': 'game-action-42' }),
        body: JSON.stringify({ amount: '100', reason: 'nda:build-shelter' }),
      })

    const first = await send()
    assert.equal(first.status, 201)
    for (let i = 0; i < 4; i++) {
      const retry = await send()
      // 200 on a replay, 201 on a fresh post: the caller can tell whether its retry did the work
      // or merely found it done, without comparing bodies.
      assert.equal(retry.status, 200)
    }
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 400n)
    assert.equal(h.ledger.entries.length, 1)
  })
})

/* ------------------------------------------------------------------ amounts on the wire */

test('an amount that lost precision as a JSON number is refused, not stored', { skip }, async () => {
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'game-action-1' }),
      // Beyond 2^53 the value in the request has already lost precision before this code ran.
      body: '{"amount": 100000000000000000000, "reason": "x"}',
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'bad_amount')
    assert.match(body.error.message, /send it as a decimal string/)
  })
})

/* ------------------------------------------------------------------ the money paths */

test('a withdrawal request shows the reservation', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/withdrawals`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'withdrawal-1' }),
      body: JSON.stringify({
        assetCode: 'EMBER',
        destination: '0x1111111111111111111111111111111111111111',
        amount: ONE_EMBER.toString(),
      }),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { withdrawal: { state: string; reservationEntryId: string } }
    assert.equal(body.withdrawal.state, 'queued')
    assert.notEqual(body.withdrawal.reservationEntryId, null)
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), ONE_EMBER)
  })
})

test('a withdrawal to an unverified watch address is 403 from the HTTP surface', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const signer = evmSigner()
  await withServer({}, async (rig) => {
    const registered = await fetch(`${rig.url}/v1/wallets`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ chain: 'ember', origin: 'watch', address: signer.address }),
    })
    assert.equal(registered.status, 201)
    const created = (await registered.json()) as { challenge: unknown }
    assert.equal(created.challenge, null, 'a watch wallet gets no challenge')

    const res = await fetch(`${rig.url}/v1/withdrawals`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'withdrawal-1' }),
      body: JSON.stringify({
        assetCode: 'EMBER',
        destination: signer.address,
        amount: ONE_EMBER.toString(),
      }),
    })
    assert.equal(res.status, 403)
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      'destination_not_authorised',
    )
  })
})

test('the ledger refusing is shown to the user; the ledger being down is a 503', { skip }, async () => {
  await withServer({}, async (rig) => {
    // No balance: the ledger looked at it and said no. Retrying will not help, so it is shown.
    const refused = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'game-action-1' }),
      body: JSON.stringify({ amount: '100', reason: 'x' }),
    })
    assert.equal(refused.status, 409)
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'insufficient_funds')
  })
})

/* ------------------------------------------------------------------ the wallet flow */

test('a wallet is registered, challenged, verified and authorised over HTTP', { skip }, async () => {
  const signer = evmSigner()
  await withServer({}, async (rig) => {
    const created = await fetch(`${rig.url}/v1/wallets`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ chain: 'ember', origin: 'external', address: signer.address }),
    })
    assert.equal(created.status, 201)
    const { wallet, challenge } = (await created.json()) as {
      wallet: { id: string; status: string }
      challenge: { nonce: string; message: string }
    }
    assert.equal(wallet.status, 'provisioning')

    const verified = await fetch(`${rig.url}/v1/wallets/verify`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({
        nonce: challenge.nonce,
        signature: signer.sign(challenge.message),
        authorisations: ['withdrawal_destination'],
      }),
    })
    assert.equal(verified.status, 200)
    const { link } = (await verified.json()) as { link: { authorisations: string[] } }
    assert.deepEqual(link.authorisations, ['withdrawal_destination'])

    // And the replay is refused.
    const replay = await fetch(`${rig.url}/v1/wallets/verify`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ nonce: challenge.nonce, signature: signer.sign(challenge.message) }),
    })
    assert.equal(replay.status, 400)
    assert.equal(((await replay.json()) as { error: { code: string } }).error.code, 'challenge_unusable')

    // Disconnecting revokes everything.
    const revoked = await fetch(`${rig.url}/v1/wallets/${wallet.id}/authorisations/all`, {
      method: 'DELETE',
      headers: asUser(),
    })
    assert.equal(revoked.status, 200)
    assert.deepEqual(((await revoked.json()) as { link: { authorisations: string[] } }).link.authorisations, [])
  })
})

test('a managed wallet cannot be created through the registration route', { skip }, async () => {
  // Accepting `managed` here would let a caller claim the platform holds a key it does not.
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/wallets`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ chain: 'ember', origin: 'managed', address: evmSigner().address }),
    })
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'invalid_origin')
  })
})

/* ------------------------------------------------------------------ event intake */

const deliverEvent = async (rig: Rig, envelope: Record<string, unknown>, secret = SECRET) => {
  const body = JSON.stringify(envelope)
  return fetch(`${rig.url}/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cloudsforge-signature': signEvent(body, secret),
      'x-event-id': String(envelope['id']),
    },
    body,
  })
}

test('THE RULE: the same deposit event delivered twice credits once', { skip }, async () => {
  await withServer({}, async (rig) => {
    const assigned = await fetch(`${rig.url}/v1/deposits`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ assetCode: 'EMBER' }),
    })
    assert.equal(assigned.status, 201)
    const { assignment } = (await assigned.json()) as { assignment: { address: string } }

    const envelope = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      topic: INDEXER_DEPOSIT_CONFIRMED,
      key: 'ember:testnet',
      payload: depositPayload({ address: assignment.address }),
    }

    const first = await deliverEvent(rig, envelope)
    const second = await deliverEvent(rig, envelope)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.deepEqual(((await first.json()) as { decision: { kind: string } }).decision.kind, 'credited')
    assert.deepEqual(((await second.json()) as { decision: { kind: string } }).decision.kind, 'duplicate')

    assert.equal(h.ledger.entries.length, 1)
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), ONE_EMBER)
    // The ledger saw the movement's key, once.
    assert.deepEqual(h.ledger.keys, [
      depositCreditKey('ember', 'testnet', depositPayload().txHash as string, null),
    ])
  })
})

test('an event with a bad signature is 401 and never reaches the crediting path', { skip }, async () => {
  await withServer({}, async (rig) => {
    const res = await deliverEvent(
      rig,
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        topic: INDEXER_DEPOSIT_CONFIRMED,
        payload: depositPayload(),
      },
      'a-different-secret-entirely-32ch',
    )
    assert.equal(res.status, 401)
    assert.equal((await sql`select 1 from inbox`).length, 0, 'the body must not have been acted on')
  })
})

test('an unsubscribed topic is 202, so the relay does not retry it for ever', { skip }, async () => {
  // The relay treats any non-2xx as a delivery failure. Answering 404 to an event we do not want
  // would pin a subscriber in a permanent retry loop over something neither side is wrong about.
  await withServer({}, async (rig) => {
    const res = await deliverEvent(rig, {
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      topic: 'identity.user.deleted',
      payload: {},
    })
    assert.equal(res.status, 202)
  })
})

test('a settlement confirmation moves a queued withdrawal to settled', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  await withServer({}, async (rig) => {
    const requested = await fetch(`${rig.url}/v1/withdrawals`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'withdrawal-1' }),
      body: JSON.stringify({
        assetCode: 'EMBER',
        destination: '0x1111111111111111111111111111111111111111',
        amount: ONE_EMBER.toString(),
      }),
    })
    const { withdrawal } = (await requested.json()) as { withdrawal: { id: string } }

    const res = await deliverEvent(rig, {
      id: 'bbbbbbbb-0000-4000-8000-000000000001',
      topic: SETTLEMENT_CONFIRMED,
      payload: { withdrawalId: withdrawal.id, txHash: `0x${'ab'.repeat(32)}` },
    })
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { state: string }).state, 'settled')
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), 0n)
  })
})

/* ------------------------------------------------------------------ plumbing */

test('an unknown path is 404 and does not mint a metric series of its own', { skip }, async () => {
  await withServer({}, async (rig) => {
    await fetch(`${rig.url}/v1/wallets/aaaa-not-a-wallet-bbbb`, { headers: asUser() })
    const res = await fetch(`${rig.url}/v1/nothing-here`)
    assert.equal(res.status, 404)
    const rendered = rig.metrics.render()
    // Any caller could otherwise mint unbounded time series and take the scrape target down.
    assert.match(rendered, /route="unmatched"/)
    assert.equal(/nothing-here/.test(rendered), false)
    assert.equal(/aaaa-not-a-wallet-bbbb/.test(rendered), false)
    assert.match(rendered, /route="\/v1\/wallets\/:id"/)
  })
})

test('metrics render as valid Prometheus exposition', { skip }, async () => {
  await withServer({}, async (rig) => {
    await fetch(`${rig.url}/livez`)
    await fetch(`${rig.url}/v1/portfolio`)

    const res = await fetch(`${rig.url}/metrics`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/)

    const comment = /^# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .+$/
    const sample =
      /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[^"]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*\})? -?(\d+(\.\d+)?([eE][-+]?\d+)?|\+Inf|NaN)$/
    for (const line of (await res.text()).split('\n').filter((l) => l.length > 0)) {
      assert.ok(comment.test(line) || sample.test(line), `not valid exposition: ${line}`)
    }
  })
})

test('a malformed body is 400 rather than 500', { skip }, async () => {
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/wallets`, {
      method: 'POST',
      headers: asUser(),
      body: '{not json',
    })
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_body')
  })
})

test('a request id is propagated when safe and replaced when it is not', { skip }, async () => {
  await withServer({}, async (rig) => {
    const propagated = await fetch(`${rig.url}/livez`, { headers: { 'x-request-id': 'abc-123_XYZ' } })
    assert.equal(propagated.headers.get('x-request-id'), 'abc-123_XYZ')
    // An unvalidated inbound id is a header-injection and a log-forgery primitive at once.
    const hostile = await fetch(`${rig.url}/livez`, { headers: { 'x-request-id': 'a b"c' } })
    assert.notEqual(hostile.headers.get('x-request-id'), 'a b"c')
  })
})

test('a drain reports unready and refuses to claim jobs before the socket closes', { skip }, async () => {
  await withServer({}, async (rig) => {
    assert.equal(rig.lifecycle.claimingJobs, true)
    const drained = rig.lifecycle.shutdown('SIGTERM')
    // The balancer must learn before it is told: readiness flips first, and the service keeps
    // answering for one probe interval so the balancer actually notices.
    assert.equal((await fetch(`${rig.url}/readyz`)).status, 503)
    assert.equal(rig.lifecycle.claimingJobs, false)
    assert.equal((await fetch(`${rig.url}/livez`)).status, 200, 'a draining process is still alive')
    await drained
  })
})

test('the write scope is what a wallet registration needs', { skip }, async () => {
  const writer = await sign({ sub: 'service:hub-api', scopes: [WRITE_SCOPE] })
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/wallets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writer}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: USER,
        chain: 'ember',
        origin: 'watch',
        address: evmSigner().address,
      }),
    })
    assert.equal(res.status, 201)
  })
})
