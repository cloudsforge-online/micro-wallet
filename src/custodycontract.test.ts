/**
 * THE SEAM BETWEEN THIS SERVICE AND CUSTODY, DRIVEN OVER A REAL SOCKET.
 *
 * Deposit provisioning is the only way money enters this platform — payments are crypto-native,
 * there is no fiat or mock provider, and a balance is funded by an on-chain deposit to an address
 * custody minted. So `POST /v1/deposits` reaching `POST /v1/addresses` and coming back with an
 * address is not one route among many: it is the funding path.
 *
 * It was broken in BOTH directions at once, and nothing in the estate said so:
 *
 *   1. **This service did not send `orderId`.** `custody/src/server.ts:349` reads it with
 *      `stringField(body, 'orderId')` — no default, unlike the `enumField(..., fallback)` calls
 *      for `network`, `purpose` and `scheme` on the three lines below it — so it is required, and
 *      `stringField` (`custody/src/server.ts:852`) throws `BadRequestError` when it is absent.
 *      `httpCustodyClient` sent `userId`, `chain`, `network` and `purpose` and nothing else, so
 *      every live call answered 400. Measured through the gateway on 2026-08-04:
 *
 *        POST /v1/deposits {"assetCode":"EMBER"}
 *          → 400 {"error":{"code":"bad_request","message":"orderId must be a non-empty string"}}
 *
 *   2. **Custody does not return `custodyKeyUrn`, and never did.** Its success body is
 *      `{ key: <CustodyKeyRecord> }` (`custody/src/server.ts:368`), and `CustodyKeyRecord`
 *      (`custody/src/store.ts:62-74`, built by `toKeyRecord` at `custody/src/store.ts:83`) carries
 *      `address, chain, family, purpose, network, scheme, derivationPath, status, keyVersion,
 *      createdAt, exportedAt` — no URN, and no id of any kind, because `custody_keys` is keyed by
 *      `address` (`custody/src/migrations.ts:98`). This file's client declared the response as a
 *      flat `CustodyAddress` with a `custodyKeyUrn`, so had half 1 been fixed alone, `minted.address`
 *      would have been `undefined` and `canonicaliseAddress` would have thrown on
 *      `undefined.trim()` (`addresses.ts:126`) — a 500 in place of a 400.
 *
 * ── WHY THIS FILE STANDS UP A SERVER RATHER THAN A FAKE `CustodyClient` ──────────────────────
 *
 * Because both defects live *inside* `httpCustodyClient`: one in the request body it builds, one
 * in how it reads the response. A fake client satisfies any assertion about them by construction.
 * `testsupport.ts`'s `fakeCustody()` returns a well-formed `CustodyAddress` with a `custodyKeyUrn`
 * on it — it modelled the contract this service WISHED for, and every deposit test in the suite
 * passed against it while the live path answered 400. That is the defect class this file exists
 * for: a check that cannot fail.
 *
 * ── AND WHY THE STUB VALIDATES RATHER THAN JUST REPLIES ──────────────────────────────────────
 *
 * `custodyLike()` below re-implements custody's *actual* required-field check and its *actual*
 * response envelope, each line carrying the `path:line` it was read from. Every one of those
 * facts is independently pinned from custody's own side, over its own real socket and real
 * database, by `custody/src/addresscontract.test.ts` — so if custody's shape moves, custody goes
 * red naming the field, rather than this file quietly agreeing with a stale copy of it.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type postgres from 'postgres'
import { SignJWT, generateKeyPair } from 'jose'
import { AUDIENCE, Verifier } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, registerHttpMetrics } from '@cloudsforge/telemetry'
import {
  CustodyContractError,
  custodyKeyUrn,
  httpCustodyClient,
  type CustodyClient,
} from './custodyclient.ts'
import { assignDepositAddress } from './deposits.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import {
  enabled,
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
const USER = testUser(41)

const keys = await generateKeyPair('RS256', { extractable: true })

const userToken = await new SignJWT({ sub: USER, handle: 'ember', roles: ['player'] })
  .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
  .setIssuedAt()
  .setIssuer(ISSUER)
  .setAudience(AUDIENCE)
  .setExpirationTime('15m')
  .sign(keys.privateKey)

const verifier = () =>
  new Verifier({
    jwksUrl: 'http://unused',
    issuer: ISSUER,
    keySet: (async () => keys.publicKey) as never,
  })

/* ------------------------------------------------------------------ a custody that behaves */

