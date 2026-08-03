import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * A valid environment, applied to the process before `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all. The
 * failure cases below go through `loadEnv`, which is pure over its source and therefore testable
 * without a child process.
 */
const BASE: Record<string, string> = {
  WALLET_DATABASE_URL: 'postgres://wallet:wallet@127.0.0.1:5432/wallet',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: 'K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4',
  LEDGER_URL: 'http://127.0.0.1:4004',
  CUSTODY_URL: 'http://127.0.0.1:4005',
  INDEXER_URL: 'http://127.0.0.1:4006',
  PRICING_URL: 'http://127.0.0.1:4007',
  WALLET_CHALLENGE_DOMAIN: 'hub.cloudsforge.online',
  WALLET_CHALLENGE_URI: 'https://hub.cloudsforge.online/wallets/verify',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/**
 * The credential is NOT in `BASE`, because it is not required — see the field comment in `env.ts`.
 * `WALLET_SERVICE_TOKEN` is not there either: it was removed, and the tests below assert that its
 * absence is fine and its presence is reported rather than silently obeyed.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

const { EnvError, SERVICE, env: eager, loadEnv, parseFeeQuotes } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(SERVICE, 'wallet')
  assert.equal(eager.databaseUrl, BASE['WALLET_DATABASE_URL'])
  assert.equal(eager.network, 'testnet')
})

test('a valid environment loads with the documented defaults', () => {
  const env = loadEnv(BASE, 'host-1')
  assert.equal(env.port, 4000)
  // Testnet by default. A deployment that means mainnet must say so, because the consequence of
  // getting it wrong silently is an address on a chain nothing watches.
  assert.equal(env.network, 'testnet')
  assert.equal(env.withdrawalsEnabled, true)
  assert.equal(env.withdrawalMinFeeMultiple, 3)
  assert.equal(env.instanceId, 'host-1')
  assert.deepEqual(env.feeQuotes, {})
})

test('a missing variable names itself', () => {
  for (const name of Object.keys(BASE)) {
    const source = { ...BASE }
    delete source[name]
    assert.throws(
      () => loadEnv(source),
      (err: unknown) => err instanceof EnvError && err.message.includes(name),
      `${name} did not name itself`,
    )
  }
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The credential that replaced WALLET_SERVICE_TOKEN. See `env.ts` and `@cloudsforge/auth`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the identity credential is read, and its absence is a null rather than a throw', () => {
  assert.equal(loadEnv({ ...BASE, WALLET_IDENTITY_CREDENTIAL: CREDENTIAL }).identityCredential, CREDENTIAL)
  // Absent must LOAD — the image has to boot without one so the CI smoke test can read /livez —
  // and is caught by the hard `identity-credential` readiness probe instead.
  assert.equal(loadEnv(BASE).identityCredential, null)
})

test('a credential that is present but too short is refused, not accepted as configured', () => {
  // Absent is a deployment nobody has given a credential to. A short one is a deployment that
  // BELIEVES it has one, and would fail on its first call to a peer with a 401 that reads as
  // "identity rejected wallet" rather than "nobody set this variable".
  assert.throws(
    () => loadEnv({ ...BASE, WALLET_IDENTITY_CREDENTIAL: 'cfsc_short' }),
    (err: unknown) => err instanceof EnvError && err.message.includes('WALLET_IDENTITY_CREDENTIAL'),
  )
})

test('identityUrl derives from the issuer, and IDENTITY_URL overrides it', () => {
  // The issuer of a token is by definition where the token came from, so demanding a fourth
  // identity variable would only create a way for the exchange and the JWKS to disagree.
  assert.equal(loadEnv(BASE).identityUrl, BASE['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, IDENTITY_URL: 'http://identity.internal:4000' }).identityUrl,
    'http://identity.internal:4000',
  )
})

test('WALLET_SERVICE_TOKEN is no longer required, and being set is reported rather than obeyed', () => {
  // The retired variable. It was a 600-second token read once at boot; ten minutes into every
  // deployment every call to a peer failed and nothing could re-mint it.
  assert.equal(loadEnv(BASE).legacyServiceTokenPresent, false)
  const withLegacy = loadEnv({ ...BASE, WALLET_SERVICE_TOKEN: 'a-service-token-long-enough-to-pass' })
  assert.equal(withLegacy.legacyServiceTokenPresent, true)
  // And it confers nothing: setting it must not make the service look configured.
  assert.equal(withLegacy.identityCredential, null)
})

test('a known placeholder secret is refused outright', () => {
  // A default secret in source is not convenient, it is catastrophic: everything derived from it
  // is forgeable by anyone who can read the repository.
  for (const secret of ['changeme', 'dev-secret', 'replace-with-a-real-secret']) {
    assert.throws(
      () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: secret }),
      (err: unknown) => err instanceof EnvError && /placeholder/.test((err as Error).message),
    )
  }
})

test('a short secret is refused, so a memorable password fails too', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'hunter2' }),
    (err: unknown) => err instanceof EnvError && /at least 24/.test((err as Error).message),
  )
})

test('the network is a closed set, never coerced', () => {
  assert.equal(loadEnv({ ...BASE, WALLET_NETWORK: 'mainnet' }).network, 'mainnet')
  assert.throws(() => loadEnv({ ...BASE, WALLET_NETWORK: 'main' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, WALLET_NETWORK: 'MAINNET' }), EnvError)
})

test('numeric bounds are enforced rather than clamped', () => {
  assert.throws(() => loadEnv({ ...BASE, PORT: '0' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, PORT: '70000' }), EnvError)
  assert.throws(() => loadEnv({ ...BASE, WALLET_DATABASE_POOL_MAX: '1000' }), EnvError)
  // A challenge TTL of a day would make a stolen unsigned challenge worth stealing.
  assert.throws(() => loadEnv({ ...BASE, WALLET_CHALLENGE_TTL_SECONDS: '86400' }), EnvError)
})

test('fee quotes are parsed as bigint, never as float', () => {
  // An EVM fee routinely exceeds Number.MAX_SAFE_INTEGER, and a float here would round the number
  // a withdrawal is priced at.
  const parsed = parseFeeQuotes('{"EMBER":"21000000000000000","ETH":"1"}')
  assert.equal(parsed['EMBER'], 21_000_000_000_000_000n)
  assert.equal(typeof parsed['EMBER'], 'bigint')
  assert.equal(parsed['BTC'], undefined, 'an absent asset must be absent, not zero')
})

test('a malformed fee table is refused at boot rather than at the first withdrawal', () => {
  assert.throws(() => parseFeeQuotes('not json'), EnvError)
  assert.throws(() => parseFeeQuotes('[]'), EnvError)
  assert.throws(() => parseFeeQuotes('{"EMBER":"1.5"}'), EnvError)
  assert.throws(() => parseFeeQuotes('{"EMBER":"-1"}'), EnvError)
})

test('withdrawals can be paused by configuration', () => {
  assert.equal(loadEnv({ ...BASE, WALLET_WITHDRAWALS_ENABLED: 'false' }).withdrawalsEnabled, false)
  assert.equal(loadEnv({ ...BASE, WALLET_WITHDRAWALS_ENABLED: '0' }).withdrawalsEnabled, false)
  assert.throws(() => loadEnv({ ...BASE, WALLET_WITHDRAWALS_ENABLED: 'maybe' }), EnvError)
})
