/**
 * Chain identity, and the two forms of every address.
 *
 * **Nothing in `@cloudsforge/contracts-chain` is redefined here.** Decimals, confirmation depths,
 * chain ids and the asset for a chain are read from that package and never restated, because the
 * whole reason it is exact-pinned is that `wallet`, `settlement`, `custody` and `indexer`
 * disagreeing about one of them is money credited at the wrong depth. What this file adds is the
 * wallet's own vocabulary: the URL-safe chain slug and, more importantly, the distinction between
 * the address a user is *shown* and the address a query *compares*.
 *
 * ## The two forms, which is the whole point of this file
 *
 * An EVM address has three valid spellings of the same account: all-lowercase, all-uppercase, and
 * the EIP-55 mixed case. Storing one and comparing against another is the defect
 * `repos/forge-pay/services/pay/src/routes/withdrawals.ts` carries a paragraph about: its two
 * "is this our own address" checks were equality against rows the keyvault had minted in EIP-55
 * form, so a user pasting *their own deposit address* in lowercase passed both checks and was
 * charged a network fee to move their money in a circle. The indexer has the mirror of the same
 * scar in `addressFrom`: it lower-cases before querying because "a deposit that is invisible
 * because of letter case is indistinguishable from a deposit that never arrived".
 *
 * So every address in this service is stored twice:
 *
 *   * `address` — the **display** form. EIP-55 for EVM and Ember. What a user is shown, what goes
 *     in an event, what is handed to settlement.
 *   * `address_key` — the **comparison** form. Lower-cased for EVM and Ember; byte-identical for
 *     the case-significant families. Every `where` clause uses this and only this.
 *
 * ## Validation refuses rather than guesses
 *
 * Each family gets the strongest structural check that exists for it — EIP-55 for EVM, base58check
 * for Bitcoin and XRP, bech32/bech32m for segwit, a length check for Solana, which has no checksum
 * by design. A family whose checksum is not implemented would have to be accepted on length alone,
 * and an address accepted on length alone is a withdrawal sent into the void. There is no such
 * family here.
 *
 * ## A FAMILY IS NOT A CHAIN, AND FOR THE BITCOIN FAMILY THAT DISTINCTION IS MONEY
 *
 * `familyOf('ltc')` is `'bitcoin'`, and it is right to be: Litecoin genuinely shares Bitcoin's
 * transaction structure, its script language and its address ENCODINGS. What it does not share is
 * the PARAMETERS those encodings are applied with — a different bech32 human-readable part and
 * different base58 version bytes — so a validator that switches on the family alone answers
 * Bitcoin's rules for Litecoin and accepts a `bc1…` address as a Litecoin withdrawal destination.
 *
 * That failure is silent in every way a failure can be. The address is well-formed, its checksum is
 * valid, nothing throws, the withdrawal is reserved, signed and broadcast — and the coins land in a
 * Litecoin output nobody holds the key to. It is the same defect custody found on the derivation
 * side (`custody/src/chains.ts`, `bitcoinNetwork`), one repository later and pointing outward
 * instead of inward.
 *
 * So `canonicaliseBitcoinFamily` takes the CHAIN, the parameters are a table keyed by chain, and an
 * unknown bitcoin-family chain THROWS rather than falling back to Bitcoin's. A default there is the
 * bug, not a convenience: the next Bitcoin-derived chain added to `ChainId` would silently accept
 * Bitcoin addresses under its own name and nothing would fail until somebody sent money.
 *
 * `doge` is that next chain, and it makes the point harder than Litecoin did. Litecoin shares the
 * ENCODINGS and differs only in the parameters; **Dogecoin does not have one of the encodings at
 * all.** `src/chainparams.cpp` declares no bech32 HRP on any network, so `doge1…` is not a Dogecoin
 * address in a form this service does not accept — it is not a Dogecoin address, and a validator
 * that answered the family's rules would accept a string no Dogecoin node can ever pay to. The
 * table below carries an explicitly empty `hrps` for it, which is why the branch is unreachable
 * rather than merely unused.
 */

