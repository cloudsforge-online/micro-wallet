/**
 * **The ten-minute cliff, end to end, through the wiring this service actually uses.**
 *
 * `@cloudsforge/auth` proves the provider in isolation. This file proves the ADOPTION, which is a
 * different claim and the one that was wrong here: wallet had the right seam and the wrong body.
 *
 *     const token = () => env.serviceToken        // src/index.ts, before this change
 *
 * A function called per request, so that a short-TTL token "can be rotated without a restart when
 * identity starts minting them" — returning a string read once at boot from a token that dies in
 * 600 seconds (identity/src/tokens.ts). Every peer call in this service began failing ten
 * minutes into every deployment.
 *
 * WHY THIS SUITE COULD NOT SEE IT, AND WHY THIS FILE IS SHAPED AS IT IS. Every other test here
 * builds a client against a fake peer and calls it immediately. A token minted at the top of such
 * a test is seconds old when it is used, so it is never asked to survive its own lifetime. **A
 * test that mints a token and immediately uses it proves nothing about this defect.** The test
 * below moves a simulated clock eleven minutes past a token it already holds, asserts that token
 * is now REFUSED BY A REAL `Verifier`, and only then asserts the ledger client still works.
 *
 * It goes through the real `httpLedgerClient` — the real `HttpClient`, the real retry and deadline
 * handling, the real `Authorization` header — because "the provider is correct" and "the provider
 * is wired in" are separate failures and only the second one was ever the bug here.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'
import { AUDIENCE, Verifier, serviceTokenProbe } from '@cloudsforge/auth'
import { httpLedgerClient, LedgerUnavailableError } from './ledgerclient.ts'
import { buildUpstreams, type UpstreamEnv } from './upstreams.ts'

const ISSUER = 'https://identity.test'
const IDENTITY = 'http://identity:4000'
const LEDGER = 'http://ledger:4000'
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

/** identity/src/tokens.ts. Unchanged by this fix, and it must stay unchanged. */
const SERVICE_TTL_SECONDS = 600

const T0 = Date.UTC(2026, 7, 3, 12, 0, 0)

/** Move the whole world — the provider's clock and jose's expiry check — to `T0 + ms`. */
function clockAt(ms: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: new Date(T0 + ms) })
}

interface World {
  readonly fetch: typeof globalThis.fetch
  exchanges: number
  ledgerCalls: Array<{ token: string | null; status: number }>
  identityDown: boolean
}

/**
 * A real identity and a real ledger, in the sense that matters: identity signs RS256 tokens with a
 * 600-second expiry against the simulated clock, and the ledger hands whatever it is given to a
 * real `Verifier` and answers 401 when jose says the token is bad. Nothing here decides expiry by
 * hand — which is the point, because deciding it by hand is how a test agrees with the code it is
 * meant to be checking.
 */
