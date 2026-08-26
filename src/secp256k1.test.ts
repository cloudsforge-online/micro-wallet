import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { keccak256 } from '@cloudsforge/evm'
import {
  SignatureError,
  addressFromPublicKey,
  parseSignature,
  recoverAddress,
  recoverPublicKey,
} from './secp256k1.ts'

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/**
 * Sign with **Node's own OpenSSL-backed ECDSA** on secp256k1.
 *
 * This is what makes the file's tests a cross-implementation check rather than a self-consistency
 * one: nothing in `secp256k1.ts` participates in producing these vectors. `ieee-p1363` gives raw
 * `r || s` rather than DER, and the recovery byte — which ECDSA does not produce — is found by
 * trying both and keeping the one that recovers the key we actually signed with. That brute force
 * is exactly what a wallet does when it produces a `v`, so it is not a shortcut.
 */
function signWithNode(
  privateKey: KeyObject,
  publicKey: KeyObject,
  message: Buffer,
): { digest: Uint8Array; signature: string; address: string } {
  const digest = new Uint8Array(createHash('sha256').update(message).digest())
  const raw = sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' })
  let r = BigInt(`0x${raw.subarray(0, 32).toString('hex')}`)
  let s = BigInt(`0x${raw.subarray(32, 64).toString('hex')}`)
  // OpenSSL emits either half of the malleable pair. EIP-2 accepts only the low one, so the high
  // one is folded rather than rejected — the signature is the same authorisation either way.
  if (s > N >> 1n) s = N - s

  const address = addressOf(publicKey)
  for (const recovery of [0, 1]) {
    const candidate = `0x${r.toString(16).padStart(64, '0')}${s.toString(16).padStart(64, '0')}${(27 + recovery).toString(16)}`
    try {
      if (recoverAddress(digest, candidate) === address) {
        return { digest, signature: candidate, address }
      }
    } catch {
      // A recovery bit that does not produce a point is simply the wrong bit.
    }
  }
  throw new Error('neither recovery bit reproduced the signing key')
}

/** The address of a key, derived from Node's JWK rather than from anything in this repository. */
function addressOf(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const x = Buffer.from(jwk.x, 'base64url')
  const y = Buffer.from(jwk.y, 'base64url')
  const uncompressed = Buffer.concat([
    Buffer.alloc(32 - x.length),
    x,
    Buffer.alloc(32 - y.length),
    y,
  ])
  return `0x${Buffer.from(keccak256(uncompressed).slice(12)).toString('hex')}`
}

const keys = () => generateKeyPairSync('ec', { namedCurve: 'secp256k1' })

test('THE RULE: recovery lands on the address that signed, across many keys', () => {
  // Twenty independent keys rather than one. A recovery implementation can be wrong in ways that
  // happen to work for a particular key — a sign convention on the y parity, an off-by-one in the
  // recovery bit — and only show up on the half of keys that fall the other way.
  for (let i = 0; i < 20; i++) {
    const { privateKey, publicKey } = keys()
    const message = Buffer.from(`cloudsforge message ${i}`, 'utf8')
    const { digest, signature, address } = signWithNode(privateKey, publicKey, message)
    assert.equal(recoverAddress(digest, signature), address)
    assert.equal(addressFromPublicKey(recoverPublicKey(digest, parseSignature(signature))), address)
  }
})

test('a signature over a different message recovers a different address', () => {
  const { privateKey, publicKey } = keys()
  const { signature, address } = signWithNode(privateKey, publicKey, Buffer.from('one'))
  const otherDigest = new Uint8Array(createHash('sha256').update('two').digest())
  // Not an error — ECDSA recovery always produces *an* address. That is exactly why the caller
  // must compare it against the address being claimed, and why "it recovered" is never the check.
  assert.notEqual(recoverAddress(otherDigest, signature), address)
})

test('the wrong recovery bit recovers the wrong address, not an error', () => {
  const { privateKey, publicKey } = keys()
  const { digest, signature, address } = signWithNode(privateKey, publicKey, Buffer.from('x'))
  const v = Number.parseInt(signature.slice(-2), 16)
  const flipped = `${signature.slice(0, -2)}${(v === 27 ? 28 : 27).toString(16)}`
  let recovered: string | null = null
  try {
    recovered = recoverAddress(digest, flipped)
  } catch {
    // Some flipped bits give an x with no square root, which is a legitimate refusal.
  }
  assert.notEqual(recovered, address)
})

test('EIP-2: a high-s signature is refused rather than accepted as a second encoding', () => {
  const { privateKey, publicKey } = keys()
  const { signature } = signWithNode(privateKey, publicKey, Buffer.from('x'))
  const r = signature.slice(2, 66)
  const s = BigInt(`0x${signature.slice(66, 130)}`)
  const high = (N - s).toString(16).padStart(64, '0')
  // Both s and n-s authorise the same message with the same key. Accepting both means one
  // authorisation has two byte encodings, and anything deduping on the bytes can be made to
  // accept it twice.
  assert.throws(
    () => parseSignature(`0x${r}${high}1b`),
    (err: unknown) => err instanceof SignatureError && /upper half/.test((err as Error).message),
  )
})

test('malformed signatures are refused with a reason, never a wrong address', () => {
  const zero = '0'.repeat(64)
  const one = `${'0'.repeat(63)}1`
  assert.throws(() => parseSignature('0xdeadbeef'), SignatureError)
  assert.throws(() => parseSignature(`0x${one}${one}00ff`), SignatureError)
  // v values from EIP-155 transaction signing encode a chain id and do not belong on a
  // personal-sign signature. Masking them down to a recovery bit would accept a signature
  // produced for something else entirely.
  assert.throws(() => parseSignature(`0x${one}${one}25`), SignatureError)
  assert.throws(() => parseSignature(`0x${zero}${one}1b`), SignatureError, 'r must not be zero')
  assert.throws(() => parseSignature(`0x${one}${zero}1b`), SignatureError, 's must not be zero')
})

test('an r that is not a curve x-coordinate is refused rather than recovered', () => {
  // x = 5 has no y on secp256k1: 125 + 7 = 132 is not a quadratic residue mod p. A recovery that
  // did not square the candidate root back would carry on doing arithmetic on a point that is not
  // on the curve, and produce a stable, plausible, meaningless address.
  const five = `${'0'.repeat(63)}5`
  const one = `${'0'.repeat(63)}1`
  const digest = new Uint8Array(32).fill(7)
  assert.throws(
    () => recoverPublicKey(digest, parseSignature(`0x${five}${one}1b`)),
    (err: unknown) => err instanceof SignatureError && /curve/.test((err as Error).message),
  )
})
