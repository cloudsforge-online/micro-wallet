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
 *   1. **This service did not send `orderId`.** `custody/src/server.ts` reads it with
 *      `stringField(body, 'orderId')` — no default, unlike the `enumField(..., fallback)` calls
 *      for `network`, `purpose` and `scheme` on the three lines below it — so it is required, and
 *      `stringField` (`custody/src/server.ts`) throws `BadRequestError` when it is absent.
 *      `httpCustodyClient` sent `userId`, `chain`, `network` and `purpose` and nothing else, so
 *      every live call answered 400. Measured through the gateway on 2026-08-04:
 *
 *        POST /v1/deposits {"assetCode":"EMBER"}
 *          → 400 {"error":{"code":"bad_request","message":"orderId must be a non-empty string"}}
 *
 *   2. **Custody does not return `custodyKeyUrn`, and never did.** Its success body is
 *      `{ key: <CustodyKeyRecord> }` (`custody/src/server.ts`), and `CustodyKeyRecord`
 *      (`custody/src/store.ts`, built by `toKeyRecord` at `custody/src/store.ts`) carries
 *      `address, chain, family, purpose, network, scheme, derivationPath, status, keyVersion,
 *      createdAt, exportedAt` — no URN, and no id of any kind, because `custody_keys` is keyed by
 *      `address` (`custody/src/migrations.ts`). This file's client declared the response as a
 *      flat `CustodyAddress` with a `custodyKeyUrn`, so had half 1 been fixed alone, `minted.address`
 *      would have been `undefined` and `canonicaliseAddress` would have thrown on
 *      `undefined.trim()` (`addresses.ts`) — a 500 in place of a 400.
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

import { networkSql, type NetworkSql } from '@cloudsforge/db'
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
  CustodyRefusedError,
  custodyKeyUrn,
  httpCustodyClient,
  type CustodyClient,
} from './custodyclient.ts'
import { CHAIN_IDS, custodyChainOf, type ChainId } from './addresses.ts'
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
  options: {
    readonly override?: (body: Record<string, unknown>) => unknown
    /**
     * Answer every provisioning call 409 `idempotency_conflict`.
     *
     * The only way to reach that refusal for real is to lose a race, and a test that has to win a
     * race to assert something is a test that stops asserting it on a slow machine. This is the
     * refusal held still: custody has decided somebody else is already provisioning this, and what
     * is under test is what THIS service does about it.
     */
    readonly alwaysConflict?: boolean
  } = {},
): Promise<CustodyLike> {
  const seen: Recorded[] = []
  const mintedAddresses: string[] = []
  let counter = 0
  /** `(created_by, idempotency_key)` → the request it was first used for. One caller, so just the key. */
  const byIdempotencyKey = new Map<string, { address: string; orderId: string; key: Record<string, unknown> }>()

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

      // `stringField` — required, non-empty, ≤512 chars (`custody/src/server.ts`). The
      // three fields custody reads this way for this route are `chain`, `userId` and `orderId`
      // (`custody/src/server.ts`). `network`, `purpose` and `scheme` are `enumField` with
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

      const errorReply = (status: number, code: string, message: string) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code, message, requestId: 'custody-req' } }))
      }

      if (options.alwaysConflict) {
        return errorReply(409, 'idempotency_conflict', 'this idempotency key has already been used')
      }

      /*
       * IDEMPOTENCY, AS CUSTODY IMPLEMENTS IT SINCE ITS MIGRATION 6.
       *
       * `idempotency-key` is a HEADER, set by `@cloudsforge/http` from `request.idempotencyKey` and
       * read by custody at `custody/src/server.ts`. Same key and same binding is a replay: 200,
       * `reused: true`, and the ORIGINAL address. Same key and a DIFFERENT `orderId` is a 409, not
       * an address — custody refuses rather than hand back a key bound to another order, because
       * settlement restates `orderId` to sweep and a mismatch is a sweep refused for ever.
       */
      const header = req.headers['idempotency-key']
      const idemKey = typeof header === 'string' ? header : undefined
      if (idemKey !== undefined) {
        const prior = byIdempotencyKey.get(idemKey)
        if (prior) {
          if (prior.orderId !== String(body['orderId'])) {
            return errorReply(409, 'idempotency_conflict', 'this idempotency key has already been used')
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ key: prior.key, reused: true }))
          return
        }
      }

      counter += 1
      // `toKeyRecord` (`custody/src/store.ts`) — every field it publishes, and nothing else.
      // No URN, no id: `custody_keys` is keyed by `address` (`custody/src/migrations.ts`).
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
      if (idemKey !== undefined) {
        byIdempotencyKey.set(idemKey, { address, orderId: String(body['orderId']), key })
      }
      // `{ status: 201, body: { key } }` — `custody/src/server.ts`. The envelope matters as
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
  options: Parameters<typeof custodyLike>[0] = {},
): Promise<void> {
  const custody = await custodyLike(options)
  try {
    await fn(custody)
  } finally {
    await custody.close()
  }
}