interface Recorded {
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

interface CustodyLike {
  readonly client: CustodyClient
  readonly seen: readonly Recorded[]
  /** In custody's own spelling, which is what the URN has to carry. */
  readonly mintedAddresses: readonly string[]
  close(): Promise<void>
}

/**
 * Custody's `POST /v1/addresses`, as custody actually implements it.
 *
 * Deliberately NOT a mirror of what this service would like. Each rule below is the line it was
 * read from, and none of them may be relaxed to make a test pass — relaxing one is how the live
 * 400 survived a green suite.
 */
async function custodyLike(
  options: { readonly override?: (body: Record<string, unknown>) => unknown } = {},
): Promise<CustodyLike> {
  const seen: Recorded[] = []
  const mintedAddresses: string[] = []
  let counter = 0

  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        body = {}
      }
      seen.push({
        path: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')]),
        ),
        body,
      })

      // `stringField` — required, non-empty, ≤512 chars (`custody/src/server.ts:852-858`). The
      // three fields custody reads this way for this route are `chain`, `userId` and `orderId`
      // (`custody/src/server.ts:347-349`). `network`, `purpose` and `scheme` are `enumField` with
      // a fallback on the three lines below, which is exactly why they were never missed.
      for (const name of ['chain', 'userId', 'orderId']) {
        const value = body[name]
        if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                code: 'bad_request',
                message: `${name} must be a non-empty string`,
                requestId: 'custody-req',
              },
            }),
          )
          return
        }
      }

      counter += 1
      // `toKeyRecord` (`custody/src/store.ts:83-96`) — every field it publishes, and nothing else.
      // No URN, no id: `custody_keys` is keyed by `address` (`custody/src/migrations.ts:98`).
      const address = `0x${counter.toString(16).padStart(40, 'b')}`
      mintedAddresses.push(address)
      const key: Record<string, unknown> = {
        address,
        chain: String(body['chain']),
        family: 'ember',
        purpose: String(body['purpose'] ?? 'deposit'),
        network: String(body['network'] ?? 'testnet'),
        scheme: String(body['scheme'] ?? 'hd_bip44'),
        derivationPath: `m/44'/60'/0'/0/${counter}`,
        status: 'active',
        keyVersion: 1,
        createdAt: new Date().toISOString(),
        exportedAt: null,
      }
      // `{ status: 201, body: { key } }` — `custody/src/server.ts:368`. The envelope matters as
      // much as the fields: a client that reads the top level finds nothing it wants.
      const reply = options.override ? options.override(body) : { key }
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    seen,
    mintedAddresses,
    client: httpCustodyClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: () => 'a-service-token',
      deadlineMs: 3_000,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeIdleConnections()
        server.close(() => resolve())
      }),
  }
}

async function withCustody(
  fn: (custody: CustodyLike) => Promise<void>,
  options: { readonly override?: (body: Record<string, unknown>) => unknown } = {},
): Promise<void> {
  const custody = await custodyLike(options)
  try {
    await fn(custody)
  } finally {
    await custody.close()
  }
}

/* ------------------------------------------------------------------ the client alone */