import { createHash } from 'node:crypto'
import {
  type ChainFamily,
  type IssuableAssetCode,
  type Network,
  chainSpec,
} from '@cloudsforge/contracts-chain'
import { keccak256, toChecksumAddress } from '@cloudsforge/evm'

/**
 * The URL-safe slug for a chain. The asset code lowercased, which is also what the indexer's
 * `ChainId` is and what `txUrn` uses, so a path segment and a cross-service URN cannot drift.
 *
 * **DERIVED FROM THE ASSET UNION RATHER THAN RE-TYPED, WHICH IS THE DIFFERENCE BETWEEN A NEW ASSET
 * BEING A BUILD FAILURE AND A NEW ASSET BEING NOTHING AT ALL.**
 *
 * This was eight string literals until 2026-08-09. The literals were correct on the day they were
 * last edited and correct today, and that is exactly the problem with them: nothing connected them
 * to `AssetCode`, so the eight were right by somebody having remembered. `LTC` arrived, then `DOGE`
 * and `ETC` in one commit (micro-contracts 63a0bc4), and each time the repair here was a person
 * reading this file and typing. The ninth asset gets no such person.
 *
 * `Lowercase<IssuableAssetCode>` is the same set stated as a consequence. `AssetCode` gains a
 * member, this type gains its slug, and `ASSET_FOR_CHAIN` below — a TOTAL
 * `Readonly<Record<ChainId, …>>` — stops compiling until somebody says what the new chain is
 * called. `CHAIN_IDS`, `CHAIN_FOR_ASSET` and `CUSTODY_CHAIN` all hang off that one record, so
 * there is one place to edit and it is a place the compiler points at.
 *
 * `shard` is still absent, and now for a reason the type carries rather than a reason a comment
 * asserts: `IssuableAssetCode` is `Exclude<AssetCode, 'SHARD'>`. SHARD is in `CHAINS` only so that
 * record is total, it never exists on a chain, and a deposit address for it could only ever be a
 * lie.
 *
 * ONE ASSUMPTION, WORTH STATING BECAUSE IT IS NOT PERMANENT. "Issuable" and "has a chain" are two
 * different claims that currently coincide, because SHARD is both the only retired asset and the
 * only chainless one. Retiring an asset that HAS on-chain history would drop its slug out of this
 * type while its rows and its `chain` column still hold it — so on that day this derivation has to
 * change rather than be trusted. `addresses.test.ts` pins the coincidence, so the day it stops
 * being true is a red build rather than a surprise.
 */
export type ChainId = Lowercase<IssuableAssetCode>

/**
 * The asset a chain settles in.
 *
 * **The one place the correspondence is written down, and the reason it is a `Record<ChainId, …>`
 * rather than a lookup helper: totality.** A new member of `AssetCode` becomes a new member of
 * `ChainId` above and this object then fails to compile — `error TS2739`, naming the missing key.
 * That is the whole mechanism, and everything below is derived from it so there is no second list
 * to forget.
 */
const ASSET_FOR_CHAIN: Readonly<Record<ChainId, IssuableAssetCode>> = Object.freeze({
  ember: 'EMBER',
  eth: 'ETH',
  btc: 'BTC',
  sol: 'SOL',
  xrp: 'XRP',
  ltc: 'LTC',
  doge: 'DOGE',
  etc: 'ETC',
})

/**
 * Every chain slug, in the order `ASSET_FOR_CHAIN` declares them.
 *
 * Derived rather than repeated. The array this replaced held the same eight strings in the same
 * order, and a chain added to one and not the other would have been a chain that type-checks and
 * then fails `isChainId` at the edge of a route — a 400 on a chain the service genuinely supports.
 */
export const CHAIN_IDS: readonly ChainId[] = Object.freeze(
  Object.keys(ASSET_FOR_CHAIN) as ChainId[],
)

export function isChainId(value: string): value is ChainId {
  return (CHAIN_IDS as readonly string[]).includes(value)
}

export function isNetwork(value: string): value is Network {
  return value === 'mainnet' || value === 'testnet'
}

export function assetOf(chain: ChainId): IssuableAssetCode {
  return ASSET_FOR_CHAIN[chain]
}