async function world(): Promise<World> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  void jwk
  const keySet = (async () => publicKey) as never
  const verifier = new Verifier({ jwksUrl: 'http://unused', issuer: ISSUER, keySet })

  // RS256 is deterministic, so two tokens signed from the same payload at the same simulated
  // instant are the same string. identity mints a uuidv7 jti per token; the counter restores that.
  let jti = 0

  const self: World = {
    exchanges: 0,
    ledgerCalls: [],
    identityDown: false,
    fetch: (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url.startsWith(IDENTITY)) {
        if (self.identityDown) throw new TypeError('fetch failed: ECONNREFUSED')
        if (new Headers(init?.headers).get('authorization') !== `Bearer ${CREDENTIAL}`) {
          return new Response('{"error":"unauthenticated"}', { status: 401 })
        }
        self.exchanges += 1
        const token = await new SignJWT({
          typ: 'service',
          scopes: ['ledger:post', 'ledger:read', 'ledger:reserve'],
          jti: `t-${++jti}`,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuedAt()
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject('service:wallet')
          .setExpirationTime(Math.floor(Date.now() / 1000) + SERVICE_TTL_SECONDS)
          .sign(privateKey)
        return new Response(
          JSON.stringify({
            token,
            service: 'wallet',
            scopes: ['ledger:post', 'ledger:read', 'ledger:reserve'],
            expiresIn: SERVICE_TTL_SECONDS,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        )
      }

      if (self.ledgerCalls.length > 32) throw new Error('the 401 replay is looping')
      const presented = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? null
      if (presented === null) {
        self.ledgerCalls.push({ token: null, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
      try {
        await verifier.principal(presented)
        self.ledgerCalls.push({ token: presented, status: 200 })
        return new Response(JSON.stringify({ balances: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      } catch {
        self.ledgerCalls.push({ token: presented, status: 401 })
        return new Response('{"error":"unauthenticated"}', { status: 401 })
      }
    }) as typeof globalThis.fetch,
  }
  return self
}

/**
 * **`buildUpstreams`, not a hand-rolled client.** This is the whole point of the file.
 *
 * A test that constructs its own `ServiceTokenProvider` and its own `httpLedgerClient` proves the
 * provider works, which is `@cloudsforge/auth`'s job. It proves nothing about whether THIS service
 * uses it, and "this service does not use it" was the defect for months. Going through the real
 * factory means reverting `upstreams.ts` to `const token = () => env.serviceToken` turns the test
 * below red.
 */
function upstreamsFor(
  w: World,
  options: { credential: string | null; onMinted?: () => void },
) {
  const env: UpstreamEnv = {
    identityUrl: IDENTITY,
    identityCredential: options.credential,
    ledgerUrl: LEDGER,
    custodyUrl: 'http://custody:4000',
    indexerUrl: 'http://indexer:4000',
    pricingUrl: 'http://pricing:4000',
    upstreamDeadlineMs: 8_000,
  }
  return buildUpstreams(env, {
    originatingService: 'wallet',
    fetch: w.fetch,
    onEvent: (event) => {
      if (event.kind === 'minted') options.onMinted?.()
    },
  })
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE REGRESSION TEST.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the ledger client still works ELEVEN MINUTES after boot — the ten-minute cliff', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  const { identityTokens: provider, ledger } = upstreamsFor(w, { credential: CREDENTIAL })
  assert.ok(provider, 'buildUpstreams must build a provider when a credential is configured')

  // T+0. Every existing test in this repository stops looking here, and everything is fine.
  await ledger.balances('user:u-1')
  const atBoot = w.ledgerCalls.at(-1)?.token
  assert.equal(w.ledgerCalls.at(-1)?.status, 200)
  assert.ok(atBoot)

  // T+11min.
  clockAt((SERVICE_TTL_SECONDS + 60) * 1000)

  // FIRST — the old seam, modelled exactly and wired to the real HttpClient. `token: () =>
  // env.serviceToken` is a supplier that returns the same string for ever, and there is no
  // authorizedFetch behind it because there was none before this change. It fails, against a real
  // Verifier, for the reason the estate fell over.
  const stale = httpLedgerClient({
    baseUrl: LEDGER,
    token: () => atBoot,
    deadlineMs: 8_000,
    originatingService: 'wallet',
    fetch: w.fetch,
  })
  await assert.rejects(
    () => stale.balances('user:u-1'),
    (err: unknown) => err instanceof LedgerUnavailableError || err instanceof Error,
    'a token read once at boot MUST be dead by now',
  )
  assert.equal(w.ledgerCalls.at(-1)?.status, 401)

  // SECOND — the fix, through the same client factory `src/index.ts` uses. A 200 here can only mean
  // the service obtained a live token for itself: no operator, no restart, no redeploy.
  const before = w.exchanges
  await ledger.balances('user:u-1')
  assert.equal(w.ledgerCalls.at(-1)?.status, 200, 'wallet must still reach the ledger past the first expiry')
  assert.notEqual(w.ledgerCalls.at(-1)?.token, atBoot, 'and with a genuinely new token')
  assert.equal(w.exchanges, before + 1, 'which it minted from the credential')
})

test('a token refreshed mid-life is never presented expired, and never costs a request latency', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  let minted = 0
  const { identityTokens: provider, ledger } = upstreamsFor(w, {
    credential: CREDENTIAL,
    onMinted: () => (minted += 1),
  })
  assert.ok(provider, 'buildUpstreams must build a provider when a credential is configured')
  await ledger.balances('user:u-1')
  const first = w.ledgerCalls.at(-1)?.token

  // 90% through: past the TOP of the provider's jitter band, which is [75%, 85%] of the lifetime.
  // Not 80% — the fraction is drawn per token from `Math.random`, so a clock at exactly the middle
  // of the band refreshes only about half the time, and this test failed that way one run in two
  // before it was pinned here. 90% is still comfortably inside the token's life: 540s of 600s.
  //
  // The refresh runs BEHIND the request: this call still uses the old — and still valid — token,
  // which is the whole reason for refreshing early rather than at expiry.
  clockAt(SERVICE_TTL_SECONDS * 1000 * 0.9)
  await ledger.balances('user:u-1')
  assert.equal(w.ledgerCalls.at(-1)?.token, first, 'the caller did not wait for the mint')
  assert.equal(w.ledgerCalls.at(-1)?.status, 200)

  // Wait for the refresh to SETTLE, and wait on the provider's OWN completion signal. `w.exchanges`
  // counts requests that have arrived at identity, which increments before the token is signed, so
  // waiting on it resumes while the new token is still being minted. A fixed number of ticks is
  // worse again: whatever is enough on this machine is a flake on a slower one, and this test
  // failed exactly that way when the whole suite ran together.
  for (let tick = 0; tick < 2_000 && minted < 2; tick++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(minted, 2, 'the background refresh never ran')

  await ledger.balances('user:u-1')
  assert.notEqual(w.ledgerCalls.at(-1)?.token, first, 'and the next one is on the new token')
  assert.equal(w.ledgerCalls.at(-1)?.status, 200)
})

test('an unreachable identity is a 503 to the caller, never an unauthenticated ledger call', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())

  clockAt(0)
  const { identityTokens: provider, ledger } = upstreamsFor(w, { credential: CREDENTIAL })
  assert.ok(provider, 'buildUpstreams must build a provider when a credential is configured')
  await ledger.balances('user:u-1')

  w.identityDown = true
  clockAt((SERVICE_TTL_SECONDS + 60) * 1000)
  const callsBefore = w.ledgerCalls.length

  await assert.rejects(() => ledger.balances('user:u-1'))
  // The ledger was never dialled. Sending the expired token, or sending none, would have produced
  // a 401 from a perfectly healthy ledger — pointing an operator at the wrong service entirely.
  assert.equal(w.ledgerCalls.length, callsBefore, 'no unauthenticated or stale call reached the ledger')
})

test('with no credential configured the service is NOT ready, and calls fail closed', async (t) => {
  const w = await world()
  t.after(() => mock.timers.reset())
  clockAt(0)

  // `src/index.ts` builds no provider when WALLET_IDENTITY_CREDENTIAL is absent. That is the state
  // this asserts: the image can boot without one so CI can smoke-test /livez, and /readyz is where
  // the absence is enforced.
  const probe = serviceTokenProbe(null)
  assert.equal(probe.kind, 'hard')
  assert.equal((await probe.check()).state, 'fail', 'an unconfigured replica must not take traffic')

  const { ledger } = upstreamsFor(w, { credential: null })
  await assert.rejects(() => ledger.balances('user:u-1'))
  assert.equal(w.ledgerCalls.length, 0, 'and nothing was sent unauthenticated')
})