/* ------------------------------------------------------------------ the client alone */

test('THE CHAIN ON THE WIRE IS CUSTODY NAME, NOT THIS SERVICE SLUG', async () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * A THIRD DEFECT IN THIS SEAM, FOUND THE SAME WAY THE FIRST TWO WERE, AND LIVE FOR THREE ASSETS
   * BEFORE LITECOIN EXISTED.
   *
   * Custody's `CHAIN_ASSET` is keyed by chain NAME — `ethereum`, `bitcoin`, `litecoin`, `solana`,
   * `xrp`, `ember` — and `custody/src/server.ts` refuses anything outside those keys with 400
   * `unknown_chain`. This service's `ChainId` is the asset code lowercased. They agree on two of
   * six and disagree on four, and this client sent the slug verbatim. So `POST /v1/deposits` for
   * ETH, BTC and SOL was answering 400 from custody — the FUNDING PATH, for three assets that
   * shipped.
   *
   * **The reason no test saw it is the reason this case exists: the test above pins `ember`, and
   * `ember` is one of the two slugs that happens to equal its own chain name.** A contract test
   * that exercises one value proves the contract for one value. Every disagreeing chain is
   * asserted below, so adding a chain without a translation entry fails here.
   *
   * It has now done that once. `doge` and `etc` were added to `ChainId` and this case failed on the
   * set assertion before either had a `CUSTODY_CHAIN` row — which is the whole of its value, and
   * the reason the count is asserted rather than the pairs alone.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const expected: ReadonlyArray<readonly [ChainId, string]> = [
    ['ember', 'ember'],
    ['xrp', 'xrp'],
    ['eth', 'ethereum'],
    ['btc', 'bitcoin'],
    ['sol', 'solana'],
    ['ltc', 'litecoin'],
    ['doge', 'dogecoin'],
    // The one that is not a lengthening. Custody's name is hyphenated because that is how the rest
    // of the estate already spells it — the chain datadir and `pricing`'s CoinGecko id are both
    // `ethereum-classic` — and `etc`, `ethereumclassic` and `ethereum_classic` would each be
    // refused 400 `unknown_chain`, indistinguishably from a custody outage.
    ['etc', 'ethereum-classic'],
  ]
  await withCustody(async (custody) => {
    for (const [slug, name] of expected) {
      await custody.client.createAddress({
        userId: USER,
        chain: slug,
        network: 'testnet',
        purpose: 'deposit',
        orderId: `order-${slug}`,
        idempotencyKey: `wallet:deposit:${slug}`,
      })
    }
    expected.forEach(([slug, name], i) => {
      assert.equal(
        custody.seen[i]?.body['chain'],
        name,
        `${slug} must reach custody as '${name}' — it refuses its own unknown chains with 400`,
      )
    })
    // Stated as a set too: every chain this service knows must have a translation, so a new
    // ChainId with no entry sends `undefined` and is caught here rather than in production.
    assert.equal(expected.length, CHAIN_IDS.length, 'every ChainId must be covered by this case')
    for (const chain of CHAIN_IDS) {
      assert.equal(typeof custodyChainOf(chain), 'string', `${chain} has no custody chain name`)
    }
  })
})

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

