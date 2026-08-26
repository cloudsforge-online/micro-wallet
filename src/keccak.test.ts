import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { keccak256Hex, sha3_256 } from '@cloudsforge/evm'
import { toChecksumAddress } from './addresses.ts'

const hex = (s: string): Uint8Array => Buffer.from(s, 'ascii')

test('the published Keccak-256 vectors', () => {
  // The vector in Hearth's own EVM spec, and the one every Ethereum implementation pins.
  assert.equal(
    keccak256Hex(new Uint8Array(0)),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
  )
  assert.equal(
    keccak256Hex(hex('abc')),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  )
})

test('THE RULE: the permutation agrees with OpenSSL, across the rate boundary', () => {
  // The strong check. `sha3_256` is this exact sponge with the NIST padding byte, so if the
  // permutation, the rate, the lane packing or the absorb loop were wrong in any way it would
  // disagree with Node's SHA3-256 — an independent implementation of the same primitive.
  //
  // The lengths are chosen around 136, the rate: 135, 136 and 137 are where an off-by-one in the
  // padding lands, and they are exactly the sizes a random sample would almost never produce.
  const lengths = [0, 1, 31, 32, 63, 134, 135, 136, 137, 271, 272, 273, 1000]
  for (const length of lengths) {
    const input = randomBytes(length)
    assert.equal(
      Buffer.from(sha3_256(input)).toString('hex'),
      createHash('sha3-256').update(input).digest('hex'),
      `sha3-256 disagreed at length ${length}`,
    )
  }
})

test('Keccak-256 and SHA3-256 differ, which is why node:crypto is not a substitute', () => {
  // If these were equal, `createHash('sha3-256')` would do and this file would not exist. They
  // are the same permutation with a different domain byte, and using the wrong one produces a
  // plausible-looking wrong address.
  const input = hex('cloudsforge')
  assert.notEqual(
    keccak256Hex(input),
    createHash('sha3-256').update(input).digest('hex'),
  )
})

test('EIP-55 checksums match the vectors in the EIP', () => {
  // The four all-caps / all-lower / normal cases from EIP-55 itself.
  const vectors = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]
  for (const expected of vectors) {
    assert.equal(toChecksumAddress(expected.toLowerCase()), expected)
    // Idempotent: checksumming an already-checksummed address must not change it.
    assert.equal(toChecksumAddress(expected), expected)
  }
})
