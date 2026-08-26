/**
 * EIP-4361 — "Sign-In with Ethereum" — as this service issues and verifies it.
 *
 * This is the mechanism by which a user proves they hold the key to an address the platform does
 * not custody. Getting it wrong does not produce an error; it produces a link that says "this
 * address is yours" when it is somebody else's, and 04-domain-model §3.2 then lets that address be
 * a withdrawal destination and an ownership proof.
 *
 * ## The message is built here and stored, never rebuilt at verification time
 *
 * `link_challenges.message` holds the exact string the user was asked to sign. Rebuilding it at
 * verification from the fields would give the issuer and the verifier each their own opinion of
 * the message, and any difference between them — a trailing newline, a re-serialised timestamp —
 * is a signature that verifies against a message the user never saw. So: build once, store, and
 * verify against the stored bytes.
 *
 * ## The four checks that make a signature mean something
 *
 * A recovered address on its own means "somebody signed something". These are what narrow it to
 * "this person, for us, once, now":
 *
 *   1. **The recovered address equals the address being linked.** Compared in the lower-cased
 *      form, because an EVM address has three spellings and comparing display forms is the defect
 *      forge-pay's withdrawal route documents.
 *   2. **`domain` is ours.** It comes from configuration, never from the request. A signature
 *      collected by `wallet.cloudsforge.evil` is a signature whose message says
 *      `wallet.cloudsforge.evil`, and this is the check that notices. `siwe.test.ts` asserts a
 *      wrong-domain signature is refused even though it is cryptographically perfect.
 *   3. **The nonce is single-use.** Enforced in `links.ts` by an UPDATE that requires
 *      `consumed_at is null`, so two concurrent replays cannot both win. A nonce checked with a
 *      SELECT and then marked would let both through.
 *   4. **The message has not expired**, and is not from the future by more than a small clock
 *      allowance.
 *
 * ## Ember
 *
 * Hearth is an account-model EVM chain, so its wallets speak `personal_sign` and EIP-4361
 * unchanged; only the Chain ID differs (7411 mainnet, 7412 testnet, from `contracts-chain`). The
 * literal "wants you to sign in with your Ethereum account" is kept verbatim even for Ember,
 * because it is fixed by the EIP's ABNF and every wallet that renders a SIWE message specially —
 * rather than as a wall of hex — matches on it. A friendlier wording would degrade the exact
 * safety property the format exists to provide.
 */

import { chainSpec, type Network } from '@cloudsforge/contracts-chain'
import { assetOf, familyOf, toChecksumAddress, type ChainId } from './addresses.ts'
import { keccak256 } from '@cloudsforge/evm'
import { recoverAddress } from './secp256k1.ts'

/** 04-domain-model §3.2. The closed set of verification schemes. */
export const LINK_SCHEMES = Object.freeze([
  'eip4361',
  'solana_signmessage',
  'bip322',
  'xrp_signed_memo',
] as const)

export type LinkScheme = (typeof LINK_SCHEMES)[number]

export function isLinkScheme(value: string): value is LinkScheme {
  return (LINK_SCHEMES as readonly string[]).includes(value)
}

/**
 * The scheme a chain's signatures use.
 *
 * A mapping rather than a caller-supplied field: letting a request name the scheme would let it
 * ask for `eip4361` on a Solana address, and the verifier would then recover an EVM address that
 * can never match and refuse for the wrong reason.
 */
export function schemeForChain(chain: ChainId): LinkScheme {
  const family = familyOf(chain)
  switch (family) {
    case 'evm':
    case 'ember':
      return 'eip4361'
    case 'solana':
      return 'solana_signmessage'
    case 'bitcoin':
      return 'bip322'
    case 'xrp':
      return 'xrp_signed_memo'
  }
}

/**
 * Schemes this build actually verifies. Everything else is `501`, never faked.
 *
 * A scheme that is declared but unimplemented must refuse loudly. The alternative — accepting the
 * signature without checking it, or checking it with a placeholder that always passes — is a link
 * that claims a cryptographic proof it does not have, and every authorisation granted on it
 * inherits the lie.
 */
export const IMPLEMENTED_SCHEMES: ReadonlySet<LinkScheme> = new Set<LinkScheme>(['eip4361'])

export class SiweError extends Error {
  /** A short machine code, so the HTTP layer maps a reason without matching on prose. */
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SiweError'
    this.code = code
  }
}

