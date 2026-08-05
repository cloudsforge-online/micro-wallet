import { randomBytes } from 'node:crypto'
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
  // GENERATED, not written. The literal that used to sit here was
  // `K2sN4vQ8xR1wB6tY9zL3mF7hC5jD0pA4` — 32 characters, and therefore past the old 24-character
  // floor, but only 24 BYTES of key material once base64-decoded. It is one of the values pinned
  // in `@cloudsforge/secrets`' own test as a real defect this estate shipped. Every test in this
  // file was built on it, so the whole suite was asserting that a sub-floor key is acceptable.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
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
/**
 * THIS FIXTURE CONTAINS HYPHENS ON PURPOSE, AND THAT IS THE MOST IMPORTANT THING ABOUT IT.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured on the running
 * estates: the mainnet credential is alphanumeric and the testnet one CONTAINS A HYPHEN. So a
 * "secrets have no hyphens" rule — which is correct for the signing key, and which every
 * placeholder this estate wrote would have failed — passes mainnet and kills testnet at boot.
 *
 * Keeping a hyphenated credential here means that mistake fails CI instead of failing one estate
 * in production. Do not "tidy" the hyphens out of this value.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

/**
 * "The new one" and "the one being rotated out" for the acceptance-list cases below.
 *
 * These were `fake-new-outbox-secret-0000000000` and `fake-old-outbox-secret-1111111111`, whose
 * own comment said they were "long enough to pass the 24-character rule". That is the defect
 * stated out loud: both are hyphenated, zero-padded placeholders of exactly the family that
 * reached 44 containers as micro-org #142, and this suite asserted they were VALID secrets.
 *
 * Generated rather than replaced with better-looking literals, so a placeholder cannot creep back
 * in the next time somebody needs a fixture.
 */
const NEW_SECRET = randomBytes(48).toString('base64')
const OLD_SECRET = randomBytes(48).toString('base64')

const { EnvError, SERVICE, env: eager, loadEnv, parseFeeQuotes, parseSecretList } =
  await import('./env.ts')

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

test('a short secret is refused, and the unit is BYTES rather than keystrokes', () => {
  // This assertion used to demand the message say "at least 24" — the keystroke floor that let
  // micro-org #142's 40-character placeholder through every service in the estate. Pinning that
  // wording made the test a defence of the defective rule: any fix that stopped counting
  // characters would fail CI, however much better the new rule was.
  //
  // What it asserts now is the PROPERTY that matters. `hunter2` happens to be spelled in the
  // base64 alphabet, so it is not the alphabet that catches it — it decodes to 5 bytes.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'hunter2' }),
    (err: unknown) =>
      err instanceof EnvError &&
      /5 bytes of key material/.test(err.message) &&
      /at least 32/.test(err.message) &&
      !err.message.includes('hunter2'),
  )
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * OUTBOX_ACCEPT_SECRETS — the overlap window that makes rotating the shared HMAC key survivable.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('OUTBOX_ACCEPT_SECRETS is absent by default, and then the accepted list is the signing secret', () => {
  // The whole point of the default. Deploying this change must be a no-op on every environment
  // that has not been given the new variable, because a rotation is staged one service at a time
  // and the first stage has to be "nothing observable happened".
  assert.deepEqual(loadEnv(BASE).outboxAcceptSecrets, [BASE['OUTBOX_SIGNING_SECRET']])
})

test('OUTBOX_ACCEPT_SECRETS is a list, newest first, and signing still uses the single secret', () => {
  const env = loadEnv({
    ...BASE,
    OUTBOX_SIGNING_SECRET: NEW_SECRET,
    OUTBOX_ACCEPT_SECRETS: `${NEW_SECRET}, ${OLD_SECRET}`,
  })
  assert.deepEqual(env.outboxAcceptSecrets, [NEW_SECRET, OLD_SECRET])
  // Verification widens; signing does not. A service that signed with the whole list would have no
  // defined answer to "which key did this go out under".
  assert.equal(env.outboxSigningSecret, NEW_SECRET)
})

test('every entry in OUTBOX_ACCEPT_SECRETS is validated exactly like the signing secret', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEW_SECRET},changeme` }),
    (err: unknown) => err instanceof EnvError && /placeholder/.test((err as Error).message),
  )
  // Same fix as above, and the index matters: the message must name WHICH entry failed, because an
  // operator with the file open counts commas — and must not carry the entry itself.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEW_SECRET},hunter2` }),
    (err: unknown) =>
      err instanceof EnvError &&
      /OUTBOX_ACCEPT_SECRETS\[1\]/.test(err.message) &&
      /at least 32/.test(err.message),
  )
  // A duplicate makes "which key verified this" ambiguous, and that answer is how an operator
  // knows a rotation has finished.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEW_SECRET},${NEW_SECRET}` }),
    (err: unknown) => err instanceof EnvError && /same secret twice/.test((err as Error).message),
  )
  // An empty or all-blank list is a deployment that accepts nothing, which is a silent partition.
  assert.throws(() => parseSecretList(' , , ', 'X'), EnvError)
  assert.throws(() => parseSecretList('', 'X'), EnvError)
  // A single entry is a list of one, not a special case.
  assert.deepEqual(parseSecretList(` ${OLD_SECRET} `, 'X'), [OLD_SECRET])
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

