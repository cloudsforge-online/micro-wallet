import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS, RETIRED_ASSETS, chainSpec, type AssetCode } from '@cloudsforge/contracts-chain'
import {
  AddressError,
  CHAIN_IDS,
  assetOf,
  bitcoinFamilyParams,
  canonicaliseAddress,
  chainForAsset,
  custodyChainOf,
  decimalsOf,
  familyOf,
  isChainId,
  isValidAddress,
  type ChainId,
} from './addresses.ts'

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CHAIN VOCABULARY IS DERIVED FROM THE ASSET UNION, NOT RE-TYPED BESIDE IT
 *
 * Everything below is driven off `CHAINS` in contracts-chain rather than off a list written here.
 * A test that names the eight chains is a ninth copy of the list under test, and it passes on the
 * day a ninth asset lands for the same reason the code did: nobody edited it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Every asset the estate can newly issue — the set this service must have a chain slug for. */
const ISSUABLE = Object.keys(CHAINS).filter(
  (asset) => !RETIRED_ASSETS.includes(asset as AssetCode),
) as readonly AssetCode[]

test('every issuable asset has a chain slug, and every slug an issuable asset', () => {
  // The bijection, asserted in both directions over the registry. `CHAIN_IDS` used to be eight
  // string literals and `CHAIN_FOR_ASSET` a `Partial<Record<AssetCode, ChainId>>` holding the same
  // eight pairs inverted by hand — three lists that had to be edited together, one of which had
  // the compiler switched off. LTC, then DOGE and ETC, were each added to all three by somebody
  // remembering to. This assertion is what remembering used to be.
  assert.deepEqual(
    [...CHAIN_IDS].sort(),
    ISSUABLE.map((asset) => asset.toLowerCase()).sort(),
    'CHAIN_IDS and the issuable assets have drifted apart',
  )
  for (const asset of ISSUABLE) {
    const chain = chainForAsset(asset)
    assert.ok(chain !== null, `${asset} is issuable and has no chain slug`)
    assert.equal(assetOf(chain), asset, `${asset} does not round-trip through its slug`)
  }
})

test('a retired asset has no chain slug, so its deposit address request fails rather than defaults', () => {
  // SHARD is a platform unit with no chain; an address for it could only ever be a lie. Driven off
  // `RETIRED_ASSETS` rather than naming SHARD, because the next retirement gets the same treatment
  // without an edit here.
  for (const retired of RETIRED_ASSETS) {
    assert.equal(chainForAsset(retired), null, `${retired} is retired and must have no chain`)
    assert.equal(isChainId(retired.toLowerCase()), false)
  }
})

test('"issuable" and "has a chain" coincide today, and this fails on the day they stop', () => {
  // `ChainId` is `Lowercase<IssuableAssetCode>`, which quietly assumes that the only assets without
  // a chain are the retired ones. That is true because SHARD is both the only retired asset and the
  // only chainless one — a coincidence, not a rule. Retiring an asset that HAS on-chain history
  // would drop its slug out of the type while its rows and its `chain` column still carry it, and
  // the derivation would have to change. This is that day's alarm.
  for (const retired of RETIRED_ASSETS) {
    const spec = chainSpec(retired)
    assert.equal(
      spec.confirmations,
      0,
      `${retired} is retired but credits at a real depth, so it has chain history that needs its slug`,
    )
  }
})

test('every chain slug answers for the whole vocabulary this service speaks', () => {
  // The three derived answers, over the derived list. A chain reachable by `isChainId` that then
  // throws inside `familyOf` or `custodyChainOf` is a 500 on a route that already said yes.
  for (const chain of CHAIN_IDS) {
    assert.ok(isChainId(chain))
    assert.ok(decimalsOf(chain) > 0, `${chain} has no decimals`)
    assert.ok(familyOf(chain).length > 0, `${chain} has no family`)
    assert.ok(custodyChainOf(chain).length > 0, `${chain} has no custody chain name`)
  }
})

test('EVERY BITCOIN-FAMILY CHAIN HAS ITS OWN PARAMETERS — a missing row is a chain nobody can use', () => {
  // `BITCOIN_FAMILY_PARAMS` is keyed by `string` and `bitcoinFamilyParams` throws for an absent
  // chain, which is the right behaviour and is deliberately not a default (see the header). But
  // "throws" is only safe, not correct: a fourth bitcoin-family chain added to `AssetCode` compiles
  // everywhere, passes `isChainId`, and then refuses every address a user submits with an error
  // about parameters. Fail-closed, and completely unusable. That gap is now a test failure at the
  // point the chain is added rather than a support ticket after it.
  const bitcoinChains = CHAIN_IDS.filter((chain) => familyOf(chain) === 'bitcoin')
  assert.ok(bitcoinChains.length >= 3, 'btc, ltc and doge are all bitcoin-family')
  for (const chain of bitcoinChains) {
    const params = bitcoinFamilyParams(chain)
    // `hrps` may legitimately be empty — Dogecoin declares no bech32 HRP on any network — so the
    // check is on the version bytes, which every base58 chain in the family must have.
    assert.ok(params.versions.length > 0, `${chain} is bitcoin-family with no base58 version bytes`)
  }
})

