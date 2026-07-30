/**
 * Keccak-256.
 *
 * ## Why this is hand-rolled rather than a dependency
 *
 * Node's crypto has SHA3-256 but not Keccak-256. They are the *same permutation* with different
 * padding — NIST appends `0x06`, Ethereum appends `0x01` — so `createHash('sha3-256')` is not a
 * substitute, and reaching for it would produce plausible-looking wrong answers: a wrong address
 * that is still forty valid hex characters, and a signature that verifies against a message digest
 * nobody signed. The alternative is a dependency for two functions on the one path in this service
 * where a wrong answer sends money to a stranger. `repos/forge-pay/services/pay/src/keccak.ts`
 * made the same call for the same reason, and this is the same sixty lines of permutation.
 *
 * ## How it is tested, which is the part that matters
 *
 * `keccak.test.ts` does three things, and the second is the strong one:
 *
 *   1. The published vector: `keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca8227…`,
 *      which is also the vector in Hearth's own EVM spec.
 *   2. **The permutation is checked against Node's own SHA3-256** over hundreds of random inputs
 *      of every length around the 136-byte rate boundary. `sha3_256` below is this exact sponge
 *      with the NIST padding byte, so if the permutation, the rate, the lane packing or the
 *      absorb loop were wrong in any way, it would disagree with OpenSSL. That leaves precisely
 *      one constant — the domain byte — unverified by it, which is what (1) pins.
 *   3. EIP-55 vectors from the EIP itself.
 *
 * ## What it is for, both of which are money
 *
 *   1. **EIP-55.** An EVM address is 20 raw bytes with no checksum of its own; the only typo
 *      protection that exists is the mixed-case checksum, and verifying it needs Keccak. Without
 *      this, validating a withdrawal destination could only check "40 hex characters", which
 *      passes a mistyped address straight through to a payment.
 *   2. **EIP-191 / EIP-4361.** The digest a wallet actually signs is Keccak of the prefixed
 *      message, and recovering the signer's address is Keccak of the recovered public key.
 */

const MASK64 = (1n << 64n) - 1n

/** Keccak-f[1600] round constants — the ι step. */
const ROUND_CONSTANTS: readonly bigint[] = Object.freeze([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
])

/**
 * ρ rotation offsets, indexed by lane `x + 5y`.
 *
 * Laid out as five rows of five so it can be read against the table in FIPS 202 §3.2.2 rather
 * than trusted as twenty-five loose numbers.
 */
const ROTATIONS: readonly number[] = Object.freeze([
  /* y=0 */ 0, 1, 62, 28, 27,
  /* y=1 */ 36, 44, 6, 55, 20,
  /* y=2 */ 3, 10, 43, 25, 39,
  /* y=3 */ 41, 45, 15, 21, 8,
  /* y=4 */ 18, 2, 61, 56, 14,
])

function rotl(value: bigint, bits: number): bigint {
  if (bits === 0) return value
  const n = BigInt(bits)
  return ((value << n) | (value >> (64n - n))) & MASK64
}

/** Keccak-f[1600], in place on a 25-lane state. */
function permute(lanes: bigint[]): void {
  const c: bigint[] = [0n, 0n, 0n, 0n, 0n]
  const b: bigint[] = new Array<bigint>(25).fill(0n)

  for (const rc of ROUND_CONSTANTS) {
    // θ — parity of each column, folded back into every lane of the two neighbouring columns.
    for (let x = 0; x < 5; x++) {
      c[x] = lanes[x]! ^ lanes[x + 5]! ^ lanes[x + 10]! ^ lanes[x + 15]! ^ lanes[x + 20]!
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1)
      for (let y = 0; y < 25; y += 5) lanes[x + y] = lanes[x + y]! ^ d
    }

    // ρ and π together: rotate each lane, then move it to its permuted position.
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(lanes[x + 5 * y]!, ROTATIONS[x + 5 * y]!)
      }
    }

    // χ — the only non-linear step.
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        lanes[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK64 & b[((x + 2) % 5) + y]!)
      }
    }

    // ι.
    lanes[0] = lanes[0]! ^ rc
  }
}

/**
 * The sponge, parameterised by the domain-separation byte.
 *
 * `0x01` is original Keccak, which is what Ethereum uses. `0x06` is SHA-3 as standardised. The
 * byte is the *only* difference, and exposing it is what lets the test compare this construction
 * against OpenSSL's SHA3-256.
 */
function sponge(message: Uint8Array, domainByte: number, outputBytes: number): Uint8Array {
  const rate = 200 - 2 * outputBytes // 136 bytes for a 256-bit digest
  const lanes: bigint[] = new Array<bigint>(25).fill(0n)

  // Multi-rate padding: the domain byte at the front of the tail, 0x80 at the end of the block.
  // They land on the same byte when the tail is exactly one byte long, which is why this is an
  // OR rather than two writes.
  const padded = new Uint8Array(Math.ceil((message.length + 1) / rate) * rate)
  padded.set(message)
  padded[message.length] = domainByte
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      // Little-endian lane packing, as FIPS 202 §B.1 specifies.
      let lane = 0n
      for (let byte = 7; byte >= 0; byte--) {
        lane = (lane << 8n) | BigInt(padded[offset + i * 8 + byte] ?? 0)
      }
      lanes[i] = lanes[i]! ^ lane
    }
    permute(lanes)
  }

  const out = new Uint8Array(outputBytes)
  for (let i = 0; i < outputBytes; i++) {
    const lane = lanes[Math.floor(i / 8)]!
    out[i] = Number((lane >> BigInt(8 * (i % 8))) & 0xffn)
  }
  return out
}

/** Keccak-256, as Ethereum and Hearth use it. */
export function keccak256(message: Uint8Array): Uint8Array {
  return sponge(message, 0x01, 32)
}

/**
 * SHA3-256, as FIPS 202 standardised it.
 *
 * Exported **only** so the test can compare this permutation against Node's, which is an
 * independent implementation of the same primitive. Nothing in the service calls it; if something
 * ever needs SHA3 it should call `node:crypto`, which is faster and audited.
 */
export function sha3_256(message: Uint8Array): Uint8Array {
  return sponge(message, 0x06, 32)
}

export function keccak256Hex(message: Uint8Array): string {
  return Buffer.from(keccak256(message)).toString('hex')
}
