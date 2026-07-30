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
 */

import { createHash } from 'node:crypto'
import {
  type AssetCode,
  type ChainFamily,
  type Network,
  chainSpec,
} from '@cloudsforge/contracts-chain'
import { keccak256 } from './keccak.ts'

/**
 * The URL-safe slug for a chain. The asset code lowercased, which is also what the indexer's
 * `ChainId` is and what `txUrn` uses, so a path segment and a cross-service URN cannot drift.
 *
 * `shard` is deliberately absent: SHARD is in `CHAINS` only so that record is total, it never
 * exists on a chain, and a deposit address for it could only ever be a lie.
 */
export type ChainId = 'ember' | 'eth' | 'btc' | 'sol' | 'xrp'

export const CHAIN_IDS: readonly ChainId[] = Object.freeze(['ember', 'eth', 'btc', 'sol', 'xrp'])

const ASSET_FOR_CHAIN: Readonly<Record<ChainId, AssetCode>> = Object.freeze({
  ember: 'EMBER',
  eth: 'ETH',
  btc: 'BTC',
  sol: 'SOL',
  xrp: 'XRP',
})

const CHAIN_FOR_ASSET: Readonly<Partial<Record<AssetCode, ChainId>>> = Object.freeze({
  EMBER: 'ember',
  ETH: 'eth',
  BTC: 'btc',
  SOL: 'sol',
  XRP: 'xrp',
})

export function isChainId(value: string): value is ChainId {
  return (CHAIN_IDS as readonly string[]).includes(value)
}

export function isNetwork(value: string): value is Network {
  return value === 'mainnet' || value === 'testnet'
}

export function assetOf(chain: ChainId): AssetCode {
  return ASSET_FOR_CHAIN[chain]
}

/**
 * The chain an asset settles on, or `null`.
 *
 * `null` for SHARD, and that is not an oversight: Shards are a platform unit with no chain, so
 * asking for their deposit address must fail rather than fall through to a default.
 */
export function chainForAsset(assetCode: string): ChainId | null {
  return CHAIN_FOR_ASSET[assetCode as AssetCode] ?? null
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
      return canonicaliseBitcoin(trimmed)
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

/**
 * EIP-55 checksum encoding.
 *
 * The hex digits of the lower-cased address are upper-cased where the corresponding nibble of
 * `keccak256(lowercase address without 0x)` is 8 or above. That is the entire specification, and
 * it is the only typo protection a 20-byte EVM address has.
 */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '')
  const hash = Buffer.from(keccak256(Buffer.from(lower, 'ascii'))).toString('hex')
  let out = '0x'
  for (let i = 0; i < lower.length; i++) {
    const character = lower[i]!
    // Digits have no case, so only letters are touched. Upper-casing a digit is a no-op that
    // would still make the string differ from what every wallet displays.
    out += Number.parseInt(hash[i]!, 16) >= 8 ? character.toUpperCase() : character
  }
  return out
}

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

function canonicaliseBitcoin(raw: string): CanonicalAddress {
  if (/^(bc1|tb1|bcrt1)/i.test(raw)) {
    verifyBech32(raw)
    // Bech32 is defined lowercase; the uppercase form exists only for QR density. Storing the
    // lowercase form for both is what makes the two spellings one address.
    const lower = raw.toLowerCase()
    return { address: lower, key: lower }
  }
  const payload = base58CheckDecode(raw, BITCOIN_ALPHABET)
  // One version byte plus a 20-byte hash. Anything else decoded cleanly but is not an address.
  if (payload.length !== 21) throw new AddressError('address is not a 21-byte base58check payload')
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
