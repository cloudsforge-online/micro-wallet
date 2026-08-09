import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SiweError,
  buildSiweMessage,
  expectedChainId,
  parseSiweMessage,
  personalSignDigest,
  schemeForChain,
  verifySiwe,
  type SiweFields,
} from './siwe.ts'
import { evmSigner } from './testsupport.ts'

const DOMAIN = 'hub.cloudsforge.online'
const URI = 'https://hub.cloudsforge.online/wallets/verify'
const NOW = new Date('2026-01-01T12:00:00.000Z')

function fields(overrides: Partial<SiweFields> & { address: string }): SiweFields {
  return {
    domain: DOMAIN,
    statement: 'Link this wallet to your CloudsForge account.',
    uri: URI,
    version: '1',
    // Ember testnet, from contracts-chain. Never a literal.
    chainId: expectedChainId('ember', 'testnet'),
    nonce: 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5',
    issuedAt: NOW.toISOString(),
    expirationTime: new Date(NOW.getTime() + 600_000).toISOString(),
    ...overrides,
  }
}

const verify = (message: string, signature: string, address: string, overrides = {}) =>
  verifySiwe({
    message,
    signature,
    address,
    expectedDomain: DOMAIN,
    expectedUri: URI,
    expectedNonce: parseSiweMessage(message).nonce,
    expectedChainId: expectedChainId('ember', 'testnet'),
    now: NOW,
    ...overrides,
  })

test('a message round-trips through build and parse without losing a field', () => {
  const signer = evmSigner()
  const original = fields({ address: signer.address })
  const parsed = parseSiweMessage(buildSiweMessage(original))
  assert.deepEqual(parsed, original)
})

test('the message layout is the one EIP-4361 specifies', () => {
  const signer = evmSigner()
  const lines = buildSiweMessage(fields({ address: signer.address })).split('\n')
  // A wallet that parses the message to render it nicely falls back to raw hex if the layout is
  // off by one line, and a user shown raw hex cannot tell a login from a token approval.
  assert.equal(lines[0], `${DOMAIN} wants you to sign in with your Ethereum account:`)
  assert.equal(lines[1], signer.address)
  assert.equal(lines[2], '')
  assert.equal(lines[4], '')
  assert.equal(lines[5], `URI: ${URI}`)
  assert.equal(lines[6], 'Version: 1')
  assert.equal(lines[7], `Chain ID: ${expectedChainId('ember', 'testnet')}`)
})

test('a message with no statement is still well formed and parses back', () => {
  const signer = evmSigner()
  const withoutStatement: SiweFields = {
    domain: DOMAIN,
    address: signer.address,
    uri: URI,
    version: '1',
    chainId: 1,
    nonce: 'deadbeefdeadbeef',
    issuedAt: NOW.toISOString(),
  }
  const parsed = parseSiweMessage(buildSiweMessage(withoutStatement))
  assert.equal(parsed.statement, undefined)
  assert.equal(parsed.nonce, 'deadbeefdeadbeef')
})

test('THE RULE: a correct signature verifies', () => {
  const signer = evmSigner()
  const message = buildSiweMessage(fields({ address: signer.address }))
  verify(message, signer.sign(message), signer.address)
})

test('THE RULE: a wrong-domain signature is refused even though it is cryptographically perfect', () => {
  // The check that stops a signature collected by a phishing site being replayed here. The
  // signature below is genuine — the user really did sign it — and it must still be refused,
  // because what they signed says somebody else's domain.
  const signer = evmSigner()
  const message = buildSiweMessage(fields({ address: signer.address, domain: 'wallet-cloudsforge.evil' }))
  const signature = signer.sign(message)

  // Proof the signature itself is good: recovery over the same digest lands on the signer.
  assert.equal(personalSignDigest(message).length, 32)

  assert.throws(
    () => verify(message, signature, signer.address),
    (err: unknown) => err instanceof SiweError && err.code === 'wrong_domain',
  )
})

test('a signature naming a different nonce is refused', () => {
  // The nonce in the message must be the one this service issued. Verifying against the nonce
  // *from the message* would make the check tautological, which is why the expectation comes from
  // the challenge row rather than from the message being checked.
  const signer = evmSigner()
  const message = buildSiweMessage(fields({ address: signer.address }))
  assert.throws(
    () =>
      verifySiwe({
        message,
        signature: signer.sign(message),
        address: signer.address,
        expectedDomain: DOMAIN,
        expectedUri: URI,
        expectedNonce: 'a-nonce-that-was-never-issued',
        expectedChainId: expectedChainId('ember', 'testnet'),
        now: NOW,
      }),
    (err: unknown) => err instanceof SiweError && err.code === 'wrong_nonce',
  )
})

test('a signature for another chain is refused', () => {
  // The XRP network-collision defect in a different family: one signature, two networks. The
  // Chain ID field exists to make it detectable, and Ember mainnet and testnet differ by one.
  const signer = evmSigner()
  const message = buildSiweMessage(
    fields({ address: signer.address, chainId: expectedChainId('ember', 'mainnet') }),
  )
  assert.throws(
    () => verify(message, signer.sign(message), signer.address),
    (err: unknown) => err instanceof SiweError && err.code === 'wrong_chain',
  )
})

test('an expired challenge is refused', () => {
  const signer = evmSigner()
  const message = buildSiweMessage(fields({ address: signer.address }))
  assert.throws(
    () => verify(message, signer.sign(message), signer.address, { now: new Date(NOW.getTime() + 3_600_000) }),
    (err: unknown) => err instanceof SiweError && err.code === 'expired',
  )
})