test('the request custody is sent carries every field custody requires', async () => {
  await withCustody(async (custody) => {
    await custody.client.createAddress({
      userId: USER,
      chain: 'ember',
      network: 'testnet',
      purpose: 'deposit',
      orderId: 'a-deposit-assignment-id',
      idempotencyKey: 'wallet:deposit:1',
    })

    const sent = custody.seen[0]
    assert.ok(sent, 'custody was never called')
    assert.equal(sent.path, '/v1/addresses')
    // Named individually rather than by a deep-equal, so a future required field fails naming
    // itself instead of failing as "objects differ".
    assert.equal(sent.body['userId'], USER)
    assert.equal(sent.body['chain'], 'ember')
    assert.equal(sent.body['network'], 'testnet')
    assert.equal(sent.body['purpose'], 'deposit')
    assert.equal(
      sent.body['orderId'],
      'a-deposit-assignment-id',
      'custody requires orderId (custody/src/server.ts:349) and it is the signing binding SD-09 ' +
        'compares character for character — a call without it is refused 400 for ever',
    )
  })
})

test('the reply is read out of custody’s `{ key }` envelope, not off the top level', async () => {
  await withCustody(async (custody) => {
    const minted = await custody.client.createAddress({
      userId: USER,
      chain: 'ember',
      network: 'testnet',
      purpose: 'deposit',
      orderId: 'order-1',
      idempotencyKey: 'wallet:deposit:2',
    })

    const sent = custody.seen.at(-1)
    assert.ok(sent)
    assert.equal(minted.address, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1')
    assert.equal(minted.chain, 'ember')
    assert.equal(minted.network, 'testnet')
    assert.equal(minted.scheme, 'hd_bip44')
    assert.equal(minted.derivationPath, "m/44'/60'/0'/0/1")
  })
})

test('the URN is minted here, from the fields custody does publish', async () => {
  await withCustody(async (custody) => {
    const minted = await custody.client.createAddress({
      userId: USER,
      chain: 'ember',
      network: 'testnet',
      purpose: 'deposit',
      orderId: 'order-1',
      idempotencyKey: 'wallet:deposit:3',
    })
    assert.equal(
      minted.custodyKeyUrn,
      `cf:custody:key:ember:testnet:${minted.address}`,
      'custody publishes no URN and no id at all — the handle this service stores has to be ' +
        'derived from what custody does publish, or it is a column full of undefined',
    )
    assert.equal(custodyKeyUrn(minted), minted.custodyKeyUrn)
  })
})

test('a reply that is not custody’s shape fails loudly here, not as a null in the database', async () => {
  await withCustody(
    async (custody) => {
      await assert.rejects(
        () =>
          custody.client.createAddress({
            userId: USER,
            chain: 'ember',
            network: 'testnet',
            purpose: 'deposit',
            orderId: 'order-1',
            idempotencyKey: 'wallet:deposit:4',
          }),
        (err: unknown) => {
          assert.ok(
            err instanceof CustodyContractError,
            `expected CustodyContractError, got ${String(err)}`,
          )
          assert.match(err.message, /address/)
          return true
        },
      )
    },
    // The exact body custody would send if `toKeyRecord` were replaced by the flat shape this
    // client used to declare. Every field this service wants is present; the envelope is not.
    {
      override: () => ({
        custodyKeyUrn: 'cf:custody:key:1',
        address: '0x00000000000000000000000000000000000000c1',
        chain: 'ember',
        network: 'testnet',
        scheme: 'hd_bip44',
      }),
    },
  )
})

test('a scheme custody has never had is refused rather than written to the wallet row', async () => {
  await withCustody(
    async (custody) => {
      await assert.rejects(
        () =>
          custody.client.createAddress({
            userId: USER,
            chain: 'ember',
            network: 'testnet',
            purpose: 'deposit',
            orderId: 'order-1',
            idempotencyKey: 'wallet:deposit:5',
          }),
        CustodyContractError,
      )
    },
    {
      override: (body) => ({
        key: {
          address: '0x00000000000000000000000000000000000000d1',
          chain: String(body['chain']),
          family: 'ember',
          purpose: 'deposit',
          network: String(body['network']),
          scheme: 'plaintext_on_a_postcard',
          derivationPath: null,
          status: 'active',
          keyVersion: 1,
          createdAt: new Date().toISOString(),
          exportedAt: null,
        },
      }),
    },
  )
})

/* ------------------------------------------------------------------ the whole funding path */

let sql: postgres.Sql
let h: Harness

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
  h = harness(sql)
})