test('THE CONTRACT: a repeat under one key is a 200 replay, and reads exactly like a 201', async () => {
  // Custody answers a replay 200 with `{ key, reused: true }` rather than 201, deliberately: a 201
  // would tell this service — and every log and dashboard reading the status — that an address was
  // created. This client must not care, and this asserts it does not: same address, same shape, no
  // throw. `HttpClient` treats any 2xx as an answer, so the only way this breaks is a future status
  // check written here.
  await withCustody(async (custody) => {
    const request = {
      userId: USER,
      chain: 'ember',
      network: 'testnet',
      purpose: 'deposit',
      orderId: 'a-deposit-assignment-id',
      idempotencyKey: 'wallet:deposit:alice:EMBER:testnet:first',
    } as const
    const first = await custody.client.createAddress(request)
    const second = await custody.client.createAddress(request)
    assert.equal(second.address, first.address, 'a retry must be given the address already published')
    assert.equal(second.custodyKeyUrn, first.custodyKeyUrn)
    assert.equal(custody.mintedAddresses.length, 1, 'and custody must have minted exactly once')
  })
})

test('THE CONTRACT: one key over two orders is a refusal this service can recognise', async () => {
  // The 409 has to arrive as something `deposits.ts` can branch on, which means `code`, not a
  // message. `CustodyRefusedError` carries it because `translate()` parses custody's error envelope
  // rather than reporting the transport's own summary.
  await withCustody(async (custody) => {
    const base = {
      userId: USER,
      chain: 'ember',
      network: 'testnet',
      purpose: 'deposit',
      idempotencyKey: 'wallet:deposit:alice:EMBER:testnet:first',
    } as const
    await custody.client.createAddress({ ...base, orderId: 'assignment-1' })
    await assert.rejects(
      () => custody.client.createAddress({ ...base, orderId: 'assignment-2' }),
      (err: unknown) => {
        assert.ok(err instanceof CustodyRefusedError, 'a 409 is custody deciding, not custody being unavailable')
        assert.equal(err.status, 409)
        assert.equal(err.code, 'idempotency_conflict')
        return true
      },
    )
    assert.equal(custody.mintedAddresses.length, 1)
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
        sql: singleNetworkSql(sql),
        singleNetwork: 'testnet' as const,
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
        // (`deposits.ts`) because `address_key` has to match what a deposit event is looked up
        // by. The URN must NOT follow it: `custody_keys` is keyed by the exact string custody
        // stored (`custody/src/migrations.ts`), so a URN carrying the checksummed form would
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
        // character for character at signing time (SD-09, 12-security-decisions.md;
        // custody/src/gates.ts). settlement has to restate it to sweep the deposit, and its
        // only route to it is this row — `settlement/src/server.ts` says so in as many words.
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

test('a 409 from custody returns the assignment that already exists, not an error', { skip }, async () => {
  /*
   * THE LOSER OF A DOUBLE-TAP GETS THE WINNER'S ADDRESS.
   *
   * Two calls that both got past `activeAssignment` send custody two different `orderId`s under one
   * derived key, so custody refuses the second — see `CreateAddressRequest.idempotencyKey`. The
   * refusal is not this caller's problem to report: the address it was asking for now exists, and
   * the right answer is to go and read it.
   *
   * Driven with a custody that refuses unconditionally rather than by racing two calls, because a
   * race that has to be won to assert anything asserts nothing on a machine that schedules it the
   * other way.
   */
  await withCustody(async (custody) => {
    const winner = await assignDepositAddress(
      { ...h.deposits, custody: custody.client },
      { userId: USER, assetCode: 'EMBER', correlationId: 'corr-1' },
    )

    await withCustody(
      async (conflicting) => {
        const loser = await assignDepositAddress(
          { ...h.deposits, custody: conflicting.client },
          // `rotate` is what gets past the find-or-create check, which is the position a racing
          // caller is in: it looked, saw nothing, and by the time it asked custody it was second.
          { userId: USER, assetCode: 'EMBER', correlationId: 'corr-2', rotate: true },
        )
        assert.equal(loser.id, winner.id, 'the loser must be handed the winner’s assignment')
        assert.equal(loser.address, winner.address)
      },
      { alwaysConflict: true },
    )

    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from deposit_address_assignments where user_id = ${USER}
    `
    assert.equal(rows[0]?.n, 1, 'and there is still exactly one assignment, on one address')
  })
})

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

/**
 * One handle, presented as the per-network selector `createServer` now takes.
 *
 * The suites run against a single test database, so testnet is the only configured network — which
 * exercises the REFUSAL path for free: anything asking this for mainnet throws rather than quietly
 * reusing the handle it does have. In wallet that refusal is the difference between a 500 somebody
 * fixes and a user being shown the other estate's money.
 */
function singleNetworkSql(handle: unknown): NetworkSql {
  return networkSql({ testnet: handle as never })
}
