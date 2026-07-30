import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AddressError,
  canonicaliseAddress,
  chainForAsset,
  decimalsOf,
  familyOf,
  isValidAddress,
} from './addresses.ts'

test('the display form and the comparison form are produced together', () => {
  // The defect this exists to prevent, in one assertion. forge-pay's withdrawal route compared a
  // user-supplied address against EIP-55 rows, so the same account in lowercase passed the "is
  // this ours" checks and the user was charged a fee to move money in a circle.
  const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const lower = checksummed.toLowerCase()
  const upper = `0x${checksummed.slice(2).toUpperCase()}`

  for (const spelling of [checksummed, lower, upper]) {
    const canonical = canonicaliseAddress('eth', spelling)
    assert.equal(canonical.address, checksummed, `display form wrong for ${spelling}`)
    assert.equal(canonical.key, lower, `comparison form wrong for ${spelling}`)
  }
})

test('a mixed-case address that fails its checksum is refused', () => {
  // Mixed case is a claim to carry a checksum, so it is held to it. One flipped character.
  const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'
  assert.throws(() => canonicaliseAddress('eth', broken), AddressError)
  assert.equal(isValidAddress('eth', broken), false)
})

test('an EVM address of the wrong shape is refused', () => {
  for (const bad of ['', '0x', 'notanaddress', '0x1234', `0x${'a'.repeat(41)}`, `0x${'z'.repeat(40)}`]) {
    assert.equal(isValidAddress('eth', bad), false, `accepted ${bad}`)
  }
})

test('Ember uses the EVM rules, because Hearth is an account-model EVM chain', () => {
  assert.equal(familyOf('ember'), 'ember')
  const canonical = canonicaliseAddress('ember', '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')
  assert.equal(canonical.address, '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359')
  assert.equal(canonical.key, '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359')
})

test('Bitcoin base58check and bech32 are verified, not merely length-checked', () => {
  // A base58check address with a real checksum, and the same string with one character changed.
  const p2pkh = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
  assert.equal(isValidAddress('btc', p2pkh), true)
  assert.equal(isValidAddress('btc', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3'), false)

  const bech32 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  assert.equal(isValidAddress('btc', bech32), true)
  assert.equal(isValidAddress('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'), false)
  // Bech32 is case-insensitive but must not be mixed; and the two spellings are one address.
  assert.equal(canonicaliseAddress('btc', bech32.toUpperCase()).key, bech32)
  assert.equal(isValidAddress('btc', 'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), false)
})

test('XRP addresses use the ripple alphabet, and the bitcoin one does not pass', () => {
  const account = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH'
  assert.equal(isValidAddress('xrp', account), true)
  assert.equal(isValidAddress('xrp', `${account.slice(0, -1)}J`), false)
  // Decoding with the wrong alphabet yields a different payload that would still be a plausible
  // length, which is why the alphabet is a parameter rather than a constant.
  assert.equal(isValidAddress('xrp', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), false)
})

test('a Solana address must decode to exactly 32 bytes', () => {
  assert.equal(isValidAddress('sol', '11111111111111111111111111111111'), true)
  assert.equal(isValidAddress('sol', 'So11111111111111111111111111111111111111112'), true)
  assert.equal(isValidAddress('sol', 'notlongenough'), false)
  // Solana carries no checksum at all — the key IS the address — so this length check is the
  // strongest test that exists for the family, and it is stated rather than implied.
  assert.equal(isValidAddress('sol', '0'.repeat(44)), false)
})

test('an address is never valid for the wrong family', () => {
  const evm = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  assert.equal(isValidAddress('btc', evm), false)
  assert.equal(isValidAddress('xrp', evm), false)
  assert.equal(isValidAddress('sol', evm), false)
})

test('SHARD settles on no chain, and asking for its chain returns null rather than a default', () => {
  // A default here would mint a "Shard deposit address" on whatever chain came first in a map.
  assert.equal(chainForAsset('SHARD'), null)
  assert.equal(chainForAsset('USD'), null)
  assert.equal(chainForAsset('EMBER'), 'ember')
  assert.equal(chainForAsset('BTC'), 'btc')
})

test('decimals are read from contracts-chain and never restated', () => {
  // If these ever disagree with the exact-pinned package, money is credited at the wrong scale.
  assert.equal(decimalsOf('ember'), 18)
  assert.equal(decimalsOf('eth'), 18)
  assert.equal(decimalsOf('btc'), 8)
  assert.equal(decimalsOf('sol'), 9)
  assert.equal(decimalsOf('xrp'), 6)
})