/**
 * The chain an asset settles on, or `null`.
 *
 * `null` for SHARD, and that is not an oversight: Shards are a platform unit with no chain, so
 * asking for their deposit address must fail rather than fall through to a default.
 *
 * **THE SECOND TABLE IS GONE.** This read a `CHAIN_FOR_ASSET` typed
 * `Readonly<Partial<Record<AssetCode, ChainId>>>` — a hand-written inversion of `ASSET_FOR_CHAIN`,
 * with `Partial` switching off the only check that could have noticed a missing row. Two lists of
 * the same eight pairs, kept in step by whoever last edited them, and the one with `Partial` on it
 * was the one that failed quietly: an asset absent from it is not a type error, it is
 * `chainForAsset` returning null, which every caller reads as "this asset has no chain" — the
 * SHARD answer, given for an asset that has one. A deposit address request would have 400'd for a
 * chain this service fully supports, with the error text saying the asset is off-chain.
 *
 * It is now a fold of the slug rule stated in `ChainId`'s comment, checked against the derived
 * `CHAIN_IDS`, so it cannot be more or less complete than `ASSET_FOR_CHAIN` is. `'SHARD'`
 * lower-cases to `'shard'`, which is not a `ChainId`, so the SHARD answer stays exactly as it was
 * — by construction now rather than by omission.
 */
export function chainForAsset(assetCode: string): ChainId | null {
  const slug = assetCode.toLowerCase()
  return isChainId(slug) ? slug : null
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE CHAIN NAME CUSTODY STORES, WHICH IS NOT THIS SERVICE'S SLUG — AND THIS SERVICE WAS SENDING
 * THE SLUG.**
 *
 * Found while adding Litecoin, and it is **not a Litecoin defect**: it has been live for ETH, BTC
 * and SOL since deposit provisioning was built. Custody's `CHAIN_ASSET` is keyed by chain NAME —
 * `ethereum`, `bitcoin`, `litecoin`, `solana`, `xrp`, `ember` — because those are the values the
 * rows it adopted from forge-keyvault already carry, and `custody/src/server.ts` refuses
 * anything else with 400 `unknown_chain`. This service's slug is the asset code lowercased.
 *
 * The two agree on exactly two of six, `ember` and `xrp`, and disagree on the other four. So
 * `POST /v1/deposits` for ETH, BTC or SOL has been answering 400 from custody, and **every test
 * here missed it because `custodycontract.test.ts` only ever exercised `ember`** — the one slug
 * that happens to equal its own chain name. A contract test that pins one value pins one value.
 *
 * `settlement` has had the same table since it was written (`settlement/src/chains.ts`,
 * `CUSTODY_CHAIN`) with a comment explaining why it is a table rather than a `toLowerCase()`. This
 * service needed it and did not have it.
 *
 * The translation happens at the WIRE, in `httpCustodyClient`, and nowhere else. Everything on this
 * side of that boundary — the rows, the events, `custodyKeyUrn` — keeps this service's slug, so a
 * stored `chain` still means what every other query here assumes it means.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const CUSTODY_CHAIN: Readonly<Record<ChainId, string>> = Object.freeze({
  ember: 'ember',
  eth: 'ethereum',
  btc: 'bitcoin',
  sol: 'solana',
  xrp: 'xrp',
  ltc: 'litecoin',
  doge: 'dogecoin',
  // Hyphenated, and NOT `ethereumclassic` or `etc`. Custody's `CHAIN_ASSET` keys on the long name
  // and answers 400 `unknown_chain` to anything else, and the long name it chose is the one the
  // rest of the estate already spells this way — the chain datadir is `/data/chains/
  // ethereum-classic` and `pricing`'s CoinGecko id is `ethereum-classic`. Two of the eight entries
  // in this table now differ from the slug by more than a lengthening, which is the argument for a
  // table rather than a transformation restated.
  etc: 'ethereum-classic',
})

export function custodyChainOf(chain: ChainId): string {
  return CUSTODY_CHAIN[chain]
}

export function familyOf(chain: ChainId): ChainFamily {
  return chainSpec(assetOf(chain)).family
}

export function decimalsOf(chain: ChainId): number {
  return chainSpec(assetOf(chain)).decimals
}

export class AddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddressError'
  }
}