test(
  'THE FUNDING PATH: POST /v1/deposits provisions an address against a real custody',
  { skip },
  async () => {
    await withCustody(async (custody) => {
      const lifecycle = new Lifecycle({ cacheMs: 0 })
      const server = createServer({
        lifecycle,
        logger: quietLogger(),
        metrics: registerServiceMetrics(registerHttpMetrics(new Metrics())),
        verifier: verifier(),
        network: 'testnet',
        deposits: { ...h.deposits, custody: custody.client },
        withdrawals: h.withdrawals,
        money: h.money,
        portfolio: h.portfolio,
        eventSigningSecret: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4',
        challengeDomain: 'hub.cloudsforge.online',
        challengeUri: 'https://hub.cloudsforge.online/wallets/verify',
        challengeTtlSeconds: 600,
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      lifecycle.markReady()
      const { port } = server.address() as AddressInfo
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/deposits`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
          body: JSON.stringify({ assetCode: 'EMBER' }),
        })
        const body = (await res.json()) as {
          assignment?: { id: string; address: string; custodyKeyUrn: string; chain: string }
          error?: { code: string; message: string }
        }
        assert.equal(
          res.status,
          201,
          `funding is broken: ${res.status} ${JSON.stringify(body.error ?? body)}`,
        )
        const assignment = body.assignment
        assert.ok(assignment, 'a 201 with no assignment on it')
        assert.match(assignment.address, /^0x[0-9a-fA-F]{40}$/)
        assert.equal(assignment.chain, 'ember')

        // THE URN NAMES CUSTODY'S SPELLING, THE ROW STORES THIS SERVICE'S. Custody minted a
        // lower-case address here; `deposits.ts` re-canonicalises to EIP-55 before writing the row
        // (`deposits.ts:206`) because `address_key` has to match what a deposit event is looked up
        // by. The URN must NOT follow it: `custody_keys` is keyed by the exact string custody
        // stored (`custody/src/migrations.ts:98`), so a URN carrying the checksummed form would
        // name a key custody cannot find. The two differing is the assertion.
        assert.equal(
          assignment.custodyKeyUrn,
          'cf:custody:key:ember:testnet:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
        )
        assert.notEqual(
          assignment.address,
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1',
          'the row is meant to hold the EIP-55 form, so this case no longer proves anything',
        )

        // THE BINDING. custody stores whatever `orderId` minted the address and compares it
        // character for character at signing time (SD-09, 12-security-decisions.md:398;
        // custody/src/gates.ts:182). settlement has to restate it to sweep the deposit, and its
        // only route to it is this row — `settlement/src/server.ts:739` says so in as many words.
        // So the value sent MUST be one this service can still produce later, and the assignment
        // id is that value.
        const sent = custody.seen.at(-1)
        assert.ok(sent, 'custody was never called')
        assert.equal(
          sent.body['orderId'],
          assignment.id,
          'the custody binding must be the assignment id, or a sweep can never restate it',
        )
        assert.equal(sent.body['userId'], USER)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  },
)

test('the assignment row keeps the binding a sweep will have to restate', { skip }, async () => {
  await withCustody(async (custody) => {
    const assignment = await assignDepositAddress(
      { ...h.deposits, custody: custody.client },
      { userId: USER, assetCode: 'EMBER', correlationId: 'corr-1' },
    )
    const sent = custody.seen.at(-1)
    assert.ok(sent)
    assert.equal(sent.body['orderId'], assignment.id)

    const rows = await sql<{ id: string; custody_key_urn: string }[]>`
      select id, custody_key_urn from deposit_address_assignments where user_id = ${USER}
    `
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, assignment.id)
    // Custody's spelling, not the canonicalised one — see the funding-path case above.
    const custodyAddress = custody.mintedAddresses.at(-1)
    assert.ok(custodyAddress)
    assert.equal(rows[0]?.custody_key_urn, `cf:custody:key:ember:testnet:${custodyAddress}`)
  })
})
