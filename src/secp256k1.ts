/**
 * secp256k1 public-key recovery.
 *
 * This file answers exactly one question: **given a message digest and a signature, which address
 * produced it?** That is the whole of EIP-4361 verification, and it is the only cryptography this
 * service performs. It does not sign, it holds no key material, and it never will — keys are
 * custody's and 04-domain-model §3.3 says they never leave it.
 *
 * ## Why it is hand-rolled
 *
 * The same argument as `keccak.ts`, plus one more. Node's crypto *can* verify a secp256k1 ECDSA
 * signature, but it cannot **recover** the public key from one, and recovery is the operation
 * EIP-4361 needs: the user presents a 65-byte `(r, s, v)` blob and an address, and the question
 * is whether that blob could only have come from that address. Verification would require the
 * public key as an input, which is precisely the thing we are trying to establish.
 *
 * There are no secrets in this file, so none of the usual constant-time discipline applies: every
 * input is public, the signature is public, and the answer is published in the response. Affine
 * arithmetic with a modular inverse per step is therefore the right trade — it is the form that
 * can be read against the group law and checked by eye, which for money-path code is worth more
 * than the milliseconds Jacobian coordinates would save on one call per link verification.
 *
 * ## How it is tested
 *
 * `secp256k1.test.ts` generates keys and signatures with **Node's own OpenSSL-backed ECDSA** on
 * the same curve, then asserts that recovery lands on the address derived independently from
 * Node's public key. That is a cross-implementation check, not a self-consistency one: nothing in
 * this file participates in producing the vectors it is checked against.
 */

import { keccak256 } from '@cloudsforge/evm'

/** The prime field. p = 2^256 − 2^32 − 977. */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn

/** The group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** Curve `b` in y² = x³ + ax + b. `a` is zero on this curve, which simplifies the group law. */
const B = 7n

const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n

/**
 * Half the order, rounded down.
 *
 * EIP-2 refuses a signature whose `s` is above this. Both `s` and `n − s` are valid signatures
 * over the same message with the same key, so accepting the high half means one authorisation has
 * two distinct encodings — and any system that dedupes on the signature bytes can be made to
 * accept the same authorisation twice. Refusing it is one comparison and removes the whole class.
 */
const HALF_N = N >> 1n

export class SignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignatureError'
  }
}

/** A point on the curve, or the identity. `null` is the point at infinity. */
type Point = { readonly x: bigint; readonly y: bigint } | null

function mod(a: bigint, m: bigint): bigint {
  const r = a % m
  return r < 0n ? r + m : r
}

/**
 * Modular inverse by the extended Euclidean algorithm.
 *
 * Not Fermat's little theorem (`a^(p−2)`): that is a 256-step square-and-multiply where this is
 * roughly 190 subtractions, and it would need the modulus to be prime, which is true for `p` and
 * for `n` but would silently stop being true if this were ever reused for a composite.
 */
function invert(a: bigint, m: bigint): bigint {
  const value = mod(a, m)
  if (value === 0n) throw new SignatureError('cannot invert zero')
  let [old_r, r] = [value, m]
  let [old_s, s] = [1n, 0n]
  while (r !== 0n) {
    const q = old_r / r
    ;[old_r, r] = [r, old_r - q * r]
    ;[old_s, s] = [s, old_s - q * s]
  }
  return mod(old_s, m)
}

function isOnCurve(point: Point): boolean {
  if (point === null) return true
  return mod(point.y * point.y - (point.x * point.x * point.x + B), P) === 0n
}

function double(point: Point): Point {
  if (point === null) return null
  // A point of order two has y = 0 and doubles to infinity. It cannot occur on this curve — the
  // order is prime — but the division below would be by zero, so it is handled rather than
  // assumed away.
  if (point.y === 0n) return null
  const lambda = mod(3n * point.x * point.x * invert(2n * point.y, P), P)
  const x = mod(lambda * lambda - 2n * point.x, P)
  return { x, y: mod(lambda * (point.x - x) - point.y, P) }
}

function add(a: Point, b: Point): Point {
  if (a === null) return b
  if (b === null) return a
  if (a.x === b.x) {
    // Same x: either the same point (double it) or a point and its negation (they cancel).
    return a.y === b.y ? double(a) : null
  }
  const lambda = mod((b.y - a.y) * invert(b.x - a.x, P), P)
  const x = mod(lambda * lambda - a.x - b.x, P)
  return { x, y: mod(lambda * (a.x - x) - a.y, P) }
}

/** Double-and-add. `scalar` is reduced mod `n` first, so a scalar of `n` is the identity. */
function multiply(point: Point, scalar: bigint): Point {
  let k = mod(scalar, N)
  if (k === 0n || point === null) return null
  let result: Point = null
  let addend: Point = point
  while (k > 0n) {
    if (k & 1n) result = add(result, addend)
    addend = double(addend)
    k >>= 1n
  }
  return result
}

