import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import {
  LinkError,
  authorisationHolds,
  createChallenge,
  grantAuthorisation,
  readLink,
  revokeAuthorisation,
  verifyChallenge,
} from './links.ts'
import { parseSiweMessage } from './siwe.ts'
import {
  enabled,
  evmSigner,
  harness,
  migrateTestDb,
  openDb,
  resetWallet,
  skip,
  testUser,
  type Harness,
} from './testsupport.ts'

let sql: postgres.Sql
let h: Harness

const USER = testUser(1)
const OTHER = testUser(2)
const DOMAIN = 'hub.cloudsforge.online'
const URI = 'https://hub.cloudsforge.online/wallets/verify'

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

const challenge = (address: string, origin: 'external' | 'watch' = 'external', userId = USER) =>
  createChallenge(sql as never, 'wallet', {
    userId,
    chain: 'ember',
    network: 'testnet',
    address,
    origin,
    domain: DOMAIN,
    uri: URI,
    ttlSeconds: 600,
    correlationId: 'req-1',
  })

const verify = (nonce: string, signature: string, extra: Record<string, unknown> = {}) =>
  verifyChallenge(sql as never, 'wallet', {
    userId: USER,
    nonce,
    signature,
    expectedDomain: DOMAIN,
    expectedUri: URI,
    correlationId: 'req-2',
    ...extra,
  })

/* ------------------------------------------------------------------ the happy path */

test('a challenge is issued, signed and verified, and the wallet becomes active', { skip }, async () => {
  const signer = evmSigner()
  const { wallet, challenge: issued } = await challenge(signer.address)
  assert.equal(wallet.status, 'provisioning')
  assert.notEqual(issued, null)
  assert.equal(issued!.scheme, 'eip4361')

  // The message is what the user is asked to sign, and it is stored verbatim rather than rebuilt
  // at verification — the issuer and the verifier must not each have their own opinion of it.
  const fields = parseSiweMessage(issued!.message)
  assert.equal(fields.domain, DOMAIN)
  assert.equal(fields.address, signer.address)
  assert.equal(fields.chainId, 7412, 'Ember testnet, from contracts-chain')

  const link = await verify(issued!.nonce, signer.sign(issued!.message), {
    authorisations: ['withdrawal_destination'],
  })
  assert.notEqual(link.verifiedAt, null)
  assert.deepEqual(link.authorisations, ['withdrawal_destination'])

  const rows = await sql<{ status: string; verified_at: Date | null }[]>`
    select status, verified_at from wallets where id = ${wallet.id}
  `
  assert.equal(rows[0]?.status, 'active')
  assert.notEqual(rows[0]?.verified_at, null)

  const events = await sql`select 1 from outbox where topic = 'wallet.link.verified'`
  assert.equal(events.length, 1)
})

/* ------------------------------------------------------------------ replay */

