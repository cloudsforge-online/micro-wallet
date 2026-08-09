import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createServer as createHttpServer, type Server } from 'node:http'
import type postgres from 'postgres'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { Lifecycle, type Probe } from '@cloudsforge/lifecycle'
import { Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import { httpCustodyClient, type CustodyClient } from './custodyclient.ts'
import { depositCreditKey, type DepositDeps } from './deposits.ts'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  signDelivery,
} from '@cloudsforge/contracts-events'
import { INDEXER_DEPOSIT_CONFIRMED } from './outbox.ts'
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
  options: {
    probes?: Probe[]
    ready?: boolean
    verifier?: Verifier
    deposits?: DepositDeps
    /** The accepted list. A scalar by default, which is what an unrotated deployment passes. */
    eventSigningSecret?: string | readonly string[]
  },
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
    deposits: options.deposits ?? h.deposits,
    withdrawals: h.withdrawals,
    money: h.money,
    portfolio: h.portfolio,
    eventSigningSecret: options.eventSigningSecret ?? SECRET,
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

/**
 * The boundary where `IssuableAssetCode` stops being a compile-time guarantee.
 *
 * Inside the service the TYPE carries the rule, so a retired code cannot reach a posting. A JSON
 * body carries a string, so the rule is re-checked exactly once, here. Both halves are needed and
 * neither is redundant: without the type, an internal caller can still write `'SHARD'`; without
 * this, an external one can.
 */
test('a spend naming a retired asset is refused at the boundary, with a usable message', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'retired-1' }),
      body: JSON.stringify({ amount: '100', reason: 'x', assetCode: 'SHARD' }),
    })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    assert.equal(body.error?.code, 'retired_asset')
    // The message must tell the holder what they CAN still do, because the guard deliberately
    // leaves every route out of a retired asset open.
    assert.match(String(body.error?.message), /transferred, converted or withdrawn/)
    // And nothing moved.
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'SHARD', 'available'), 500n)
    assert.equal(h.ledger.entries.length, 0)
  })
})

test('a spend may name a live asset explicitly', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'BTC', 500n)
  await withServer({}, async (rig) => {
    const res = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'spend-in-btc-1' }),
      body: JSON.stringify({ amount: '100', reason: 'x', assetCode: 'btc' }),
    })
    assert.equal(res.status, 201, 'a lower-cased live asset is accepted and upper-cased')
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'BTC', 'available'), 400n)
  })
})

test('a spend naming an asset the estate does not know is refused', { skip }, async () => {
  await withServer({}, async (rig) => {
    // `BCH`, not `DOGE`. DOGE was the stand-in until `contracts-chain` added it as a real asset,
    // at which point this case stopped testing the unknown-asset branch and started testing the
    // insufficient-balance one — it failed with a 409 rather than passing quietly, which is the
    // only reason it was noticed. Bitcoin Cash is the nearest plausible asset code the estate does
    // not carry; if it is ever added, this fixture has to move again and will say so the same way.
    const res = await fetch(`${rig.url}/v1/spend`, {
      method: 'POST',
      headers: asUser({ 'idempotency-key': 'unknown-1' }),
      body: JSON.stringify({ amount: '100', reason: 'x', assetCode: 'BCH' }),
    })
    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { error?: { code?: string } }).error?.code, 'unknown_asset')
  })
})

test('a spend with a key debits once however many times it is retried', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 500n)
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
    assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 400n)
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

/* ------------------------------------------------------------------ custody, when it says no */

/**
 * A custody that answers over a real socket, exactly what it is told to.
 *
 * **Real, because the behaviour under test begins inside `httpCustodyClient`'s own catch.** A fake
 * `CustodyClient` that threw `CustodyRefusedError` directly would prove only that `server.ts` maps
 * an error somebody handed it — it would still pass if `custodyclient.ts` classified every failure
 * as unavailable, or stopped throwing the typed errors at all. Driving a real HTTP response
 * through `HttpError.peerDecided` is what makes the assertions below say anything.
 */