test('no two bitcoin-family chains share a base58 version byte or an HRP', () => {
  // The mirror of the above, and the failure it guards is the expensive one: a shared prefix means
  // an address valid on one chain validates as an address on another, and the coins land in an
  // output nobody holds the key to. Asserted over the derived list so the next member is covered.
  const seenVersions = new Map<number, ChainId>()
  const seenHrps = new Map<string, ChainId>()
  for (const chain of CHAIN_IDS.filter((c) => familyOf(c) === 'bitcoin')) {
    const params = bitcoinFamilyParams(chain)
    for (const version of params.versions) {
      // 0x6f and 0xc4 are shared BY DESIGN — Litecoin and Dogecoin kept Bitcoin's TESTNET version
      // bytes, which is a fact about those chains and not a defect here. Mainnet bytes are the ones
      // that must be disjoint, and those are the low-numbered rows.
      if (version === 0x6f || version === 0xc4) continue
      const other = seenVersions.get(version)
      assert.equal(other, undefined, `${chain} and ${other} share mainnet version byte ${version}`)
      seenVersions.set(version, chain)
    }
    for (const hrp of params.hrps) {
      const other = seenHrps.get(hrp)
      assert.equal(other, undefined, `${chain} and ${other} share the bech32 HRP '${hrp}'`)
      seenHrps.set(hrp, chain)
    }
  }
})

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
   *
   * The stand-in used to be `doge`, which is now a real row in that table — this test was written
   * against the commit it was warning about, and that commit arrived. `bch` replaces it: Bitcoin
   * Cash is the obvious next bitcoin-family candidate, `contracts-chain` does not carry it, and a
   * fixture naming a chain nobody has added is the only kind that stays honest.
   */
  assert.throws(
    () => bitcoinFamilyParams('bch' as never),
    (err: Error) => err instanceof AddressError && /no bitcoin-family address parameters/.test(err.message),
  )
  // And the three that do exist answer, so the throw above is not simply "this function always
  // throws" — including the one whose answer is an EMPTY list of HRPs, which is the case a
  // truthiness check on the returned array would have got wrong.
  assert.deepEqual([...bitcoinFamilyParams('btc').hrps], ['bc', 'tb', 'bcrt'])
  assert.deepEqual([...bitcoinFamilyParams('ltc').hrps], ['ltc', 'tltc', 'rltc'])
  assert.deepEqual([...bitcoinFamilyParams('doge').hrps], [])
  assert.equal(bitcoinFamilyParams('doge').versions.length, 4)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * DOGECOIN — the bitcoin-family chain that does not have one of the family's encodings.
 *
 * Litecoin's lesson was that a family shares its encodings but not the PARAMETERS they are applied
 * with. Dogecoin's is one step further: `dogecoin/dogecoin`, `src/chainparams.cpp`, read at
 * `master` on 2026-08-09, declares no `bech32_hrp` on any network. There is no segwit here to have
 * parameters for. A validator that answered `familyOf('doge') === 'bitcoin'` with the family's
 * bech32 branch would accept a well-formed `doge1…` string no Dogecoin node can ever pay to and —
 * worse, because it is the mistake a user makes rather than a developer — a real `bc1…` address.
 *
 * ── THE VECTORS ARE PUBLISHED, FOR THE REASON THE LITECOIN BLOCK GIVES ────────────────────────
 *
 * All of them come from `dogecoin/dogecoin`, `src/test/data/base58_keys_valid.json`, the file
 * Dogecoin Core's own `base58_tests` runs against. The 20-byte hash is quoted beside each address
 * so the pair can be re-checked against that file rather than taken on trust, and so a
 * transcription slip shows up as a hash that does not match rather than as a green test.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** That file, `isTestnet: false`. Address → the hash160 Core decodes it to. */
const DOGECOIN_MAINNET_VECTORS: readonly (readonly [string, string])[] = [
  // P2PKH, version byte 30 (0x1e) → `D…`
  ['DD4KSSuBJqcjuTcvUg1CgUKeurPUFeEZkE', '56d9b1d684d5abef32134ebc6883d75d3a53e9be'],
  ['DBjW6kna7rUPE4Mj9j4B3oK3xVA1SDHrdt', '485290865b407657e0aedbdbb4aa6618310af50d'],
  ['DGYdw7jC17b9SappjsrAsaghhDTS8sV5Mx', '7d1d283ff32f3a425ea22d21032e1bca7d14efaa'],
  // P2SH, version byte 22 (0x16). It spans two leading characters, `9…` and `A…`, so both are
  // here: a first-character check would have accepted one of these and refused the other, and
  // passed the whole suite on the strength of the one it accepted.
  ['A7HRQk3GFCW2QasvdZxXuYj8kkQK5QrYLs', 'a2dd71f34fe73314d6e37c44035513f203aa400b'],
  ['9zYnVRaekPtdKBYuPw5QiBtv3NNrzD2LLW', '58fc66bf64b3c8d8accd80110bb6df6c13735937'],
] as const

