/**
 * External wallet links — 04-domain-model §3.2.
 *
 * A link is the platform's record that a user proved they hold the key to an address the platform
 * does not custody, plus the closed set of things that proof is allowed to authorise.
 *
 * ## The invariant this file exists to enforce
 *
 * §3.2: "An unverified (`watch`) address may only contribute to portfolio display. It can never be
 * a withdrawal destination or an ownership proof."
 *
 * That is one sentence and it is the reason the authorisation check is a **single function**,
 * `authorisationHolds`, that every caller goes through. The tempting alternative — each caller
 * asking "is this wallet the user's?" and answering from the `wallets` row — is wrong in a way
 * that is invisible in review: a `watch` wallet *is* the user's row, in their account, with their
 * label on it, and the only thing separating it from a wallet they can be paid at is a signature
 * that was never produced. `withdrawals.test.ts` asserts the refusal directly.
 *
 * ## Why the challenge is a row and the nonce is claimed by an UPDATE
 *
 * A nonce column on the link can only hold the latest challenge, so a signature over a previous
 * one is indistinguishable from a fresh signature the moment the column moves on. A row per
 * challenge, consumed by `update … where consumed_at is null returning`, makes a replay a refusal
 * that two concurrent requests cannot both win: exactly one UPDATE returns a row.
 *
 * The nonce is consumed **whether or not the signature verifies**. A challenge that survives a
 * failed attempt is an oracle: an attacker with a candidate signature can grind against it. One
 * challenge, one attempt, and a fresh challenge is a cheap call away.
 *
 * ## Schemes that are not implemented return 501 rather than pretending
 *
 * Solana `signMessage`, BIP-322 and XRP signed memos have their shapes defined — the scheme names
 * are in the check constraint, `schemeForChain` maps to them, the challenge is issued in the same
 * table — and `IMPLEMENTED_SCHEMES` refuses to verify them. Faking a verification would mint a
 * link that claims a cryptographic proof it does not have, and every authorisation granted on that
 * link would inherit the lie.
 */

import { randomBytes } from 'node:crypto'
import type { Network } from '@cloudsforge/contracts-chain'
import { canonicaliseAddress, type ChainId } from './addresses.ts'
import { SignatureError } from './secp256k1.ts'
import { WALLET_LINK_REVOKED, WALLET_LINK_VERIFIED, writeEvent, type Db, type Tx } from './outbox.ts'
import {
  IMPLEMENTED_SCHEMES,
  SiweError,
  buildSiweMessage,
  expectedChainId,
  schemeForChain,
  verifySiwe,
  type LinkScheme,
} from './siwe.ts'
import { insertWallet, transitionWallet, type WalletRecord } from './wallets.ts'

/** 04-domain-model §3.2. The closed set of what a verified external wallet may do. */
export const AUTHORISATIONS = Object.freeze([
  'withdrawal_destination',
  'token_owner',
  'community_membership',
  'governance_vote',
  'market_settlement',
] as const)

export type Authorisation = (typeof AUTHORISATIONS)[number]

export function isAuthorisation(value: string): value is Authorisation {
  return (AUTHORISATIONS as readonly string[]).includes(value)
}

export class LinkError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'LinkError'
    this.code = code
    this.status = status
  }
}

/** The scheme is a real scheme in the model and this build cannot verify it. 501, never a fake. */
export class SchemeNotImplementedError extends LinkError {
  constructor(scheme: LinkScheme) {
    super(
      'scheme_not_implemented',
      `${scheme} challenges are issued but this build cannot verify them; no link is created`,
      501,
    )
  }
}

export interface LinkRecord {
  readonly walletId: string
  readonly userId: string
  readonly scheme: LinkScheme
  readonly verifiedAt: string | null
  readonly revokedAt: string | null
  /** The live set. Revoked grants are absent, which is why this is computed and not stored. */
  readonly authorisations: readonly Authorisation[]
}

interface LinkRow {
  readonly wallet_id: string
  readonly user_id: string
  readonly scheme: string
  readonly verified_at: Date | null
  readonly revoked_at: Date | null
}

/* ------------------------------------------------------------------ challenge */