/*
 * ── #213: a fee quote must carry its asset's scale ────────────────────────────────────────────
 *
 * The four tests below are the guard described in #213, and each one is a failure that reached
 * the live money path before it: the parser checked that a value was a non-negative integer and
 * never checked WHICH ASSET it was an integer of.
 */

test('a fee quoted at another asset’s scale is refused — Litecoin is 8 decimals, not 18', () => {
  // THE EXACT EDIT THIS GUARD EXISTS FOR. The live table is `{"EMBER":"21000000000000"}`, and the
  // obvious way to add Litecoin is to copy that line. At EMBER's 18 decimals it is 0.000021 EMBER;
  // at Litecoin's 8 it is 210,000 LTC, a factor of 10^10 out. Both are "a non-negative integer",
  // which is every question the parser used to ask.
  assert.throws(
    () => parseFeeQuotes('{"EMBER":"21000000000000","LTC":"21000000000000"}'),
    EnvError,
    'an EMBER-shaped literal keyed to LTC must not parse',
  )

  // The same number, correctly scaled, is fine — the bound is asset-relative and not a blanket cap.
  const parsed = parseFeeQuotes('{"EMBER":"21000000000000","LTC":"10000"}')
  // ASSERTED AS AN EXACT INTEGER IN SMALLEST UNITS, which is the only form that can catch an
  // exponent error: 10000 litoshis is 0.0001 LTC. A test that asserted "about right" or compared
  // a formatted string would pass on all ten wrong answers.
  assert.equal(parsed['LTC'], 10_000n)
  assert.equal(typeof parsed['LTC'], 'bigint')
  assert.equal(parsed['EMBER'], 21_000_000_000_000n)
})

test('an empty string is not a fee of zero — BigInt(‘’) is 0n', () => {
  // `''` is a string, so the typeof check passed; `BigInt('')` does not throw, so the try passed;
  // `0n < 0n` is false, so the negative check passed. A free withdrawal, paid by the treasury,
  // with no error anywhere. Measured: node prints `0n`.
  assert.equal(BigInt(''), 0n, 'the language behaviour this test exists to defend against')
  assert.throws(() => parseFeeQuotes('{"LTC":""}'), EnvError)
  assert.throws(() => parseFeeQuotes('{"LTC":"   "}'), EnvError)

  // An explicit zero is refused too. Waiving the network fee is a decision somebody makes on
  // purpose; it must never be what a malformed value degrades into.
  assert.throws(() => parseFeeQuotes('{"LTC":"0"}'), EnvError)
})

test('an unknown asset code is refused, rather than quoting a coin that does not exist', () => {
  // Fail-closed on absence means a typo does not lose money — it presents as "Litecoin withdrawals
  // are refused" beside a table that visibly contains a Litecoin line. Cheap to prevent, expensive
  // to debug.
  assert.throws(() => parseFeeQuotes('{"LTCC":"10000"}'), EnvError)
  assert.throws(() => parseFeeQuotes('{"ltc":"10000"}'), EnvError, 'the union is upper case')
})

test('a retired asset may not be quoted a network fee', () => {
  // SHARD has `decimals: 0` and never settled on a chain. It is nameable and un-withdrawable, and
  // those are separate questions — the same split `foresight/src/stakeassets.ts` draws between
  // `CHAIN_DECIMALS` membership and `isRetiredAsset`.
  assert.throws(() => parseFeeQuotes('{"SHARD":"1"}'), EnvError)
})

test('withdrawals can be paused by configuration', () => {
  assert.equal(loadEnv({ ...BASE, WALLET_WITHDRAWALS_ENABLED: 'false' }).withdrawalsEnabled, false)
  assert.equal(loadEnv({ ...BASE, WALLET_WITHDRAWALS_ENABLED: '0' }).withdrawalsEnabled, false)
  assert.throws(() => loadEnv({ ...BASE, WALLET_WITHDRAWALS_ENABLED: 'maybe' }), EnvError)
})