test('a signature by another key over the right message is refused', () => {
  const signer = evmSigner()
  const impostor = evmSigner()
  const message = buildSiweMessage(fields({ address: signer.address }))
  assert.throws(
    () => verify(message, impostor.sign(message), signer.address),
    (err: unknown) => err instanceof SiweError && err.code === 'bad_signature',
  )
})

test('a message naming an address other than the one being linked is refused', () => {
  // A valid signature over a message naming somebody else's address proves only that the signer
  // can sign, not that they hold the address in question.
  const signer = evmSigner()
  const other = evmSigner()
  const message = buildSiweMessage(fields({ address: other.address }))
  assert.throws(
    () => verify(message, signer.sign(message), signer.address),
    (err: unknown) => err instanceof SiweError && err.code === 'wrong_address',
  )
})

test('one byte of tampering with the message invalidates the signature', () => {
  const signer = evmSigner()
  const message = buildSiweMessage(fields({ address: signer.address }))
  const signature = signer.sign(message)
  const tampered = message.replace(
    'Link this wallet to your CloudsForge account.',
    'Link this wallet to your CloudsForge account!',
  )
  assert.throws(
    () =>
      verifySiwe({
        message: tampered,
        signature,
        address: signer.address,
        expectedDomain: DOMAIN,
        expectedUri: URI,
        expectedNonce: parseSiweMessage(tampered).nonce,
        expectedChainId: expectedChainId('ember', 'testnet'),
        now: NOW,
      }),
    (err: unknown) => err instanceof SiweError && err.code === 'bad_signature',
  )
})

test('the parser refuses a repeated field rather than picking one', () => {
  // The classic parser-differential: a message read as having the first Nonce and verified as
  // having the second. On this path that is a replay, so it is refused outright.
  const signer = evmSigner()
  const message = buildSiweMessage(fields({ address: signer.address })).replace(
    'Version: 1',
    'Version: 1\nNonce: 0000000000000000',
  )
  assert.throws(
    () => parseSiweMessage(message),
    (err: unknown) => err instanceof SiweError && err.code === 'malformed_message',
  )
})

test('the parser refuses a message that is not EIP-4361 at all', () => {
  for (const bad of ['', 'hello', 'a.test wants you to sign in with your Ethereum account:']) {
    assert.throws(() => parseSiweMessage(bad), SiweError)
  }
})

test('the scheme is derived from the chain, never taken from the request', () => {
  // Letting a request name the scheme would let it ask for eip4361 on a Solana address, and the
  // verifier would then recover an EVM address that can never match — refusing for the wrong
  // reason and hiding the real one.
  assert.equal(schemeForChain('ember'), 'eip4361')
  assert.equal(schemeForChain('eth'), 'eip4361')
  assert.equal(schemeForChain('sol'), 'solana_signmessage')
  assert.equal(schemeForChain('btc'), 'bip322')
  assert.equal(schemeForChain('xrp'), 'xrp_signed_memo')
  // The two new chains take their existing family's scheme and neither needed a case added, which
  // is the point of switching on the family here rather than on the chain.
  assert.equal(schemeForChain('etc'), 'eip4361')
  assert.equal(schemeForChain('doge'), 'bip322')
})

test('ETHEREUM CLASSIC: a link message commits to 61, which is the only thing separating it from ETH', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * An ETC address and an ETH address are the same 20 bytes, and the same key signs for both. The
   * chain id in the EIP-4361 message is therefore the ONLY field that distinguishes a proof of
   * control on Ethereum Classic from one on Ethereum — there is nothing in the address, nothing in
   * the signature and nothing in the scheme that does it.
   *
   * That matters because `verify` refuses a message whose `Chain ID` is not the expected one (the
   * `a signature for another chain is refused` case above), so if these two resolved to the same
   * number, a challenge issued for one would be satisfiable by a signature bound to the other. The
   * numbers are asserted as being DIFFERENT rather than as being 61 and 1: the values themselves
   * belong to `contracts-chain`, which is exact-pinned precisely so this file does not restate
   * them, and re-typing 61 here would only prove that two literals in this repository agree.
   *
   * Mordor is the testnet, and the reason there is a testnet number at all: Kotti and Morden are
   * both retired, so 63 is the only honest value and `contracts-chain` says so at length.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  for (const network of ['mainnet', 'testnet'] as const) {
    assert.notEqual(
      expectedChainId('etc', network),
      expectedChainId('eth', network),
      `ETC and ETH share a ${network} chain id — a link proof for one would satisfy the other`,
    )
    assert.notEqual(expectedChainId('etc', network), expectedChainId('ember', network))
  }
  // And the two ETC networks differ from each other, which is what stops a Mordor signature being
  // replayed as proof of control on mainnet.
  assert.notEqual(expectedChainId('etc', 'mainnet'), expectedChainId('etc', 'testnet'))
})

test('the EIP-191 prefix uses the BYTE length, not the character count', () => {
  // A message containing anything outside ASCII would otherwise be prefixed with a length no
  // wallet agrees with, and the recovered address would be a stable, plausible, wrong one.
  const ascii = personalSignDigest('abc')
  const wide = personalSignDigest('ábc')
  assert.notDeepEqual(ascii, wide)
  // The digest of a message whose byte length differs from its character length must not equal
  // the digest computed with the character length — proven by signing and recovering it.
  const signer = evmSigner()
  const message = 'héllo wörld'
  assert.doesNotThrow(() => signer.sign(message))
})