async function withCustodyAnswering(
  reply: { status: number; body: string },
  fn: (custody: CustodyClient) => Promise<void>,
): Promise<void> {
  const custodyServer = createHttpServer((req, res) => {
    // Drained rather than ignored: an unread request body keeps the socket busy and the client's
    // retry then races the close.
    req.resume()
    res.writeHead(reply.status, { 'content-type': 'application/json' })
    res.end(reply.body)
  })
  await new Promise<void>((resolve) => custodyServer.listen(0, '127.0.0.1', () => resolve()))
  const { port } = custodyServer.address() as AddressInfo
  try {
    await fn(
      httpCustodyClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: () => 'a-service-token',
        // Short, because one of these cases retries: a 5xx is retriable and the client will spend
        // this budget before it gives up.
        deadlineMs: 3_000,
      }),
    )
  } finally {
    await new Promise<void>((resolve) => custodyServer.close(() => resolve()))
  }
}

const assignDeposit = (rig: Rig) =>
  fetch(`${rig.url}/v1/deposits`, {
    method: 'POST',
    headers: asUser(),
    body: JSON.stringify({ assetCode: 'EMBER' }),
  })

test('THE RULE: custody refusing is the caller’s answer, never a 500', { skip }, async () => {
  // A refusal is a decision about this request. Reported as 500 it says "we broke" when the truth
  // is "your request was refused", and the one actionable fact — why — is thrown away.
  await withCustodyAnswering(
    {
      status: 400,
      body: JSON.stringify({
        error: {
          code: 'unknown_chain',
          message: "'ember' is not a chain this service holds keys for",
          requestId: 'custody-req-1',
        },
      }),
    },
    async (custody) => {
      await withServer({ deposits: { ...h.deposits, custody } }, async (rig) => {
        const res = await assignDeposit(rig)
        assert.equal(res.status, 400)
        const body = (await res.json()) as { error: { code: string; message: string; requestId: string } }
        assert.equal(body.error.code, 'unknown_chain')
        assert.match(body.error.message, /not a chain this service holds keys for/)
        // The estate's one error shape, carrying THIS service's request id — not custody's.
        assert.equal(body.error.requestId, res.headers.get('x-request-id'))
        assert.notEqual(body.error.requestId, 'custody-req-1')
        // And the internal address of an internal service is not part of a user-facing message.
        assert.equal(/127\.0\.0\.1|http:\/\//.test(body.error.message), false, body.error.message)

        // Nothing was written. A refused mint must not leave an assignment or a managed wallet
        // behind, because both would claim an address that does not exist.
        assert.equal((await sql`select 1 from deposit_address_assignments`).length, 0)
        assert.equal((await sql`select 1 from wallets`).length, 0)
      })
    },
  )
})

test('custody being unreachable is a 503, which is a retry instruction', { skip }, async () => {
  // 5xx is not a decision: we do not know whether an address was minted. 503 says so and tells the
  // caller it may retry — the same treatment `LedgerUnavailableError` gets, for the same reason.
  await withCustodyAnswering(
    {
      status: 500,
      body: JSON.stringify({ error: { code: 'internal', message: 'the request could not be completed' } }),
    },
    async (custody) => {
      await withServer({ deposits: { ...h.deposits, custody } }, async (rig) => {
        const res = await assignDeposit(rig)
        assert.equal(res.status, 503)
        const body = (await res.json()) as { error: { code: string; message: string } }
        assert.equal(body.error.code, 'custody_unavailable')
        // Custody's own words are NOT repeated: "the request could not be completed" from an
        // upstream would read as a statement about the caller's request, which it is not.
        assert.equal(/could not be completed/.test(body.error.message), false, body.error.message)
      })
    },
  )
})

test('custody refusing THIS service’s token does not sign the caller out', { skip }, async () => {
  // Rule 3 at the head of server.ts, one upstream further out. Custody gates /v1/addresses on
  // `custody:address:create`; a 403 there is OUR service token failing, and passing it through
  // tells a user whose own token is perfectly good that they are no longer authenticated.
  for (const status of [401, 403]) {
    await withCustodyAnswering(
      {
        status,
        body: JSON.stringify({
          error: { code: 'forbidden', message: 'missing required authority: custody:address:create' },
        }),
      },
      async (custody) => {
        await withServer({ deposits: { ...h.deposits, custody } }, async (rig) => {
          const res = await assignDeposit(rig)
          assert.equal(res.status, 503, `custody ${status} reached the caller`)
          assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'custody_unavailable')
        })
      },
    )
  }
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

test('THE SAME DEFECT, ONE ROUTE OVER: an unreadable signature is 400, not 500', { skip }, async () => {
  // `verifySiwe` → `recoverAddress` throws `SignatureError`, which — like the two custody errors —
  // was caught nowhere. `links.ts` translates `SiweError` and rethrows everything else, so any
  // authenticated user could reach a 500 by submitting sixty-four bits of hex.
  const signer = evmSigner()
  await withServer({}, async (rig) => {
    // A fresh challenge per attempt: step 1 of `verifyChallenge` consumes the nonce before the
    // signature is looked at, so reusing one would answer `challenge_unusable` and the assertion
    // below would pass without ever reaching the curve.
    const challengeFor = async (): Promise<string> => {
      const created = await fetch(`${rig.url}/v1/wallets`, {
        method: 'POST',
        headers: asUser(),
        body: JSON.stringify({ chain: 'ember', origin: 'external', address: signer.address }),
      })
      return ((await created.json()) as { challenge: { nonce: string } }).challenge.nonce
    }

    for (const signature of [
      '0xdeadbeef', // not 65 bytes
      `0x${'11'.repeat(64)}ff`, // a recovery byte that is not 27 or 28
      `0x${'00'.repeat(32)}${'11'.repeat(32)}1b`, // r = 0
    ]) {
      const res = await fetch(`${rig.url}/v1/wallets/verify`, {
        method: 'POST',
        headers: asUser(),
        body: JSON.stringify({ nonce: await challengeFor(), signature }),
      })
      assert.equal(res.status, 400, `${signature.slice(0, 12)}… was answered ${res.status}`)
      const body = (await res.json()) as { error: { code: string; requestId: string } }
      assert.equal(body.error.code, 'malformed_signature')
      assert.equal(body.error.requestId, res.headers.get('x-request-id'))
    }
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

/**
 * Deliver as a producer's relay does: the CONTRACT's `signDelivery` under `cf-signature`.
 *
 * This used to sign with a local `sha256=<hex>` under `x-cloudsforge-signature`, agreeing with an
 * intake that no producer in the estate could talk to — a round trip between two copies of the
 * same drift. Signing here the way `contracts-events` signs is what makes these assertions say
 * anything about deliverability.
 */
const deliverEvent = async (rig: Rig, envelope: Record<string, unknown>, secret = SECRET) => {
  const body = JSON.stringify(envelope)
  return fetch(`${rig.url}/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [SIGNATURE_HEADER]: signDelivery(body, secret),
      [EVENT_ID_HEADER]: String(envelope['id']),
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

test('THE RULE: the bytes verified are the bytes acted on', { skip }, async () => {
  // Sign one string, deliver another differing by a single byte. This is the failure a
  // verify-then-reparse implementation cannot detect: it authenticates what the producer sent and
  // then credits what the attacker sent. `readRaw` decodes once and `handleEvent` hands the same
  // string to `verifyDelivery` and to `JSON.parse`, so the tampered body is refused at the door.
  await withServer({}, async (rig) => {
    const assigned = await fetch(`${rig.url}/v1/deposits`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ assetCode: 'EMBER' }),
    })
    const { assignment } = (await assigned.json()) as { assignment: { address: string } }
    const signed = JSON.stringify({
      id: 'cccccccc-0000-4000-8000-000000000001',
      topic: INDEXER_DEPOSIT_CONFIRMED,
      key: 'ember:testnet',
      payload: depositPayload({ address: assignment.address }),
    })
    // One byte: a trailing space. Same JSON, same credit, different bytes.
    const delivered = `${signed} `
    assert.notEqual(signed, delivered)
    assert.deepEqual(JSON.parse(delivered), JSON.parse(signed), 'the tamper must be invisible to a parser')

    const res = await fetch(`${rig.url}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signDelivery(signed, SECRET),
        [EVENT_ID_HEADER]: 'cccccccc-0000-4000-8000-000000000001',
      },
      body: delivered,
    })
    assert.equal(res.status, 401)
    assert.equal((await sql`select 1 from inbox`).length, 0, 'nothing may have been acted on')
    assert.equal((await sql`select 1 from deposit_credits`).length, 0, 'no money may have moved')
    assert.equal(h.ledger.entries.length, 0)
  })
})

test('the retired body-only MAC is refused, so it is not a standing forgery credential', { skip }, async () => {
  // `sha256=<hmac over the body>` under `x-cloudsforge-signature` is what this intake used to
  // accept, and it carried no timestamp — a captured POST to a route that credits money stayed
  // valid for ever. No producer signs it any more, so accepting it would preserve the credential
  // for nobody. Asserted at the WIRE rather than by grepping the source: this is the property.
  await withServer({}, async (rig) => {
    const body = JSON.stringify({
      id: 'dddddddd-0000-4000-8000-000000000001',
      topic: INDEXER_DEPOSIT_CONFIRMED,
      payload: depositPayload(),
    })
    const legacy = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`
    for (const headers of [
      { 'x-cloudsforge-signature': legacy },
      // And under the contract's header too, in case the scheme is smuggled across.
      { [SIGNATURE_HEADER]: legacy },
    ]) {
      const res = await fetch(`${rig.url}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      })
      assert.equal(res.status, 401, `the legacy MAC was accepted under ${Object.keys(headers)[0]}`)
    }
    assert.equal((await sql`select 1 from inbox`).length, 0)
  })
})

