import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AddressError,
  bitcoinFamilyParams,
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
  // The gap this whole change closes. `chainForAsset('LTC')` returning null is what made
  // `requestWithdrawal` answer 422 not_withdrawable and `assignDepositAddress` 400 not_depositable
  // for an asset the ledger already holds balances in.
  assert.equal(chainForAsset('LTC'), 'ltc')
})

test('decimals are read from contracts-chain and never restated', () => {
  // If these ever disagree with the exact-pinned package, money is credited at the wrong scale.
  assert.equal(decimalsOf('ember'), 18)
  assert.equal(decimalsOf('eth'), 18)
  assert.equal(decimalsOf('btc'), 8)
  assert.equal(decimalsOf('sol'), 9)
  assert.equal(decimalsOf('xrp'), 6)
  assert.equal(decimalsOf('ltc'), 8)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * LITECOIN — and the question is never "is this a valid address" but "is it a LITECOIN address".
 *
 * `familyOf('ltc')` is `'bitcoin'`, so every check that switches on the family alone answers
 * Bitcoin's rules for Litecoin. The result is a `bc1…` address accepted as a Litecoin withdrawal
 * destination: well-formed, correct checksum, nothing thrown, coins gone.
 *
 * ── EVERY VECTOR BELOW IS PUBLISHED. NONE IS COMPUTED HERE ────────────────────────────────────
 *
 * A vector this repository generated would agree with any mistake this repository makes — it would
 * prove the encoder and the decoder are the same code, which they are, and nothing else. So:
 *
 *   * Litecoin's come from `litecoin-project/litecoin`, `src/test/data/key_io_valid.json`, which is
 *     the file Litecoin Core's own `key_io_tests` runs against. Address AND script are quoted, so
 *     the pair can be re-checked against the source rather than taken on trust.
 *   * The BIP-44 legacy ones come from `trezor/trezor-firmware`,
 *     `tests/device_tests/bitcoin/test_getaddress.py::test_ltc` — the same vector custody derives
 *     against, so the two services are held to one published answer rather than to each other.
 *   * Bitcoin's come from `bitcoin/bitcoin`, `src/test/data/key_io_valid.json`.
 *
 * Each vector is asserted VALID on its own chain in the same test that asserts it invalid on the
 * other. That is deliberate: a mistyped vector would be refused everywhere and a "refused on the
 * wrong chain" assertion alone would pass for the wrong reason.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** `litecoin/src/test/data/key_io_valid.json`, chain `main`. Address → the script Core decodes it to. */
const LITECOIN_MAINNET_VECTORS: readonly (readonly [string, string])[] = [
  // P2PKH, version byte 48 → `L…`
  ['LT2KVaAy1ppRuxRgrS5RNU3vBsy7RibPeA', '76a914558dbca7118cd5894502767c7b2ffc21a22f54db88ac'],
  ['LbfVMz974gbbGFqXF7FZUpSBWSbwBHDwR5', '76a914b4565f467408e9e1c1d2a3b0ccdeff84db3a3b9388ac'],
  // P2SH, version byte 50 (SCRIPT_ADDRESS2) → `M…`
  ['MHrYRxAiMNBTku3eoDHwhA1LQGDjUStZW2', 'a9146d328a5b2a20d943a641c8d29b6cc3c2d2df85d387'],
  ['M9dw1FAoWpHC6PcMzoCHhqQ9McvTyG5Ywj', 'a914130ef8742ad7492b389509252c6721775fb1127387'],
  // P2WPKH and P2WSH, witness version 0, bech32
  ['ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w', '0014bb6ec1bb3a1a01381d2251d79cbee1b8e86f73ee'],
  [
    'ltc1qa9dykljtgeayhm8ygx25sc22p0wzgudpe4hw9dyvaz0ye3j5kduq9mf68z',
    '0020e95a4b7e4b467a4bece4419548614a0bdc2471a1cd6ee2b48ce89e4cc654b378',
  ],
] as const

/**
 * Also from Core's file, also perfectly valid addresses, and REFUSED here — see
 * `assertPayableWitnessVersion`. Taproot (witness version 1) and the reserved higher versions
 * cannot be decoded by the library settlement builds with and custody signs with, so accepting one
 * would reserve a user's balance against an address the estate cannot pay.
 */
const UNPAYABLE_WITNESS_VECTORS: readonly string[] = [
  // Taproot, witness version 1, bech32m.
  'ltc1ppu2gv0tujus0f6eggrk7eqmaf0567x6zer4fcuhz4z7ztzq9u9yseqxltc',
  'tltc1pfnh6ljtrdgk4hh3acvu39a742vaqmd2khnd0tp9d0prcnvpq6zgqn0ecgk',
  // Witness version 2, which no chain here has activated at all.
  'ltc1zjwls6j8c4u',
] as const

/** The same file, chain `test`. */
const LITECOIN_TESTNET_VECTORS: readonly (readonly [string, string])[] = [
  ['tltc1qpftpsvdn6mjp8celrkj0qxqy4jlapl959rlwg9', '00140a561831b3d6e413e33f1da4f01804acbfd0fcb4'],
  ['tltc1quf7ycjczjpjd6u9a8mpa00jl7g9aplhy8e0vf7', '0014e27c4c4b029064dd70bd3ec3d7be5ff20bd0fee4'],
] as const

/**
 * `trezor-firmware`, `test_getaddress.py::test_ltc`. Legacy P2PKH at `m/44'/2'/0'/0/0`, `…/0/1`
 * and `…/1/0` of Trezor's published test mnemonic. custody asserts the FIRST of these against its
 * own derivation (`custody/src/hd.test.ts`), so this service and that one are pinned to one
 * published string rather than to each other's arithmetic.
 */
const TREZOR_LTC_VECTORS: readonly string[] = [
  'LcubERmHD31PWup1fbozpKuiqjHZ4anxcL',
  'LVWBmHBkCGNjSPHucvL2PmnuRAJnucmRE6',
  'LWj6ApswZxay4cJEJES2sGe7fLMLRvvv8h',
] as const

/** `bitcoin/src/test/data/key_io_valid.json`. */
const BITCOIN_VECTORS: readonly string[] = [
  '1FsSia9rv4NeEwvJ2GvXrX7LyxYspbN2mo', // P2PKH, version 0
  '36j4NfKv6Akva9amjWrLG6MuSQym1GuEmm', // P2SH, version 5
  'bc1qvyq0cc6rahyvsazfdje0twl7ez82ndmuac2lhv', // P2WPKH
  '2NC2hEhe28ULKAJkW5MjZ3jtTMJdvXmByvK', // testnet P2SH, version 196
  'tb1qcrh3yqn4nlleplcez2yndq2ry8h9ncg3qh7n54', // testnet P2WPKH
] as const

test("LITECOIN: Core's own published address vectors are accepted, on both networks", () => {
  for (const [address] of [...LITECOIN_MAINNET_VECTORS, ...LITECOIN_TESTNET_VECTORS]) {
    assert.equal(isValidAddress('ltc', address), true, `refused Core's own vector ${address}`)
  }
  for (const address of TREZOR_LTC_VECTORS) {
    assert.equal(isValidAddress('ltc', address), true, `refused Trezor's vector ${address}`)
  }
})

test('LITECOIN: a Bitcoin address is REFUSED on the Litecoin path — the defect that loses coins', () => {
  for (const address of BITCOIN_VECTORS) {
    // Valid Bitcoin, which is what makes it dangerous rather than merely wrong.
    assert.equal(isValidAddress('btc', address), true, `${address} is not a valid BTC address`)
    assert.equal(
      isValidAddress('ltc', address),
      false,
      `${address} is a Bitcoin address and was accepted as a Litecoin destination`,
    )
  }
})

test('LITECOIN: a Litecoin address is refused on the Bitcoin path, which is the same rule', () => {
  for (const [address] of LITECOIN_MAINNET_VECTORS) {
    assert.equal(isValidAddress('btc', address), false, `${address} was accepted as Bitcoin`)
  }
  for (const address of TREZOR_LTC_VECTORS) {
    assert.equal(isValidAddress('btc', address), false, `${address} was accepted as Bitcoin`)
  }
})

test('LITECOIN: the refusal names the chain, because "invalid address" would send a user hunting a typo', () => {
  assert.throws(
    () => canonicaliseAddress('ltc', 'bc1qvyq0cc6rahyvsazfdje0twl7ez82ndmuac2lhv'),
    (err: Error) => err instanceof AddressError && /BTC address/.test(err.message),
  )
  assert.throws(
    () => canonicaliseAddress('ltc', '1FsSia9rv4NeEwvJ2GvXrX7LyxYspbN2mo'),
    (err: Error) => err instanceof AddressError && /version byte 0\b/.test(err.message),
  )
})

test('LITECOIN: the HRP is inside the checksum, so this is not a prefix comparison', () => {
  /*
   * The single assertion that separates a real bech32 check from `startsWith('ltc1')`.
   *
   * BIP-173's own published vector, `bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4`, with the human-
   * readable part rewritten to `ltc` and the 39-character data part left byte-for-byte alone. It
   * has the right prefix, the right length and the right alphabet, and it must still be refused —
   * because `bech32Expand(prefix)` feeds the HRP into the polymod, so changing it invalidates the
   * checksum of an otherwise untouched string.
   *
   * A prefix-matching implementation accepts this and would therefore accept a Bitcoin address
   * with three characters changed as a Litecoin destination.
   */
  const bip173 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  assert.equal(isValidAddress('btc', bip173), true, "BIP-173's vector must be valid Bitcoin")
  const relabelled = `ltc1${bip173.slice('bc1'.length)}`
  assert.equal(relabelled.startsWith('ltc1'), true, 'the mutant must look like a Litecoin address')
  assert.equal(
    isValidAddress('ltc', relabelled),
    false,
    'a Bitcoin data part relabelled ltc1 was accepted — the HRP is not being checksummed',
  )
})

test('LITECOIN: mainnet P2SH `3…` is refused, though Core would DECODE it', () => {
  /*
   * Litecoin has two P2SH prefixes. `key_io.cpp` decodes both 5 (`3…`) and 50 (`M…`) and encodes
   * only 50, so a `3…` string is simultaneously a valid Bitcoin mainnet P2SH address and a valid
   * Litecoin one with nothing in it to say which was meant. Accepting it would mean telling a user
   * who pasted a Bitcoin address into the Litecoin field that it is fine.
   *
   * It is also the only answer settlement can honour: bitcoinjs-lib's Litecoin parameters carry
   * `scriptHash: 0x32`, so `toOutputScript` refuses `3…` and a withdrawal accepted here would die
   * at build time with the user's money already reserved.
   */
  const bitcoinP2sh = '36j4NfKv6Akva9amjWrLG6MuSQym1GuEmm'
  assert.equal(isValidAddress('btc', bitcoinP2sh), true)
  assert.equal(isValidAddress('ltc', bitcoinP2sh), false)
  // And the `M…` form Core actually encodes IS accepted, so this is a narrowing and not a ban.
  assert.equal(isValidAddress('ltc', 'MHrYRxAiMNBTku3eoDHwhA1LQGDjUStZW2'), true)
})

test('LITECOIN: the testnet legacy collision is REAL, and is asserted rather than hidden', () => {
  /*
   * Bitcoin testnet and Litecoin testnet share `PUBKEY_ADDRESS` = 111. A legacy `m…`/`n…` testnet
   * address is byte-for-byte both chains' and NOTHING can tell them apart — that is a property of
   * the two chains, not of this code, and a test that pretended otherwise would be asserting a
   * guarantee the estate does not have.
   *
   * It is pinned here so the repeated 0x6f in `BITCOIN_FAMILY_PARAMS` reads as deliberate rather
   * than as a copy-paste, and so that anyone who "fixes" it has to delete this and say why. The
   * collision does not exist on mainnet — Bitcoin's 0 against Litecoin's 48 — which is where the
   * value is.
   */
  const sharedTestnet = 'mzK2FFDEhxqHcmrJw1ysqFkVyhUULo45hZ'
  assert.equal(isValidAddress('btc', sharedTestnet), true)
  assert.equal(isValidAddress('ltc', sharedTestnet), true)
})

test('BITCOIN FAMILY: a Taproot destination is refused, because the estate cannot pay one', () => {
  /*
   * ── FOUND WHILE ADDING LITECOIN; IT IS A BITCOIN DEFECT AND IT WAS ALREADY LIVE ──────────────
   *
   * `settlement` decodes a destination with `bitcoinjs-lib@6.1.7`'s `toOutputScript`, which for
   * witness version 1 routes through the `p2tr` payment and throws `No ECC Library provided`.
   * Nothing in this estate calls `initEccLib` — settlement has no secp256k1 package at all and
   * custody has one it never initialises — so a `bc1p…` address cannot be built for OR signed.
   *
   * Until this check, a user withdrawing to a Taproot address had their balance RESERVED and the
   * row queued before that failure surfaced. The refusal is here, at the boundary, where it costs
   * an error message instead of a reservation to unwind.
   *
   * This test is deliberately about BOTH chains. Asserting it only for `ltc` would read as a
   * Litecoin limitation, and the limitation is the estate's.
   */
  for (const address of UNPAYABLE_WITNESS_VECTORS) {
    assert.equal(isValidAddress('ltc', address), false, `${address} was accepted`)
  }
  // BIP-350's own published Taproot vector, on Bitcoin, refused for exactly the same reason.
  const taproot = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'
  assert.equal(isValidAddress('btc', taproot), false)
  assert.throws(
    () => canonicaliseAddress('btc', taproot),
    (err: Error) => err instanceof AddressError && /witness version 1/.test(err.message),
  )
  // Version 0 is unaffected, so this is a bound on the output TYPE and not on segwit.
  assert.equal(isValidAddress('btc', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), true)
  assert.equal(isValidAddress('ltc', 'ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w'), true)
})

test('LITECOIN: an unknown bitcoin-family chain throws rather than falling back to Bitcoin', () => {
  /*
   * The default that does not exist, asserted.
   *
   * Tested through `bitcoinFamilyParams` directly and not through `canonicaliseAddress`, because
   * the case it guards cannot be reached from outside today: a chain absent from `ASSET_FOR_CHAIN`
   * dies earlier, in `chainSpec`. The case is a chain that IS in `ASSET_FOR_CHAIN` with
   * `family: 'bitcoin'` and is NOT in the parameter table — which is precisely what the next
   * Bitcoin-derived chain looks like on the commit that adds it and forgets this file.
   */
  assert.throws(
    () => bitcoinFamilyParams('doge' as never),
    (err: Error) => err instanceof AddressError && /no bitcoin-family address parameters/.test(err.message),
  )
  // And the two that do exist answer, so the throw above is not simply "this function always throws".
  assert.deepEqual([...bitcoinFamilyParams('btc').hrps], ['bc', 'tb', 'bcrt'])
  assert.deepEqual([...bitcoinFamilyParams('ltc').hrps], ['ltc', 'tltc', 'rltc'])
})