export interface SiweFields {
  readonly domain: string
  /** EIP-55 checksummed, as the EIP requires. */
  readonly address: string
  readonly statement?: string
  readonly uri: string
  readonly version: '1'
  readonly chainId: number
  readonly nonce: string
  readonly issuedAt: string
  readonly expirationTime?: string
}

const HEADER_SUFFIX = ' wants you to sign in with your Ethereum account:'

/**
 * Build the message, exactly as EIP-4361 §Message Format specifies it.
 *
 * The blank-line placement is not cosmetic: with a statement the layout is
 * `header / address / blank / statement / blank / fields`, and without one it is
 * `header / address / blank / fields`. A wallet that parses the message to render it nicely will
 * fall back to raw hex if the layout is off by one line, and a user who is shown raw hex is a user
 * who cannot tell a login from a token approval.
 */
export function buildSiweMessage(fields: SiweFields): string {
  const lines: string[] = [
    `${fields.domain}${HEADER_SUFFIX}`,
    fields.address,
    '',
  ]
  if (fields.statement !== undefined && fields.statement.length > 0) {
    lines.push(fields.statement, '')
  }
  lines.push(
    `URI: ${fields.uri}`,
    `Version: ${fields.version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  )
  if (fields.expirationTime !== undefined) {
    lines.push(`Expiration Time: ${fields.expirationTime}`)
  }
  return lines.join('\n')
}

/**
 * Parse a message back into its fields.
 *
 * Strict on purpose. A lenient parser is how a message with two `Nonce:` lines gets read as having
 * the first and verified as having the second — the classic parser-differential, and on this path
 * it is a replay.
 */
export function parseSiweMessage(text: string): SiweFields {
  const lines = text.split('\n')
  const header = lines[0] ?? ''
  if (!header.endsWith(HEADER_SUFFIX)) {
    throw new SiweError('malformed_message', 'the message is not an EIP-4361 message')
  }
  const domain = header.slice(0, header.length - HEADER_SUFFIX.length)
  const address = lines[1] ?? ''
  if (domain.length === 0) throw new SiweError('malformed_message', 'the message names no domain')
  if (lines[2] !== '') {
    throw new SiweError('malformed_message', 'the address must be followed by a blank line')
  }

  // Everything from the first `URI:` line onward is the field block. The statement, if there is
  // one, is what sits between the blank line and it.
  const fieldStart = lines.findIndex((line, index) => index > 2 && line.startsWith('URI: '))
  if (fieldStart === -1) throw new SiweError('malformed_message', 'the message has no URI field')

  let statement: string | undefined
  if (fieldStart > 3) {
    const between = lines.slice(3, fieldStart)
    if (between[between.length - 1] !== '') {
      throw new SiweError('malformed_message', 'the statement must be followed by a blank line')
    }
    statement = between.slice(0, -1).join('\n')
  }

  const fields = new Map<string, string>()
  for (const line of lines.slice(fieldStart)) {
    const separator = line.indexOf(': ')
    if (separator === -1) {
      throw new SiweError('malformed_message', `unparseable line in the field block: ${line}`)
    }
    const name = line.slice(0, separator)
    // A repeated field is refused rather than resolved. Either answer would be a guess about
    // which one the user believed they were signing.
    if (fields.has(name)) {
      throw new SiweError('malformed_message', `the field ${name} appears more than once`)
    }
    fields.set(name, line.slice(separator + 2))
  }

  const version = fields.get('Version')
  if (version !== '1') {
    throw new SiweError('unsupported_version', `unsupported EIP-4361 version: ${version ?? 'absent'}`)
  }
  const chainId = Number(fields.get('Chain ID'))
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new SiweError('malformed_message', 'Chain ID must be a positive integer')
  }

  const uri = required(fields, 'URI')
  const nonce = required(fields, 'Nonce')
  const issuedAt = required(fields, 'Issued At')
  const expirationTime = fields.get('Expiration Time')

  return {
    domain,
    address,
    ...(statement !== undefined ? { statement } : {}),
    uri,
    version: '1',
    chainId,
    nonce,
    issuedAt,
    ...(expirationTime !== undefined ? { expirationTime } : {}),
  }
}

function required(fields: ReadonlyMap<string, string>, name: string): string {
  const value = fields.get(name)
  if (value === undefined || value.length === 0) {
    throw new SiweError('malformed_message', `the message has no ${name} field`)
  }
  return value
}

/**
 * The EIP-191 `personal_sign` digest.
 *
 * `keccak256("\x19Ethereum Signed Message:\n" + byteLength + message)`. The length is the length
 * in **bytes**, not characters: a message containing anything outside ASCII would otherwise be
 * prefixed with a length no wallet agrees with, and the recovered address would be a stable,
 * plausible, wrong one.
 */
export function personalSignDigest(message: string): Uint8Array {
  const body = Buffer.from(message, 'utf8')
  const prefix = Buffer.from(`Ethereum Signed Message:\n${body.length}`, 'utf8')
  return keccak256(Buffer.concat([prefix, body]))
}

/** The chain id an EIP-4361 message must carry for a chain and network. Read, never restated. */
export function expectedChainId(chain: ChainId, network: Network): number {
  const declared = chainSpec(assetOf(chain)).chainId?.[network]
  if (declared === undefined) {
    throw new SiweError('unsupported_chain', `${chain} publishes no chain id and cannot use EIP-4361`)
  }
  return declared
}

export interface VerifyInput {
  /** The stored message, byte for byte as it was issued. */
  readonly message: string
  /** 65 bytes of hex: r, s, v. */
  readonly signature: string
  /** The address being linked, in any spelling. */
  readonly address: string
  /** From configuration. Never from the request — see the header. */
  readonly expectedDomain: string
  readonly expectedUri: string
  readonly expectedNonce: string
  readonly expectedChainId: number
  readonly now: Date
  /** How much clock skew between us and the signer is tolerated. */
  readonly clockSkewMs?: number
}

/**
 * Verify a signature over a stored challenge, or throw.
 *
 * Returns nothing on success: there is no useful value to hand back, and returning a boolean would
 * make an unchecked call site look like a successful verification.
 */
export function verifySiwe(input: VerifyInput): void {
  const fields = parseSiweMessage(input.message)
  const skew = input.clockSkewMs ?? 60_000

  if (fields.domain !== input.expectedDomain) {
    // The check that stops a signature collected by a phishing site being replayed here.
    throw new SiweError(
      'wrong_domain',
      `the message was signed for ${fields.domain}, not for ${input.expectedDomain}`,
    )
  }
  if (fields.uri !== input.expectedUri) {
    throw new SiweError('wrong_uri', 'the message URI is not this service')
  }
  if (fields.nonce !== input.expectedNonce) {
    throw new SiweError('wrong_nonce', 'the message nonce is not the one that was issued')
  }
  if (fields.chainId !== input.expectedChainId) {
    // A signature for one chain replayed on another is the XRP network-collision defect in a
    // different family, and the chain id field exists precisely to make it detectable.
    throw new SiweError(
      'wrong_chain',
      `the message names chain ${fields.chainId}, not ${input.expectedChainId}`,
    )
  }

  const issuedAt = Date.parse(fields.issuedAt)
  if (Number.isNaN(issuedAt)) throw new SiweError('malformed_message', 'Issued At is not a timestamp')
  if (issuedAt - skew > input.now.getTime()) {
    throw new SiweError('not_yet_valid', 'the message is issued in the future')
  }
  if (fields.expirationTime !== undefined) {
    const expiresAt = Date.parse(fields.expirationTime)
    if (Number.isNaN(expiresAt)) {
      throw new SiweError('malformed_message', 'Expiration Time is not a timestamp')
    }
    if (expiresAt + skew <= input.now.getTime()) {
      throw new SiweError('expired', 'the challenge has expired; request a new one')
    }
  }

  // The address in the message must be the address being linked, before the signature is even
  // looked at: a valid signature over a message naming somebody else's address proves only that
  // the signer can sign, not that they hold the address in question.
  const claimed = fields.address.toLowerCase()
  if (claimed !== input.address.toLowerCase()) {
    throw new SiweError('wrong_address', 'the message names a different address')
  }
  if (toChecksumAddress(claimed) !== fields.address && fields.address !== claimed) {
    throw new SiweError('malformed_message', 'the address in the message is not EIP-55 encoded')
  }

  const recovered = recoverAddress(personalSignDigest(input.message), input.signature)
  if (recovered !== claimed) {
    throw new SiweError('bad_signature', 'the signature was not produced by that address')
  }
}