export interface ChallengeInput {
  readonly userId: string
  readonly chain: ChainId
  readonly network: Network
  readonly address: string
  readonly label?: string | null
  /** `external` for a link the user will sign for; `watch` for display only. */
  readonly origin: 'external' | 'watch'
  readonly domain: string
  readonly uri: string
  readonly ttlSeconds: number
  readonly statement?: string
  readonly correlationId: string
  readonly now?: Date
}

export interface Challenge {
  readonly walletId: string
  readonly scheme: LinkScheme
  readonly nonce: string
  /** The exact bytes to sign. Presented to the user and stored verbatim. */
  readonly message: string
  readonly expiresAt: string
}

/**
 * The nonce.
 *
 * 128 bits from the CSPRNG, hex. EIP-4361 requires at least 8 alphanumeric characters; 32 is well
 * past the point at which guessing one is a strategy, and the cost of a longer nonce is a longer
 * line in a message the user is going to read once.
 */
function newNonce(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Register an external or watch address and, for `external`, issue a challenge for it.
 *
 * A `watch` address gets a wallet row and no challenge: there is nothing to prove, and that is
 * exactly why it can never be a withdrawal destination. It goes straight to `active`, because a
 * watch wallet has no provisioning to wait for — the "activeness" of a watch wallet means only
 * that it is being displayed.
 */
export async function createChallenge(
  sql: Db,
  producer: string,
  input: ChallengeInput,
): Promise<{ wallet: WalletRecord; challenge: Challenge | null }> {
  const canonical = canonicaliseAddress(input.chain, input.address)
  const scheme = schemeForChain(input.chain)
  const now = input.now ?? new Date()

  const outcome = await sql.begin(async (tx) => {
    const { wallet } = await insertWallet(tx, producer, {
      userId: input.userId,
      origin: input.origin,
      chain: input.chain,
      network: input.network,
      address: canonical.address,
      label: input.label ?? null,
      // A watch wallet is active on arrival; an external one is provisioning until its signature
      // lands. The distinction is what `authorisationHolds` reads, and it is why a half-finished
      // link cannot be used for anything.
      status: input.origin === 'watch' ? 'active' : 'provisioning',
      actor: `user:${input.userId}`,
      correlationId: input.correlationId,
    })

    if (input.origin === 'watch') return { value: { wallet, challenge: null } }

    if (wallet.status === 'exported' || wallet.status === 'retired') {
      throw new LinkError('wallet_closed', `a ${wallet.status} wallet cannot be re-linked`, 409)
    }

    await tx`
      insert into external_wallet_links (wallet_id, user_id, scheme)
      values (${wallet.id}, ${input.userId}, ${scheme})
      on conflict (wallet_id) do nothing
    `

    const nonce = newNonce()
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000)
    const message = buildChallengeMessage(scheme, {
      domain: input.domain,
      address: wallet.address,
      uri: input.uri,
      chain: input.chain,
      network: input.network,
      nonce,
      issuedAt: now,
      expiresAt,
      ...(input.statement !== undefined ? { statement: input.statement } : {}),
    })

    await tx`
      insert into link_challenges (nonce, wallet_id, user_id, scheme, message, domain, uri,
                                   issued_at, expires_at)
      values (${nonce}, ${wallet.id}, ${input.userId}, ${scheme}, ${message}, ${input.domain},
              ${input.uri}, ${now}, ${expiresAt})
    `

    return {
      value: {
        wallet,
        challenge: {
          walletId: wallet.id,
          scheme,
          nonce,
          message,
          expiresAt: expiresAt.toISOString(),
        },
      },
    }
  })
  return outcome.value
}

interface MessageInput {
  readonly domain: string
  readonly address: string
  readonly uri: string
  readonly chain: ChainId
  readonly network: Network
  readonly nonce: string
  readonly issuedAt: Date
  readonly expiresAt: Date
  readonly statement?: string
}

const DEFAULT_STATEMENT =
  'Link this wallet to your CloudsForge account. This does not authorise any transaction.'

/**
 * The bytes a user is asked to sign, per scheme.
 *
 * The unimplemented schemes still produce a message. That is not busywork: it is what makes the
 * 501 honest rather than an absence. A caller integrating Solana can see the exact challenge this
 * service will expect a signature over, and when the verifier lands the message does not change —
 * which is the difference between adding a verifier and inventing a new protocol.
 */