/**
 * The square root of `value` mod p.
 *
 * `p ≡ 3 (mod 4)`, so a square root is `value^((p+1)/4)`. That exponent produces *a* candidate for
 * any input; whether the input was actually a residue is decided by squaring the result and
 * comparing, which the caller does. Skipping that check is how a point that is not on the curve
 * gets accepted, and a signature "recovered" against an off-curve point is a signature that
 * verifies against nothing.
 */
function sqrtMod(value: bigint): bigint {
  const exponent = (P + 1n) / 4n
  let result = 1n
  let base = mod(value, P)
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = mod(result * base, P)
    base = mod(base * base, P)
    e >>= 1n
  }
  return result
}

export interface Signature {
  readonly r: bigint
  readonly s: bigint
  /** 0 or 1. The `v` byte of an Ethereum signature is this plus 27. */
  readonly recovery: number
}

/**
 * Split a 65-byte `0x`-prefixed hex signature into `(r, s, recovery)`.
 *
 * Accepts `v` as 27/28 (the shape every wallet produces) and as 0/1 (the shape some libraries
 * produce). It refuses EIP-155-style `v` values from transaction signing: those encode a chain id
 * and do not belong on a personal-sign signature, and silently masking them down to a recovery bit
 * would accept a signature that was produced for something else entirely.
 */
export function parseSignature(hex: string): Signature {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (!/^[0-9a-fA-F]{130}$/.test(clean)) {
    throw new SignatureError('signature must be 65 bytes of hex (r, s, v)')
  }
  const r = BigInt(`0x${clean.slice(0, 64)}`)
  const s = BigInt(`0x${clean.slice(64, 128)}`)
  const v = Number.parseInt(clean.slice(128, 130), 16)

  const recovery = v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : -1
  if (recovery === -1) throw new SignatureError(`unsupported signature v byte: ${v}`)

  if (r <= 0n || r >= N) throw new SignatureError('signature r is out of range')
  if (s <= 0n || s >= N) throw new SignatureError('signature s is out of range')
  // EIP-2. See HALF_N.
  if (s > HALF_N) throw new SignatureError('signature s is in the upper half of the order (EIP-2)')

  return { r, s, recovery }
}

/**
 * Recover the uncompressed public key (64 bytes, no `0x04` prefix) that produced this signature.
 *
 * The construction is the standard one: rebuild the ephemeral point `R` from `r` and the recovery
 * bit, then `Q = r⁻¹(sR − zG)`.
 */
export function recoverPublicKey(digest: Uint8Array, signature: Signature): Uint8Array {
  if (digest.length !== 32) throw new SignatureError('digest must be 32 bytes')

  // The recovery bit's high bit says whether r wrapped past the order. It essentially never does
  // — the gap between n and p is about 2^-128 of the range — but a signature claiming it must
  // still be handled rather than silently mis-recovered.
  const x = signature.r + (signature.recovery >> 1 ? N : 0n)
  if (x >= P) throw new SignatureError('recovered x is not in the field')

  const ySquared = mod(x * x * x + B, P)
  let y = sqrtMod(ySquared)
  // The candidate is only a root if it squares back. Without this an x that is not on the curve
  // produces a point that is not on the curve, and everything after it is arithmetic on nonsense.
  if (mod(y * y, P) !== ySquared) throw new SignatureError('signature r is not a curve x-coordinate')
  if ((y & 1n) !== BigInt(signature.recovery & 1)) y = P - y

  const R: Point = { x, y }
  if (!isOnCurve(R)) throw new SignatureError('recovered point is not on the curve')

  const z = mod(BigInt(`0x${Buffer.from(digest).toString('hex')}`), N)
  const rInverse = invert(signature.r, N)

  // Q = r⁻¹ (sR − zG). `−zG` is `(n − z)G`, which keeps every scalar in [0, n).
  const sR = multiply(R, signature.s)
  const zG = multiply({ x: GX, y: GY }, mod(-z, N))
  const Q = multiply(add(sR, zG), rInverse)
  if (Q === null) throw new SignatureError('recovery produced the point at infinity')

  const out = new Uint8Array(64)
  out.set(hexToBytes(Q.x.toString(16).padStart(64, '0')), 0)
  out.set(hexToBytes(Q.y.toString(16).padStart(64, '0')), 32)
  return out
}

/**
 * The lowercase `0x` address of an uncompressed public key.
 *
 * Lowercase and not EIP-55: this is the *comparison* form. `addresses.ts` owns the display form,
 * and mixing the two is the bug forge-pay's withdrawal route carries a paragraph about.
 */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 64) throw new SignatureError('public key must be 64 bytes')
  const hash = keccak256(publicKey)
  return `0x${Buffer.from(hash.slice(12)).toString('hex')}`
}

/** Recover the signer's lowercase address in one step. */
export function recoverAddress(digest: Uint8Array, signatureHex: string): string {
  return addressFromPublicKey(recoverPublicKey(digest, parseSignature(signatureHex)))
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