/** The same file, `isTestnet: true`. P2PKH is 113 (0x71) → `n…`; P2SH is 196 (0xc4) → `2…`. */
const DOGECOIN_TESTNET_VECTORS: readonly (readonly [string, string])[] = [
  ['nhRsrUaxZou6sewjqaS37cJrMRJRgwVXdk', '9131c29384f000c0d651660eefaf1717c8ca1855'],
  ['ngbSgr1dhCqsLg6Z5tpsaCspwrH72x2Zk3', '8808c94daaa2e4f53102703b2c3de534d670e87e'],
  ['2MsvyG12kxxipe276Au4zKqvd2xdrBuHWb3', '078457e357c6c4d8736515d14482089dd2a1f9f8'],
] as const

test("DOGECOIN: Core's own published address vectors are accepted, on both networks", () => {
  for (const [address] of [...DOGECOIN_MAINNET_VECTORS, ...DOGECOIN_TESTNET_VECTORS]) {
    assert.equal(isValidAddress('doge', address), true, `refused Core's own vector ${address}`)
  }
})

test('DOGECOIN: a Bitcoin or Litecoin address is REFUSED on the Dogecoin path', () => {
  for (const address of BITCOIN_VECTORS) {
    // The one exception is deliberate and gets its own test below: testnet P2SH is version 196 on
    // both chains, so that string genuinely is a valid address on each.
    if (address === '2NC2hEhe28ULKAJkW5MjZ3jtTMJdvXmByvK') continue
    // Valid on its own chain, which is what makes it dangerous rather than merely wrong.
    assert.equal(isValidAddress('btc', address), true, `${address} is not a valid BTC address`)
    assert.equal(
      isValidAddress('doge', address),
      false,
      `${address} is a Bitcoin address and was accepted as a Dogecoin destination`,
    )
  }
  for (const [address] of LITECOIN_MAINNET_VECTORS) {
    assert.equal(isValidAddress('ltc', address), true, `${address} is not a valid LTC address`)
    assert.equal(isValidAddress('doge', address), false, `${address} was accepted as Dogecoin`)
  }
})

test('DOGECOIN: a Dogecoin address is refused on Bitcoin and Litecoin, which is the same rule', () => {
  for (const [address] of DOGECOIN_MAINNET_VECTORS) {
    assert.equal(isValidAddress('btc', address), false, `${address} was accepted as Bitcoin`)
    assert.equal(isValidAddress('ltc', address), false, `${address} was accepted as Litecoin`)
  }
  // Testnet P2PKH too, and this is the near miss worth pinning: Dogecoin's 113 is two away from
  // Bitcoin's and Litecoin's 111, close enough that all three can print a leading `n`. The version
  // byte is the only thing separating them, so a check that looked at the first character would
  // pass this and be wrong.
  const dogeTestnetP2pkh = DOGECOIN_TESTNET_VECTORS[0]![0]
  assert.equal(dogeTestnetP2pkh.startsWith('n'), true)
  assert.equal(isValidAddress('doge', dogeTestnetP2pkh), true)
  assert.equal(isValidAddress('btc', dogeTestnetP2pkh), false, 'the 113/111 gap is not being checked')
  assert.equal(isValidAddress('ltc', dogeTestnetP2pkh), false, 'the 113/111 gap is not being checked')
})

test('DOGECOIN: there is no bech32, so a `doge1…` string is not an address at all', () => {
  /*
   * The assertion that separates "Dogecoin was given no HRP" from "Dogecoin was given an empty one
   * and something else quietly fills it in".
   *
   * BIP-173's own published vector with its human-readable part rewritten to `doge` and the data
   * part left byte-for-byte alone — the same mutation the Litecoin HRP test performs, for the
   * opposite reason. There it must fail because the HRP is inside the checksum. Here it must fail
   * because there is no bech32 branch for this chain to enter under any HRP whatever.
   */
  const bip173 = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const relabelled = `doge1${bip173.slice('bc1'.length)}`
  assert.equal(isValidAddress('doge', relabelled), false, 'a doge1… string was accepted')
  // And a REAL segwit address of another chain in this family is refused with a message that names
  // that chain, rather than dying as an undecodable base58 payload. This is the paste a user
  // actually makes, and `HRP_OWNER` is what makes the error say so.
  assert.throws(
    () => canonicaliseAddress('doge', bip173),
    (err: Error) => err instanceof AddressError && /BTC address/.test(err.message),
  )
  assert.throws(
    () => canonicaliseAddress('doge', 'ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w'),
    (err: Error) => err instanceof AddressError && /LTC address/.test(err.message),
  )
})