/**
 * THE ROTATION PROPERTY.
 *
 * `OUTBOX_SIGNING_SECRET` is one HMAC key shared by every service in the estate, and it has to be
 * replaced. A receiver that accepts exactly one secret makes that impossible to do without an
 * outage: the instant a producer's relay moves to the new key, every delivery to this intake 401s
 * and the relay retries it for ever, so deposit confirmations and settlement outcomes stop
 * arriving while `/livez` stays green — silently, which is the whole problem.
 *
 * So the accepted list is exactly what makes a rolling rotation possible, and this is the case
 * that proves it: the NEW secret is first, and a producer that has not been redeployed yet still
 * signs with the OLD one. Both must be 200 at the same time. The window closes by an operator
 * dropping the old entry, and `keyIndex > 0` is the log line that says the window is still open.
 */
test('THE ROTATION PROPERTY: a delivery signed with the OLD secret still verifies while the new one is first', { skip }, async () => {
  const OLD = SECRET
  const NEW = 'fake-rotated-in-outbox-secret-000'
  await withServer({ eventSigningSecret: [NEW, OLD] }, async (rig) => {
    const assigned = await fetch(`${rig.url}/v1/deposits`, {
      method: 'POST',
      headers: asUser(),
      body: JSON.stringify({ assetCode: 'EMBER' }),
    })
    const { assignment } = (await assigned.json()) as { assignment: { address: string } }

    // The un-redeployed producer: still on the secret that is being rotated OUT, and not first.
    const stale = await deliverEvent(
      rig,
      {
        id: 'eeeeeeee-0000-4000-8000-000000000001',
        topic: INDEXER_DEPOSIT_CONFIRMED,
        key: 'ember:testnet',
        payload: depositPayload({ address: assignment.address, txHash: `0x${'11'.repeat(32)}` }),
      },
      OLD,
    )
    assert.equal(stale.status, 200, 'a producer on the superseded secret was partitioned')
    assert.equal(((await stale.json()) as { decision: { kind: string } }).decision.kind, 'credited')

    // The redeployed producer, on the new secret, in the same window.
    const fresh = await deliverEvent(
      rig,
      {
        id: 'eeeeeeee-0000-4000-8000-000000000002',
        topic: INDEXER_DEPOSIT_CONFIRMED,
        key: 'ember:testnet',
        payload: depositPayload({ address: assignment.address, txHash: `0x${'22'.repeat(32)}` }),
      },
      NEW,
    )
    assert.equal(fresh.status, 200)

    // Widening the list must not widen anything else: a secret that is on neither end is still 401.
    const forged = await deliverEvent(
      rig,
      {
        id: 'eeeeeeee-0000-4000-8000-000000000003',
        topic: INDEXER_DEPOSIT_CONFIRMED,
        payload: depositPayload({ address: assignment.address }),
      },
      'fake-secret-nobody-issued-000000',
    )
    assert.equal(forged.status, 401)
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