test('THE RULE: a replayed nonce is refused, and the replay cannot be raced', { skip }, async () => {
  const signer = evmSigner()
  const { challenge: issued } = await challenge(signer.address)
  const signature = signer.sign(issued!.message)

  await verify(issued!.nonce, signature)
  await assert.rejects(
    () => verify(issued!.nonce, signature),
    (err: unknown) => err instanceof LinkError && err.code === 'challenge_unusable',
  )

  // Two concurrent replays: the claim is an UPDATE that requires `consumed_at is null`, so
  // exactly one can return a row. A SELECT-then-mark would let both through.
  const second = await challenge(signer.address)
  const sig2 = signer.sign(second.challenge!.message)
  const results = await Promise.allSettled([
    verify(second.challenge!.nonce, sig2),
    verify(second.challenge!.nonce, sig2),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
})

test('a failed attempt consumes the nonce, so it is not a grinding oracle', { skip }, async () => {
  const signer = evmSigner()
  const impostor = evmSigner()
  const { challenge: issued } = await challenge(signer.address)

  await assert.rejects(
    () => verify(issued!.nonce, impostor.sign(issued!.message)),
    (err: unknown) => err instanceof LinkError && err.code === 'bad_signature',
  )
  // A challenge that survived a failed attempt would let an attacker grind candidate signatures
  // against it. One challenge, one attempt; a fresh one is a cheap call away.
  await assert.rejects(
    () => verify(issued!.nonce, signer.sign(issued!.message)),
    (err: unknown) => err instanceof LinkError && err.code === 'challenge_unusable',
  )
})

test('another user cannot consume a challenge issued to somebody else', { skip }, async () => {
  const signer = evmSigner()
  const { challenge: issued } = await challenge(signer.address)
  await assert.rejects(
    () =>
      verifyChallenge(sql as never, 'wallet', {
        userId: OTHER,
        nonce: issued!.nonce,
        signature: signer.sign(issued!.message),
        expectedDomain: DOMAIN,
        expectedUri: URI,
        correlationId: 'req-2',
      }),
    // The message is identical to "never issued": telling them apart for the caller would confirm
    // which nonces exist.
    (err: unknown) => err instanceof LinkError && err.code === 'challenge_unusable',
  )
})

test('a wrong-domain expectation refuses a signature over our own message', { skip }, async () => {
  const signer = evmSigner()
  const { challenge: issued } = await challenge(signer.address)
  await assert.rejects(
    () =>
      verifyChallenge(sql as never, 'wallet', {
        userId: USER,
        nonce: issued!.nonce,
        signature: signer.sign(issued!.message),
        expectedDomain: 'somewhere.else',
        expectedUri: URI,
        correlationId: 'req-2',
      }),
    (err: unknown) => err instanceof LinkError && err.code === 'wrong_domain',
  )
})

test('an expired challenge is refused', { skip }, async () => {
  const signer = evmSigner()
  const { challenge: issued } = await createChallenge(sql as never, 'wallet', {
    userId: USER,
    chain: 'ember',
    network: 'testnet',
    address: signer.address,
    origin: 'external',
    domain: DOMAIN,
    uri: URI,
    ttlSeconds: 30,
    correlationId: 'req-1',
    now: new Date(Date.now() - 600_000),
  })
  await assert.rejects(
    () => verify(issued!.nonce, signer.sign(issued!.message)),
    (err: unknown) => err instanceof LinkError && err.code === 'challenge_expired',
  )
})

/* ------------------------------------------------------------------ watch wallets */

test('THE RULE: a watch address gets no challenge and no link at all', { skip }, async () => {
  const signer = evmSigner()
  const { wallet, challenge: issued } = await challenge(signer.address, 'watch')
  assert.equal(issued, null)
  assert.equal(wallet.origin, 'watch')
  // Active, because a watch wallet has no provisioning to wait for — "active" for it means only
  // that it is being displayed.
  assert.equal(wallet.status, 'active')
  assert.equal(await readLink(sql as never, wallet.id), null)
  // The single question every authority check asks, and it is false by construction rather than
  // by a rule someone has to remember.
  assert.equal(await authorisationHolds(sql as never, wallet.id, 'withdrawal_destination'), false)
})

test('an authorisation cannot be granted on an unverified link', { skip }, async () => {
  const signer = evmSigner()
  const { wallet } = await challenge(signer.address)
  await assert.rejects(
    () => grantAuthorisation(sql as never, wallet.id, 'withdrawal_destination', `user:${USER}`),
    (err: unknown) => err instanceof LinkError && err.code === 'link_not_verified',
  )
  assert.equal(await authorisationHolds(sql as never, wallet.id, 'withdrawal_destination'), false)
})

test('an authorisation cannot be granted on a wallet with no link', { skip }, async () => {
  const signer = evmSigner()
  const { wallet } = await challenge(signer.address, 'watch')
  await assert.rejects(
    () => grantAuthorisation(sql as never, wallet.id, 'withdrawal_destination', `user:${USER}`),
    (err: unknown) => err instanceof LinkError && err.code === 'link_not_found',
  )
})

/* ------------------------------------------------------------------ authorisations */

test('each authorisation is granted and revoked individually', { skip }, async () => {
  const signer = evmSigner()
  const { wallet, challenge: issued } = await challenge(signer.address)
  await verify(issued!.nonce, signer.sign(issued!.message), {
    authorisations: ['withdrawal_destination', 'token_owner', 'governance_vote'],
  })

  assert.equal(await authorisationHolds(sql as never, wallet.id, 'token_owner'), true)
  await revokeAuthorisation(sql as never, 'wallet', {
    walletId: wallet.id,
    userId: USER,
    authorisation: 'token_owner',
    by: `user:${USER}`,
    correlationId: 'req-3',
  })
  // Only the one named goes.
  assert.equal(await authorisationHolds(sql as never, wallet.id, 'token_owner'), false)
  assert.equal(await authorisationHolds(sql as never, wallet.id, 'withdrawal_destination'), true)
  assert.equal(await authorisationHolds(sql as never, wallet.id, 'governance_vote'), true)

  const link = await readLink(sql as never, wallet.id)
  assert.deepEqual(link?.authorisations, ['governance_vote', 'withdrawal_destination'])
  // The revocation is stamped, not deleted: "was this permitted last Tuesday" is a question an
  // auditor will ask, and an array of live values cannot answer it.
  const rows = await sql<{ authorisation: string; revoked_at: Date | null }[]>`
    select authorisation, revoked_at from external_wallet_authorisations
     where wallet_id = ${wallet.id} order by authorisation
  `
  assert.equal(rows.length, 3)
  assert.notEqual(rows.find((r) => r.authorisation === 'token_owner')?.revoked_at, null)
})

test('disconnecting a wallet revokes every authorisation and the link', { skip }, async () => {
  const signer = evmSigner()
  const { wallet, challenge: issued } = await challenge(signer.address)
  await verify(issued!.nonce, signer.sign(issued!.message), {
    authorisations: ['withdrawal_destination', 'market_settlement'],
  })

  const link = await revokeAuthorisation(sql as never, 'wallet', {
    walletId: wallet.id,
    userId: USER,
    authorisation: null,
    by: `user:${USER}`,
    correlationId: 'req-3',
  })
  assert.deepEqual(link.authorisations, [])
  assert.notEqual(link.revokedAt, null)
  assert.equal(await authorisationHolds(sql as never, wallet.id, 'withdrawal_destination'), false)
})

test('a revoked link cannot be used even if an authorisation row survived', { skip }, async () => {
  // Belt and braces: `authorisationHolds` checks the link's revocation as well as the grant's, so
  // revoking the link alone is sufficient.
  const signer = evmSigner()
  const { wallet, challenge: issued } = await challenge(signer.address)
  await verify(issued!.nonce, signer.sign(issued!.message), {
    authorisations: ['withdrawal_destination'],
  })
  await sql`update external_wallet_links set revoked_at = now() where wallet_id = ${wallet.id}`
  assert.equal(await authorisationHolds(sql as never, wallet.id, 'withdrawal_destination'), false)
})

test('re-linking a revoked wallet clears the revocation', { skip }, async () => {
  const signer = evmSigner()
  const first = await challenge(signer.address)
  await verify(first.challenge!.nonce, signer.sign(first.challenge!.message))
  await revokeAuthorisation(sql as never, 'wallet', {
    walletId: first.wallet.id,
    userId: USER,
    authorisation: null,
    by: `user:${USER}`,
    correlationId: 'req-3',
  })

  const second = await challenge(signer.address)
  assert.equal(second.wallet.id, first.wallet.id, 'one address, one wallet row')
  const link = await verify(second.challenge!.nonce, signer.sign(second.challenge!.message), {
    authorisations: ['withdrawal_destination'],
  })
  assert.equal(link.revokedAt, null)
  assert.equal(await authorisationHolds(sql as never, first.wallet.id, 'withdrawal_destination'), true)
})

/* ------------------------------------------------------------------ unimplemented schemes */

test('THE RULE: an unimplemented scheme is 501, and issues a message rather than nothing', { skip }, async () => {
  // Solana, Bitcoin and XRP have their shapes defined — the scheme names, the challenge row, the
  // message — and refuse to verify. Faking one would mint a link claiming a proof it does not have,
  // and every authorisation granted on it would inherit the lie.
  const { wallet, challenge: issued } = await createChallenge(sql as never, 'wallet', {
    userId: USER,
    chain: 'sol',
    network: 'testnet',
    address: 'So11111111111111111111111111111111111111112',
    origin: 'external',
    domain: DOMAIN,
    uri: URI,
    ttlSeconds: 600,
    correlationId: 'req-1',
  })
  assert.equal(issued?.scheme, 'solana_signmessage')
  // The message is real, so an integrator can see exactly what this service will expect once the
  // verifier lands — and it will not change when it does.
  assert.match(issued!.message, /Nonce: /)
  assert.match(issued!.message, /Address: So1111/)

  await assert.rejects(
    () => verify(issued!.nonce, 'anything'),
    (err: unknown) => err instanceof LinkError && err.status === 501,
  )
  const rows = await sql<{ status: string }[]>`select status from wallets where id = ${wallet.id}`
  assert.equal(rows[0]?.status, 'provisioning', 'no link, so the wallet never activates')
})

test('the same address twice is one wallet row, not two lifecycles', { skip }, async () => {
  const signer = evmSigner()
  const first = await challenge(signer.address)
  const second = await challenge(signer.address.toLowerCase())
  assert.equal(second.wallet.id, first.wallet.id)
  assert.equal((await sql`select 1 from wallets`).length, 1)
  // Two challenges though: the second is a fresh attempt, and the first must not be reusable.
  assert.equal((await sql`select 1 from link_challenges`).length, 2)
})