/** The two forms of one address, produced together so they can never be derived separately. */
export interface CanonicalAddress {
  /** The display form. EIP-55 for EVM and Ember. */
  readonly address: string
  /** The comparison form. Every `where` clause uses this. */
  readonly key: string
}

/**
 * Validate an address for a chain and produce both forms, or throw.
 *
 * Throws rather than returning null because every caller's correct response to an invalid address
 * is to refuse the request, and a nullable return invites the one caller that forgets to check.
 */
export function canonicaliseAddress(chain: ChainId, raw: string): CanonicalAddress {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new AddressError('address must not be empty')

  const family = familyOf(chain)
  switch (family) {
    case 'evm':
    case 'ember':
      return canonicaliseEvm(trimmed)
    case 'bitcoin':
      // THE CHAIN, not the family. See the header: `btc`, `ltc` and `doge` are all `'bitcoin'`
      // here and they accept disjoint sets of addresses on mainnet. `doge` is the case that makes
      // the distinction impossible to miss — it has no segwit at all, so the family's own bech32
      // branch is one it must never take.
      return canonicaliseBitcoinFamily(chain, trimmed)
    case 'xrp':
      return canonicaliseXrp(trimmed)
    case 'solana':
      return canonicaliseSolana(trimmed)
  }
}

/** Non-throwing form, for the places that only need a yes or no. */
export function isValidAddress(chain: ChainId, raw: string): boolean {
  try {
    canonicaliseAddress(chain, raw)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ EVM and Ember */

const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/

function canonicaliseEvm(raw: string): CanonicalAddress {
  if (!EVM_SHAPE.test(raw)) {
    throw new AddressError('address must be 0x followed by 40 hex characters')
  }
  const lower = raw.toLowerCase()
  const isAllOneCase = raw === lower || raw === `0x${raw.slice(2).toUpperCase()}`
  // A mixed-case address is *claiming* a checksum, so it is held to it. An all-lowercase or
  // all-uppercase address is not claiming one and is accepted — refusing it would reject the form
  // every block explorer's copy button used to produce, and the form the indexer stores.
  if (!isAllOneCase && toChecksumAddress(lower) !== raw) {
    throw new AddressError('address fails its EIP-55 checksum; check for a mistyped character')
  }
  return { address: toChecksumAddress(lower), key: lower }
}

/* ------------------------------------------------------------------ base58 */

const BITCOIN_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** XRP uses its own ordering of the same 58 characters. Decoding one with the other yields a
 * different payload that still passes a length check, which is why the alphabet is a parameter. */
const RIPPLE_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'

function base58Decode(input: string, alphabet: string): Uint8Array {
  let value = 0n
  const base = BigInt(alphabet.length)
  for (const character of input) {
    const digit = alphabet.indexOf(character)
    if (digit === -1) throw new AddressError('address contains a character outside its alphabet')
    value = value * base + BigInt(digit)
  }
  const hex = value.toString(16)
  // A value of zero must produce NO bytes here, not one. Every byte of an all-zero payload is a
  // leading zero and is restored below from the character count; letting `toString(16)` contribute
  // an extra `00` would make a 32-byte Solana key decode to 33 bytes and be refused.
  const body = value === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')
  // Leading zero bytes encode as leading alphabet[0] characters and are lost by the bigint, so
  // they are counted and put back. Losing them shortens the payload and breaks the checksum.
  let leadingZeros = 0
  for (const character of input) {
    if (character !== alphabet[0]) break
    leadingZeros += 1
  }
  return Uint8Array.from([...new Uint8Array(leadingZeros), ...body])
}

const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest()

/** Decode base58check and return the payload, or throw. The checksum is four bytes of SHA-256d. */
function base58CheckDecode(input: string, alphabet: string): Uint8Array {
  const decoded = base58Decode(input, alphabet)
  if (decoded.length < 5) throw new AddressError('address is too short to carry a checksum')
  const payload = decoded.slice(0, decoded.length - 4)
  const checksum = decoded.slice(decoded.length - 4)
  const expected = sha256(sha256(payload)).subarray(0, 4)
  if (!Buffer.from(checksum).equals(expected)) {
    throw new AddressError('address fails its base58 checksum; check for a mistyped character')
  }
  return payload
}

/* ------------------------------------------------------------------ Bitcoin */

const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values: readonly number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let checksum = 1
  for (const value of values) {
    const top = checksum >> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) checksum ^= generators[i]!
  }
  return checksum
}