test('DOGECOIN: the refusal names the version byte, so a wrong-chain paste is explicable', () => {
  assert.throws(
    () => canonicaliseAddress('doge', '1FsSia9rv4NeEwvJ2GvXrX7LyxYspbN2mo'),
    (err: Error) => err instanceof AddressError && /version byte 0\b/.test(err.message),
  )
  // Litecoin mainnet P2PKH, version 48.
  assert.throws(
    () => canonicaliseAddress('doge', 'LT2KVaAy1ppRuxRgrS5RNU3vBsy7RibPeA'),
    (err: Error) => err instanceof AddressError && /version byte 48\b/.test(err.message),
  )
})

test('DOGECOIN: the testnet P2SH collision with Bitcoin is REAL, and is asserted rather than hidden', () => {
  /*
   * Dogecoin testnet and Bitcoin testnet share `SCRIPT_ADDRESS` = 196. A `2…` testnet P2SH address
   * is byte-for-byte both chains' and nothing can tell them apart — a property of the two chains
   * and not of this code, the same shape of unclosable collision as Litecoin's 111 one section up.
   *
   * Pinned here so the 0xc4 that now appears in two rows of `BITCOIN_FAMILY_PARAMS` reads as
   * deliberate rather than as a copy-paste, and so anyone who "fixes" it has to delete this and say
   * why. It does not exist on mainnet, where Dogecoin's 22 and Bitcoin's 5 are disjoint, and
   * mainnet is where the value is.
   */
  const sharedTestnet = '2MsvyG12kxxipe276Au4zKqvd2xdrBuHWb3'
  assert.equal(isValidAddress('doge', sharedTestnet), true)
  assert.equal(isValidAddress('btc', sharedTestnet), true)
  // Litecoin is NOT in this collision: its testnet P2SH is SCRIPT_ADDRESS2 = 58, and 196 is
  // deliberately absent from its row for the reason the `3…` paragraph in `addresses.ts` gives.
  assert.equal(isValidAddress('ltc', sharedTestnet), false)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * ETHEREUM CLASSIC — nothing about the ADDRESS is new, and that is the finding rather than a gap
 * in the tests below.
 *
 * ETC shares Ethereum's address format entirely: 20 bytes, EIP-55, and no chain identifier inside
 * the string. So there is no wrong-chain paste for this file to catch and no parameter table to
 * get wrong — an ETC address and an ETH address are the same bytes and the same key controls both.
 *
 * What differs is the CHAIN ID, which is what an EIP-4361 link message commits to and which
 * `siwe.ts` reads out of `contracts-chain` rather than restating, and the GAS MODEL, which is
 * custody's problem and not this service's (`custody/src/chains.ts`, `isLegacyGasOnlyChain`).
 * These tests therefore assert that the reading happens and never what the number is.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

test('ETHEREUM CLASSIC: it uses the EVM rules, and an ETH address is the same account', () => {
  assert.equal(familyOf('etc'), 'evm')
  assert.equal(familyOf('etc'), familyOf('eth'))
  const lower = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
  const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  for (const chain of ['eth', 'etc'] as const) {
    const canonical = canonicaliseAddress(chain, lower)
    assert.equal(canonical.address, checksummed)
    assert.equal(canonical.key, lower)
  }
  // Mixed case is still held to its checksum, exactly as it is for ETH. The point is that ETC
  // inherits the whole rule, not that it is exempt from the strict half of it.
  assert.equal(isValidAddress('etc', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), false)
  // And it is not on the bitcoin-family path, so asking for parameters it has none of must throw
  // rather than answer Bitcoin's.
  assert.throws(() => bitcoinFamilyParams('etc' as never), AddressError)
})

test('the two new assets resolve to chains, which is what makes them reachable at all', () => {
  // The same gap `chainForAsset('LTC')` closed: a null here makes `requestWithdrawal` answer 422
  // not_withdrawable and `assignDepositAddress` 400 not_depositable for an asset the ledger can
  // already hold a balance in, which presents as an outage rather than as an unwired chain.
  assert.equal(chainForAsset('DOGE'), 'doge')
  assert.equal(chainForAsset('ETC'), 'etc')
  // Read from the exact-pinned package and never restated. DOGE is eight like Bitcoin's, ETC is
  // eighteen like Ethereum's, and crediting either at the other's scale is off by ten orders of
  // magnitude in the direction of giving money away.
  assert.equal(decimalsOf('doge'), 8)
  assert.equal(decimalsOf('etc'), 18)
})