function buildChallengeMessage(scheme: LinkScheme, input: MessageInput): string {
  const statement = input.statement ?? DEFAULT_STATEMENT
  if (scheme === 'eip4361') {
    return buildSiweMessage({
      domain: input.domain,
      address: input.address,
      statement,
      uri: input.uri,
      version: '1',
      chainId: expectedChainId(input.chain, input.network),
      nonce: input.nonce,
      issuedAt: input.issuedAt.toISOString(),
      expirationTime: input.expiresAt.toISOString(),
    })
  }
  // Solana signMessage, BIP-322 and XRP signed memos all sign an opaque UTF-8 string rather than a
  // structured document, so the shape is a stable single-line form that carries the same four
  // facts EIP-4361 binds: who, where, which one, and until when.
  return [
    `${input.domain} wants you to link this wallet to your CloudsForge account.`,
    `Address: ${input.address}`,
    `Network: ${input.chain}:${input.network}`,
    `URI: ${input.uri}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
  ].join('\n')
}

/* ------------------------------------------------------------------ verification */

export interface VerifyInput {
  readonly userId: string
  readonly nonce: string
  readonly signature: string
  readonly expectedDomain: string
  readonly expectedUri: string
  readonly correlationId: string
  /** Granted on success. Empty is legal: a link with no authorisations proves ownership only. */
  readonly authorisations?: readonly Authorisation[]
  readonly now?: Date
}

interface ChallengeRow {
  readonly nonce: string
  readonly wallet_id: string
  readonly user_id: string
  readonly scheme: string
  readonly message: string
  readonly domain: string
  readonly uri: string
  readonly expires_at: Date
}

/**
 * Verify a signature over an issued challenge and, on success, activate the link.
 *
 * The order of operations is the security argument:
 *
 *   1. **Claim the nonce first**, with an UPDATE that requires it to be unconsumed. Two concurrent
 *      replays of the same signature race here and exactly one wins.
 *   2. Check it is the right user's challenge, and that it has not expired.
 *   3. Verify the signature — domain, uri, nonce, chain id, address, and finally the curve.
 *   4. Only then write `verified_at` and move the wallet to `active`.
 *
 * A failure at (3) leaves the nonce consumed, deliberately. See the file header.
 */
export async function verifyChallenge(
  sql: Db,
  producer: string,
  input: VerifyInput,
): Promise<LinkRecord> {
  const now = input.now ?? new Date()

  // **Step 1, in its own transaction, committed before anything else happens.**
  //
  // The consumption must survive a failed verification, and a transaction that also held the
  // verification would roll it back — handing an attacker an unlimited number of attempts against
  // one challenge. So the claim commits first and alone. The cost is that a crash between here and
  // step 2 burns a challenge; the user requests another, which is a cheap call.
  const claimed = await sql<ChallengeRow[]>`
    update link_challenges
       set consumed_at = now()
     where nonce = ${input.nonce} and consumed_at is null
     returning nonce, wallet_id, user_id, scheme, message, domain, uri, expires_at
  `
  const challenge = claimed[0]
  if (!challenge) {
    // Covers both "never issued" and "already used". They are told apart in the log, never in the
    // response: distinguishing them for the caller confirms which nonces have been issued.
    throw new LinkError('challenge_unusable', 'that challenge is unknown or already used', 400)
  }
  if (challenge.user_id !== input.userId) {
    throw new LinkError('challenge_unusable', 'that challenge is unknown or already used', 400)
  }
  if (challenge.expires_at.getTime() <= now.getTime()) {
    throw new LinkError('challenge_expired', 'that challenge has expired; request a new one', 400)
  }

  const scheme = challenge.scheme as LinkScheme
  if (!IMPLEMENTED_SCHEMES.has(scheme)) throw new SchemeNotImplementedError(scheme)

  const walletRows = await sql<{ address: string; chain: string; network: string }[]>`
    select address, chain, network from wallets where id = ${challenge.wallet_id}
  `
  const wallet = walletRows[0]
  if (!wallet) throw new LinkError('wallet_not_found', 'the challenge names no wallet', 404)

  // Step 2: verify. Every failure below leaves the nonce consumed, deliberately.
  try {
    verifySiwe({
      message: challenge.message,
      signature: input.signature,
      address: wallet.address,
      // From configuration, never from the challenge row: a challenge row is written by this
      // service, but reading the expectation from the same place the message came from would make
      // the check tautological.
      expectedDomain: input.expectedDomain,
      expectedUri: input.expectedUri,
      expectedNonce: challenge.nonce,
      expectedChainId: expectedChainId(wallet.chain as ChainId, wallet.network as Network),
      now,
    })
  } catch (err) {
    if (err instanceof SiweError) throw new LinkError(err.code, err.message, 400)
    // ──────────────────────────────────────────────────────────────────────────────────────────
    // THE SAME DEFECT AS THE TWO CUSTODY ERRORS, ONE ROUTE OVER. `verifySiwe` reaches
    // `recoverAddress`, and a signature that is not 65 bytes, or whose recovery byte is not 27 or
    // 28, or whose r or s is zero, throws `SignatureError` — a typed error nothing caught. It fell
    // through to the generic handler, so any authenticated user could answer a challenge with four
    // bytes of hex and be told the server had broken.
    //
    // It is a 400 because it is: the caller sent something that is not a signature. Told apart
    // from `bad_signature` deliberately — that one means "signed by somebody else", and reporting
    // "your hex is malformed" as "wrong signer" sends an integrator hunting the wrong bug. Neither
    // is an oracle: both describe the caller's own input, unlike the nonce failures above.
    // ──────────────────────────────────────────────────────────────────────────────────────────
    if (err instanceof SignatureError) {
      throw new LinkError('malformed_signature', `that is not a readable signature: ${err.message}`, 400)
    }
    throw err
  }

  // Step 3: activate. One transaction, so a half-linked wallet cannot exist.
  const outcome = await sql.begin(async (tx) => {
    await tx`
      update external_wallet_links
         set challenge_nonce = ${challenge.nonce},
             signature = ${input.signature},
             verified_at = now(),
             revoked_at = null
       where wallet_id = ${challenge.wallet_id}
    `

    for (const authorisation of input.authorisations ?? []) {
      await grantIn(tx, challenge.wallet_id, authorisation, `user:${input.userId}`)
    }

    // `provisioning → active`. A link that verified against a wallet already active — a re-link
    // after a revocation — is a no-op here rather than an error.
    const current = await tx<{ status: string }[]>`
      select status from wallets where id = ${challenge.wallet_id}
    `
    if (current[0]?.status === 'provisioning') {
      await transitionWallet(tx, challenge.wallet_id, 'active', {
        actor: `user:${input.userId}`,
        reason: 'the owner signed the link challenge',
      })
    }

    const link = await readLink(tx, challenge.wallet_id)
    if (!link) throw new LinkError('link_not_found', 'the link could not be read back', 500)

    await writeEvent(tx, producer, {
      topic: WALLET_LINK_VERIFIED,
      key: challenge.wallet_id,
      payload: {
        walletId: challenge.wallet_id,
        userId: input.userId,
        scheme,
        chain: wallet.chain,
        network: wallet.network,
        address: wallet.address,
        authorisations: link.authorisations,
      },
      actor: `user:${input.userId}`,
      correlationId: input.correlationId,
    })

    return { value: link }
  })
  return outcome.value
}

/* ------------------------------------------------------------------ authorisations */

async function grantIn(
  tx: Tx,
  walletId: string,
  authorisation: Authorisation,
  by: string,
): Promise<void> {
  // A re-grant of a revoked authorisation clears the revocation and re-stamps who granted it, so
  // the row is always the *current* state; the history of it is the audit event, not this table.
  await tx`
    insert into external_wallet_authorisations (wallet_id, authorisation, granted_by)
    values (${walletId}, ${authorisation}, ${by})
    on conflict (wallet_id, authorisation)
      do update set revoked_at = null, revoked_by = null, granted_at = now(), granted_by = ${by}
  `
}

export async function grantAuthorisation(
  sql: Db,
  walletId: string,
  authorisation: Authorisation,
  by: string,
): Promise<LinkRecord> {
  const outcome = await sql.begin(async (tx) => {
    const link = await readLink(tx, walletId)
    if (!link) throw new LinkError('link_not_found', 'that wallet has no external link', 404)
    // The check that makes §3.2's invariant unrepresentable rather than merely unimplemented: an
    // authorisation cannot be attached to a link that was never verified, so no later caller has
    // to remember to look.
    if (link.verifiedAt === null || link.revokedAt !== null) {
      throw new LinkError(
        'link_not_verified',
        'authorisations may only be granted on a verified, unrevoked link',
        409,
      )
    }
    await grantIn(tx, walletId, authorisation, by)
    return { value: (await readLink(tx, walletId))! }
  })
  return outcome.value
}

/**
 * Revoke one authorisation, or the whole link.
 *
 * §3.2: "'disconnect a wallet' is revoking all of them plus the link." `authorisation` of `null`
 * is that operation, and it is one transaction so a half-disconnected wallet cannot exist.
 */
export async function revokeAuthorisation(
  sql: Db,
  producer: string,
  input: {
    readonly walletId: string
    readonly userId: string
    readonly authorisation: Authorisation | null
    readonly by: string
    readonly correlationId: string
  },
): Promise<LinkRecord> {
  const outcome = await sql.begin(async (tx) => {
    const link = await readLink(tx, input.walletId)
    if (!link) throw new LinkError('link_not_found', 'that wallet has no external link', 404)

    if (input.authorisation === null) {
      await tx`
        update external_wallet_authorisations
           set revoked_at = now(), revoked_by = ${input.by}
         where wallet_id = ${input.walletId} and revoked_at is null
      `
      await tx`
        update external_wallet_links set revoked_at = now() where wallet_id = ${input.walletId}
      `
    } else {
      await tx`
        update external_wallet_authorisations
           set revoked_at = now(), revoked_by = ${input.by}
         where wallet_id = ${input.walletId} and authorisation = ${input.authorisation}
           and revoked_at is null
      `
    }

    const updated = (await readLink(tx, input.walletId))!
    await writeEvent(tx, producer, {
      topic: WALLET_LINK_REVOKED,
      key: input.walletId,
      payload: {
        walletId: input.walletId,
        userId: input.userId,
        authorisation: input.authorisation,
        remaining: updated.authorisations,
      },
      actor: input.by,
      correlationId: input.correlationId,
    })
    return { value: updated }
  })
  return outcome.value
}

export async function readLink(sql: Db | Tx, walletId: string): Promise<LinkRecord | null> {
  const rows = await sql<LinkRow[]>`
    select wallet_id, user_id, scheme, verified_at, revoked_at
      from external_wallet_links where wallet_id = ${walletId}
  `
  const row = rows[0]
  if (!row) return null
  const granted = await sql<{ authorisation: string }[]>`
    select authorisation from external_wallet_authorisations
     where wallet_id = ${walletId} and revoked_at is null
     order by authorisation
  `
  return {
    walletId: row.wallet_id,
    userId: row.user_id,
    scheme: row.scheme as LinkScheme,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    authorisations: granted.map((g) => g.authorisation as Authorisation),
  }
}

/**
 * **The single question every authority check in this service asks.**
 *
 * True only when all four hold: the link exists, it was verified, it has not been revoked, and the
 * named authorisation is currently granted. A `watch` wallet has no link at all, so this is false
 * for it by construction rather than by a rule someone has to remember — which is what makes
 * "an unverified address can never be a withdrawal destination" a property of the code rather than
 * a note in a document.
 */
export async function authorisationHolds(
  sql: Db | Tx,
  walletId: string,
  authorisation: Authorisation,
): Promise<boolean> {
  const rows = await sql<{ ok: boolean }[]>`
    select true as ok
      from external_wallet_links l
      join external_wallet_authorisations a on a.wallet_id = l.wallet_id
     where l.wallet_id = ${walletId}
       and l.verified_at is not null
       and l.revoked_at is null
       and a.authorisation = ${authorisation}
       and a.revoked_at is null
  `
  return rows.length > 0
}