function bech32Expand(prefix: string): number[] {
  const out: number[] = []
  for (const character of prefix) out.push(character.charCodeAt(0) >> 5)
  out.push(0)
  for (const character of prefix) out.push(character.charCodeAt(0) & 31)
  return out
}

/**
 * Verify a bech32 or bech32m address.
 *
 * Both constants are accepted because both are in use: witness version 0 (P2WPKH, P2WSH) uses
 * bech32's constant 1 and version 1 (Taproot) uses bech32m's 0x2bc830a3. Accepting only one would
 * reject every Taproot address, and accepting either without checking which the witness version
 * calls for would accept an address that a Bitcoin node will not.
 *
 * **THE CHECKSUM IS NOT THE ONLY GATE — SEE `assertPayableWitnessVersion`.** This function answers
 * "is this a well-formed segwit address of any version", which is a different question from "can
 * this estate pay it", and the two were being conflated.
 */
function verifyBech32(address: string): void {
  const lower = address.toLowerCase()
  if (address !== lower && address !== address.toUpperCase()) {
    throw new AddressError('a bech32 address must not mix upper and lower case')
  }
  const separator = lower.lastIndexOf('1')
  if (separator < 1 || separator + 7 > lower.length || lower.length > 90) {
    throw new AddressError('address is not a well-formed bech32 string')
  }
  const prefix = lower.slice(0, separator)
  const data: number[] = []
  for (const character of lower.slice(separator + 1)) {
    const index = BECH32_ALPHABET.indexOf(character)
    if (index === -1) throw new AddressError('address contains a character outside bech32')
    data.push(index)
  }
  const checksum = bech32Polymod([...bech32Expand(prefix), ...data])
  const witnessVersion = data[0]
  const expected = witnessVersion === 0 ? 1 : 0x2bc830a3
  if (checksum !== expected) {
    throw new AddressError('address fails its bech32 checksum; check for a mistyped character')
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE BITCOIN-FAMILY NETWORK PARAMETERS. A WRONG ENTRY HERE ACCEPTS AN ADDRESS ON THE WRONG
 * CHAIN, AND A WITHDRAWAL TO AN ADDRESS ON THE WRONG CHAIN IS GONE.**
 *
 * Every value is from the chain's own `src/chainparams.cpp` and each is commented with the address
 * it produces, so a reader checks it against an address rather than against a memory. They are the
 * same values custody derives under (`custody/src/chains.ts`, `LITECOIN_MAINNET`) and the same
 * values settlement builds under, and they have to be: an address this service accepts and
 * settlement cannot build a payment to is a withdrawal that reserves a user's money and then fails.
 *
 * ── WHAT THIS TABLE DELIBERATELY OMITS, AND WHY ───────────────────────────────────────────────
 *
 * **Litecoin's `SCRIPT_ADDRESS` of 5 is not here, only `SCRIPT_ADDRESS2` of 50.** Litecoin Core
 * has two P2SH prefixes: `key_io.cpp` DECODES both 5 (`3…`, byte-identical to Bitcoin's) and 50
 * (`M…`), and ENCODES only 50. Accepting 5 would mean accepting a string that is simultaneously a
 * valid Bitcoin mainnet P2SH address and a valid Litecoin one, with nothing in it to say which was
 * meant — so a user pasting a Bitcoin address into the Litecoin field would be told it is fine.
 * Refusing it costs the small number of users still holding pre-`M` Litecoin P2SH addresses a
 * visible error they can act on. That is the safe direction, and it is also the only direction the
 * rest of the estate can honour: bitcoinjs-lib's Litecoin parameters carry `scriptHash: 0x32`, so
 * settlement's `toOutputScript` refuses a `3…` address outright and a withdrawal accepted here
 * would die at build time with the money already reserved.
 *
 * ── THE ONE COLLISION THAT IS REAL AND CANNOT BE CLOSED ───────────────────────────────────────
 *
 * **On TESTNET, Bitcoin and Litecoin share `PUBKEY_ADDRESS` = 111.** A `m…`/`n…` legacy testnet
 * address is byte-for-byte both chains' and no validator anywhere can tell them apart — that is a
 * property of the chains, not of this code, and pretending otherwise would be inventing evidence.
 * It does not exist on mainnet, where Bitcoin's 0 and Litecoin's 48 are disjoint, and the estate's
 * testnet carries no value. `addresses.test.ts` asserts the collision explicitly rather than
 * leaving it to be discovered, because a reader comparing this table against Core will notice the
 * repeat and needs to know it is deliberate.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
interface BitcoinFamilyParams {
  /** Lower-cased bech32 human-readable parts, every network. The HRP is inside the checksum. */
  readonly hrps: readonly string[]
  /** Accepted base58check version bytes, every network. */
  readonly versions: readonly number[]
}

const BITCOIN_FAMILY_PARAMS: Readonly<Record<string, BitcoinFamilyParams>> = Object.freeze({
  btc: Object.freeze({
    /** `bc1…` mainnet, `tb1…` testnet and signet, `bcrt1…` regtest. */
    hrps: Object.freeze(['bc', 'tb', 'bcrt']),
    /** 0 → `1…`; 5 → `3…`; 111 → `m…`/`n…` testnet; 196 → `2…` testnet. */
    versions: Object.freeze([0x00, 0x05, 0x6f, 0xc4]),
  }),
  ltc: Object.freeze({
    /** `ltc1…` mainnet, `tltc1…` testnet, `rltc1…` regtest. NOT `bc1`, which is the whole point. */
    hrps: Object.freeze(['ltc', 'tltc', 'rltc']),
    /** 48 → `L…`; 50 → `M…` (SCRIPT_ADDRESS2, the one Core encodes); 111 and 58 → testnet. */
    versions: Object.freeze([0x30, 0x32, 0x6f, 0x3a]),
  }),
  doge: Object.freeze({
    /**
     * **EMPTY, AND THAT IS THE ENTRY — DOGECOIN HAS NO BECH32 AND NO SEGWIT.**
     *
     * `dogecoin/dogecoin`, `src/chainparams.cpp`, read at `master` on 2026-08-09, contains no
     * `bech32_hrp` line at all — not for main, not for test, not for regtest. There is nothing to
     * put here, and the absence has to be written down because an empty array is otherwise
     * indistinguishable from an unfinished one.
     *
     * The consequence is not cosmetic. `contracts-chain`'s DOGE spec makes the same point from the
     * other side: a consumer that derives an HRP by pattern-matching LTC's `ltc1` against BTC's
     * `bc1` produces `doge1…` strings that no Dogecoin node will ever pay to. With no HRP in this
     * array, `canonicaliseBitcoinFamily` never takes its bech32 branch for `doge`, so a segwit-
     * shaped string cannot be accepted here whatever its checksum says, and a `bc1…` or `ltc1…`
     * pasted into a Dogecoin withdrawal is named as the other chain's by `HRP_OWNER` rather than
     * failing as a bad base58 payload.
     */
    hrps: Object.freeze([]),
    /**
     * From the same file. 30 (`0x1e`) → `D…`; 22 (`0x16`) → `9…`/`A…`; 113 (`0x71`) → `n…` testnet;
     * 196 (`0xc4`) → `2…` testnet. Each is quoted against a vector in `addresses.test.ts` taken
     * from Dogecoin Core's own `src/test/data/base58_keys_valid.json`, and they are the same four
     * bytes custody derives and signs under (`custody/src/chains.ts`, `DOGECOIN_MAINNET`).
     *
     * **THERE IS NO SECOND P2SH PREFIX TO CHOOSE BETWEEN**, unlike Litecoin, whose 5-versus-50 pair
     * is the paragraph above. Dogecoin has one `SCRIPT_ADDRESS` per network and Core both encodes
     * and decodes it, so admitting 22 costs nothing and refusing it would refuse an address Core
     * itself prints.
     *
     * On MAINNET all four of these are disjoint from Bitcoin's and Litecoin's, so the wrong-chain
     * paste that costs money is caught. On TESTNET, 196 is shared with Bitcoin — the same shape of
     * unclosable collision as Litecoin's 111 one paragraph up, asserted rather than hidden in
     * `addresses.test.ts` for the same reason, and confined to a network that carries no value.
     */
    versions: Object.freeze([0x1e, 0x16, 0x71, 0xc4]),
  }),
})

/** Every bitcoin-family HRP in the table, so a wrong-chain address is named rather than guessed. */
const HRP_OWNER: ReadonlyMap<string, string> = new Map(
  Object.entries(BITCOIN_FAMILY_PARAMS).flatMap(([chain, params]) =>
    params.hrps.map((hrp) => [hrp, chain] as const),
  ),
)

/**
 * The parameters for a bitcoin-family chain, or throw.
 *
 * **It throws for an unknown chain rather than defaulting to Bitcoin's**, which is the entire
 * lesson of this file. A default is not a convenience here, it is the defect: the next
 * Bitcoin-derived chain added to `ChainId` would silently accept `bc1…` addresses under its own
 * name, every test would stay green, and the first evidence would be a user's missing coins.
 */
export function bitcoinFamilyParams(chain: ChainId): BitcoinFamilyParams {
  const params = BITCOIN_FAMILY_PARAMS[chain]
  if (!params) {
    throw new AddressError(
      `no bitcoin-family address parameters are defined for '${chain}' — refusing to validate it ` +
        "with another chain's, which would accept a valid address on the wrong chain",
    )
  }
  return params
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ESTATE CANNOT PAY A TAPROOT ADDRESS ON ANY BITCOIN-FAMILY CHAIN, SO THIS SERVICE MUST NOT
 * ACCEPT ONE. THAT WAS ALREADY TRUE FOR BITCOIN AND NOBODY HAD NOTICED.**
 *
 * This was found while adding Litecoin and is NOT a Litecoin defect — it is a live Bitcoin one that
 * adding Litecoin would have duplicated. `settlement` decodes a destination with
 * `bitcoinjs-lib@6.1.7`'s `address.toOutputScript`, and for witness version 1 that goes through the
 * `p2tr` payment, which throws `No ECC Library provided. You must call initEccLib()`. Nothing in
 * this estate calls `initEccLib` — not settlement, which has no secp256k1 package at all, and not
 * custody, which has one and never initialises it. So a `bc1p…` destination fails to decode in the
 * service that builds the transaction AND in the service that signs it.
 *
 * Before this check, the sequence for a user withdrawing to a Taproot address was: accepted here,
 * balance RESERVED through the ledger, row queued, and only then an `AddressError` at build — a
 * reservation to unwind for an address that was never payable. Refusing at request time costs the
 * user an immediate, explicable error and costs the estate nothing.
 *
 * **THE FIX IS DELIBERATELY THE REFUSAL AND NOT `initEccLib`.** Making Taproot payable means adding
 * a native secp256k1 binding to settlement's runtime image and initialising it in custody as well,
 * in the two services that build and sign money movements, to gain a destination FORM rather than a
 * chain. That is a change to a signing path this service does not own the far side of, and the rule
 * is to stop at the seam rather than half-wire it. Witness versions 2 and above are refused by the
 * same clause and for a stronger reason: no chain here has activated one, so an address claiming
 * one cannot be paid by anybody.
 *
 * Deposits are unaffected. Custody derives P2WPKH — witness version 0 — so every address this
 * estate MINTS is payable; this bounds only where a user may withdraw TO.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function assertPayableWitnessVersion(address: string): void {
  const lower = address.toLowerCase()
  const data = lower.slice(lower.lastIndexOf('1') + 1)
  const version = BECH32_ALPHABET.indexOf(data[0] ?? '')
  if (version !== 0) {
    throw new AddressError(
      `this is a witness version ${version} address, and this platform can only pay version 0 ` +
        '(addresses whose data part begins `q`, such as `bc1q…` and `ltc1q…`). Taproot and later ' +
        'output types are not payable here yet. Withdraw to a version 0 or a legacy address.',
    )
  }
}

function canonicaliseBitcoinFamily(chain: ChainId, raw: string): CanonicalAddress {
  const params = bitcoinFamilyParams(chain)

  // The HRP is everything before the LAST '1', because '1' is not in the bech32 data alphabet but
  // may appear in the HRP itself. Same rule as `verifyBech32`, which re-derives it independently.
  const separator = raw.lastIndexOf('1')
  const hrp = separator > 0 ? raw.slice(0, separator).toLowerCase() : ''
  if (params.hrps.includes(hrp)) {
    // The checksum COMMITS TO THE HRP — `bech32Expand(prefix)` feeds it into the polymod — so this
    // is not a prefix comparison dressed up as one: the same data part under another HRP fails the
    // checksum outright. `addresses.test.ts` proves that with BIP-173's own published vector.
    verifyBech32(raw)
    assertPayableWitnessVersion(raw)
    // Bech32 is defined lowercase; the uppercase form exists only for QR density. Storing the
    // lowercase form for both is what makes the two spellings one address.
    const lower = raw.toLowerCase()
    return { address: lower, key: lower }
  }
  const foreign = HRP_OWNER.get(hrp)
  if (foreign) {
    // A well-formed address on a DIFFERENT chain of this family, which is the one mistake here
    // that costs money rather than a retry. Named explicitly, because "invalid address" would send
    // a user looking for a typo in a string that has none.
    throw new AddressError(
      `${hrp}1… is a ${foreign.toUpperCase()} address and this is a ${chain.toUpperCase()} ` +
        'withdrawal. Sending it there would put the coins in an output nobody can spend.',
    )
  }

  const payload = base58CheckDecode(raw, BITCOIN_ALPHABET)
  // One version byte plus a 20-byte hash. Anything else decoded cleanly but is not an address.
  if (payload.length !== 21) throw new AddressError('address is not a 21-byte base58check payload')
  const version = payload[0]!
  if (!params.versions.includes(version)) {
    // The base58 checksum passed, so the string is a real address — of some other chain. This is
    // the branch that stops a `1…` Bitcoin address being accepted as a Litecoin destination, and
    // it is a check the previous version of this function did not make AT ALL: it accepted any
    // 21-byte payload whatever its version byte, so every Bitcoin address was a valid `btc`
    // address and would have been a valid `ltc` one the moment `ltc` existed.
    throw new AddressError(
      `this address carries version byte ${version}, which is not one ${chain.toUpperCase()} ` +
        'uses. It is a valid address on another chain, and money sent to it here is lost.',
    )
  }
  return { address: raw, key: raw }
}

/* ------------------------------------------------------------------ XRP */

function canonicaliseXrp(raw: string): CanonicalAddress {
  if (!raw.startsWith('r')) throw new AddressError('an XRP account address begins with r')
  const payload = base58CheckDecode(raw, RIPPLE_ALPHABET)
  if (payload.length !== 21 || payload[0] !== 0x00) {
    throw new AddressError('address is not an XRP account id')
  }
  return { address: raw, key: raw }
}

/* ------------------------------------------------------------------ Solana */

function canonicaliseSolana(raw: string): CanonicalAddress {
  if (raw.length < 32 || raw.length > 44) {
    throw new AddressError('address is not a plausible length for a Solana public key')
  }
  const decoded = base58Decode(raw, BITCOIN_ALPHABET)
  // An Ed25519 public key, exactly. Solana addresses carry no checksum at all — the key IS the
  // address — so this is the strongest check that exists, and it is stated rather than hidden
  // because it is weaker than the others on this page.
  if (decoded.length !== 32) throw new AddressError('address is not a 32-byte Solana public key')
  return { address: raw, key: raw }
}

/**
 * EIP-55 checksum encoding, from `@cloudsforge/evm`.
 *
 * Re-exported so callers keep importing it from here. The implementation moved out
 * because five services held a byte-identical copy, and a checksum computed two ways
 * is a withdrawal refused for an address copied out of our own UI.
 */
export { toChecksumAddress }
