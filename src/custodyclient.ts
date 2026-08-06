/**
 * Custody, as this service uses it.
 *
 * **This service holds no keys and asks for none.** 04-domain-model §3.3: a `custody_key` "never
 * leaves the service". What comes back from the calls below is an address and a URN — the URN is a
 * handle for later signing requests, never key material, and there is no method here that could
 * return a private key even if custody offered one.
 *
 * ## Why `scheme` is in the response and not assumed
 *
 * §3.3 again: "Two key schemes coexist permanently. Addresses created before Phase 5 are
 * `flat_random` with no derivation path and no mnemonic. New addresses are `hd_bip44`… Every
 * custody response states the scheme, because it determines which export formats are offered.
 * Pretending otherwise would mean offering a recovery phrase that does not exist." So it is
 * carried through onto the wallet row and into the API rather than defaulted.
 *
 * ## `micro-custody` does not have an HTTP surface yet
 *
 * The repository exists — chains, the encryption envelope, HD derivation — but its server does
 * not. This interface is therefore the shape wallet needs, written against 04-domain-model §3.3
 * and the routes `forge-keyvault` already serves, and the HTTP implementation below is what will
 * be pointed at it. Nothing in this service's tests requires it to exist: they use a local fake,
 * which is the point of the interface.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { Network } from '@cloudsforge/contracts-chain'
import { custodyChainOf, type ChainId } from './addresses.ts'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call custody. Named here so the deploy can be
 * derived from it (`micro-deploy`'s `scripts/derive-grants.mjs`).
 *
 * ── IT SAID `custody:address`, AND NO SUCH SCOPE HAS EVER EXISTED ────────────────────────────
 *
 * `@cloudsforge/contracts-auth` registers `custody:address:create`, and custody gates the only
 * route this file calls on exactly that: `ADDRESS_CREATE_SCOPE = 'custody:address:create'`
 * (`custody/src/server.ts`). Both sides were re-read before this line was edited; the
 * registry is the correct side.
 *
 * It never caused an outage, which is the interesting part. The hand-written compose map happened
 * to grant the right spelling, so the source and the deploy disagreed for the life of the service
 * and nothing compared them. The moment the deploy was derived FROM this constant instead, the
 * disagreement became fatal: identity validates its grants against the registry at import and
 * refuses to start on an unknown name, so this one word would have taken down token minting for
 * the whole estate.
 *
 * ── AND THE ANNOTATION IS THE REAL FIX ───────────────────────────────────────────────────────
 *
 * `readonly LiveScope[]`, not `readonly string[]`. A scope the registry does not have is a
 * COMPILE ERROR here rather than a boot failure found by a deploy script months later. Nothing
 * else was looking: `service-ci.yml`'s scope audit reads a repository's INBOUND route gates, and
 * this is an outbound demand.
 *
 * ── AND WHY `LiveScope` RATHER THAN `Scope` ──────────────────────────────────────────────────
 *
 * This annotation first said `Scope`, and it stopped one step short. `Scope` is
 * `keyof typeof SCOPES` — every registered key, DEPRECATED ones included — so it caught
 * `custody:address`, which is not a key, and would have waved through `wallet:provision`, which
 * is. Identity will not mint a deprecated scope either, so the two mistakes end in the same dead
 * identity container.
 *
 * `LiveScope = Exclude<Scope, DeprecatedScope>`, and `DeprecatedScope` is computed FROM `SCOPES`
 * by a conditional type over the `deprecated` field rather than hand-listed, so it cannot drift
 * from the registry (`contracts/packages/auth/src/index.ts`). `Scope` keeps its wide meaning
 * on purpose: reading a token is wide, because one may arrive carrying a scope that has since
 * died; demanding is narrow. This is the demanding direction.
 */
export const CUSTODY_SCOPES: readonly LiveScope[] = Object.freeze(['custody:address:create'])

/** Custody could not be reached, or answered 5xx. We do not know whether an address was minted. */
export class CustodyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyUnavailableError'
  }
}

/**
 * Custody looked at the request and refused it. Not retriable.
 *
 * ── IT CARRIED NO STATUS, AND IT CARRIED THE WRONG MESSAGE ───────────────────────────────────
 *
 * This used to be `new CustodyRefusedError('custody_refused', err.message)`, and `err.message` on
 * an `HttpError` is `"POST http://custody:4000/v1/addresses → 400"` — the transport's own summary.
 * Two things were wrong with that at once. The reason custody gave was in `err.body` and was
 * discarded, so the one actionable fact never left this file; and what took its place named an
 * internal host and port, which is not a sentence to put in front of a user.
 *
 * `status`, `code` and a message parsed out of custody's error envelope instead — the same three
 * fields `LedgerRefusedError` carries, because `server.ts` has to make the same decision about
 * both and two shapes would be two decisions.
 */
export class CustodyRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'CustodyRefusedError'
    this.code = code
    this.status = status
  }
}

/**
 * Custody answered 2xx and the body was not the shape custody publishes.
 *
 * ── THIS IS THE CLASS OF DEFECT THAT MADE THIS FILE WRONG FOR ITS WHOLE LIFE ─────────────────
 *
 * `CustodyAddress` used to be handed straight out of `client.request<CustodyAddress>()`, which is
 * a cast and not a check. Custody replies `{ key: {…} }` (`custody/src/server.ts`) and has
 * never published a `custodyKeyUrn`, so every field this service wanted was `undefined` — and
 * `undefined` does not announce itself. It travels: into `canonicaliseAddress(chain, undefined)`
 * as a `TypeError` on `.trim()`, or into `custody_key_urn text not null` as a constraint
 * violation, and either way the caller is told `internal`.
 *
 * A response the peer decided to send that this service cannot read is neither a refusal nor an
 * outage, so it is neither of the two errors above it. `server.ts` maps it to 502: the peer
 * answered and the answer was unusable, which is the one thing a retry will not fix.
 */
export class CustodyContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyContractError'
  }
}

export type KeyScheme = 'flat_random' | 'hd_bip44'

const SCHEMES: ReadonlySet<string> = new Set<KeyScheme>(['flat_random', 'hd_bip44'])

/**
 * The handle this service stores for a custody key.
 *
 * ── CUSTODY HAS NO URN, AND IT IS RIGHT NOT TO ───────────────────────────────────────────────
 *
 * The docstring above this used to promise `cf:custody:key:<id>`, and custody has no id: its key
 * table is keyed by `address` (`custody/src/migrations.ts`), `04-domain-model.md` §3.3 lists no
 * identifier field at all, and every route that names one key names it by address —
 * `GET /v1/addresses/:address`, and the `/v1/sign` binding whose five fields include `address`
 * (`12-security-decisions.md`). Asking custody to invent an identifier so that this column
 * could be filled would be adding an identity to the service that holds keys, in order to satisfy
 * a naming choice made in the service that does not.
 *
 * So the URN is minted here. `04-domain-model.md` sets the form as `cf:<service>:<type>:<id>`
 * and allows "chain addresses" as the id where "an external system dictates otherwise" — but an
 * address alone is not unique across networks. That is not hypothetical for this estate: the XRP
 * testnet/mainnet address collision is a recorded defect (`04-domain-model.md` §4.1) and it is
 * why `hd_bip44` puts the network in the coin type (`custody/src/keys.ts`). `chain` and
 * `network` are therefore qualifiers, exactly as `cf:chain:<chain>:<network>:<hash>` already does
 * for transactions elsewhere in the estate.
 *
 * Every segment comes from custody's own reply, in custody's own spelling, so the URN dereferences
 * back to custody unchanged. `deposits.ts` re-canonicalises the address it *stores*; it must not
 * re-canonicalise the address it *names*.
 */
export function custodyKeyUrn(key: {
  readonly chain: string
  readonly network: string
  readonly address: string
}): string {
  return `cf:custody:key:${key.chain}:${key.network}:${key.address}`
}

export interface CustodyAddress {
  /** `cf:custody:key:<chain>:<network>:<address>`. A handle, never key material. */
  readonly custodyKeyUrn: string
  /** The chain's own canonical display form. Re-canonicalised on arrival regardless. */
  readonly address: string
  readonly chain: ChainId
  readonly network: Network
  readonly scheme: KeyScheme
  /** Present only for `hd_bip44`. Absent, not empty, for a flat random key. */
  readonly derivationPath?: string
}

export interface CreateAddressRequest {
  readonly userId: string
  readonly chain: ChainId
  readonly network: Network
  /** `deposit` here, always. The other purposes belong to settlement and mint. */
  readonly purpose: 'deposit'
  /**
   * **The signing binding, and the reason this key exists.** Required by custody
   * (`custody/src/server.ts` — `stringField`, no default, unlike the three `enumField` calls
   * below it), stored `not null` (`custody/src/migrations.ts`), and compared character for
   * character before any signature is produced (`custody/src/gates.ts`, SD-09 at
   * `12-security-decisions.md`). It was not sent at all until 2026-08-04, so every deposit
   * provisioning call this service ever made was refused 400.
   *
   * **It is the deposit assignment's id**, which is not an arbitrary choice. settlement has to
   * restate this exact string to sweep the address, has nothing to derive it from, and says so:
   * "`userId` and `orderId` are whatever wallet used when it had custody mint the address … A
   * guessed binding is a sweep refused every tick for ever" (`settlement/src/server.ts`). The
   * assignment id is the one value this service can still produce for that address years later —
   * it is the row's primary key — so it needs no column of its own to stay restatable. It is also
   * one binding per address rather than one per user-and-asset, which matters because the
   * binding's entropy is entirely in `userId` and `orderId` (`custody/src/keys.ts`) and a
   * rotation that reused the previous string would spend that entropy twice.
   *
   * mint made the same choice for the same reason: `orderId: token.id` (`mint/src/deploy.ts`).
   */
  readonly orderId: string
  /**
   * Sent as `idempotency-key` so a retried POST is safe at the transport.
   *
   * **Custody honours it as of its migration 6**, and did not before. This docstring twice said
   * something untrue about another repository: first "Custody returns the same address for the same
   * key", then — after that was found to be false — "Custody does not honour it yet", which was
   * true when written and is not now. Both are re-checked against custody's source rather than
   * against this comment's history:
   *
   *   * the header is read at `custody/src/server.ts` and carried into `provisionAddress`;
   *   * a repeat under one key returns the ORIGINAL address with 200 and `reused: true`
   *     (`custody/src/keys.ts` `findReplay`);
   *   * and the invariant is a unique index, `custody_keys_idempotency_uniq` on
   *     `(created_by, idempotency_key)`, so a retry that races the lookup is refused by the
   *     database rather than by a check that happened to run first.
   *
   * **Reusing one key for a DIFFERENT request is a 409 `idempotency_conflict`, not an address.**
   * That is deliberate on custody's side and this service depends on it: `orderId` is the binding
   * settlement restates to sweep, so being handed the previous request's address under this
   * request's order would strand every future sweep. `assignDepositAddress` handles the 409 by
   * re-reading the assignment the winner wrote.
   */
  readonly idempotencyKey: string
}

/**
 * Custody's success body: `{ key: <CustodyKeyRecord> }`.
 *
 * Declared separately from `CustodyAddress` because they are not the same shape and pretending
 * they were is the whole defect. `CustodyKeyRecord` is `custody/src/store.ts`.
 */
interface CustodyKeyReply {
  readonly key?: {
    readonly address?: unknown
    readonly chain?: unknown
    readonly network?: unknown
    readonly scheme?: unknown
    readonly derivationPath?: unknown
  }
}

export interface CustodyClient {
  createAddress(request: CreateAddressRequest): Promise<CustodyAddress>
}

export interface CustodyClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpCustodyClient(options: CustodyClientOptions): CustodyClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'custody',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async createAddress(request) {
      let body: CustodyKeyReply
      try {
        body = await client.request<CustodyKeyReply>('/v1/addresses', {
          method: 'POST',
          body: {
            userId: request.userId,
            // **CUSTODY'S CHAIN NAME, NOT THIS SERVICE'S SLUG.** `custody/src/server.ts`
            // refuses anything outside its own `CHAIN_ASSET` keys with 400 `unknown_chain`, and
            // those keys are `ethereum`, `bitcoin`, `litecoin`, `solana`, `xrp`, `ember`. This
            // service sent the slug, so every deposit for ETH, BTC and SOL was refused. See
            // `custodyChainOf`. The translation is HERE, at the wire, so nothing on this side of
            // the boundary — rows, events, URNs — changes vocabulary.
            chain: custodyChainOf(request.chain),
            network: request.network,
            purpose: request.purpose,
            orderId: request.orderId,
          },
          idempotencyKey: request.idempotencyKey,
        })
      } catch (err) {
        throw translate(err)
      }
      // Outside the catch on purpose: a contract failure is not a transport failure, and wrapping
      // it in `translate` would report an unreadable 201 as "custody is unavailable" — an
      // instruction to retry something that will fail identically for ever.
      return parseAddress(body, request)
    },
  }
}

/**
 * Read custody's reply, and refuse to guess.
 *
 * Every field is checked rather than cast. `chain` and `network` are additionally compared with
 * what was asked for: custody echoes both back, and a mismatch would mean an address on a chain
 * or a network this service is about to file under a different one — the one class of custody
 * error that is silently spendable, because a testnet address filed as mainnet is an address a
 * user is invited to send real money to.
 */
function parseAddress(body: CustodyKeyReply, request: CreateAddressRequest): CustodyAddress {
  const key = body.key
  if (key === null || typeof key !== 'object') {
    throw new CustodyContractError(
      'custody returned no `key` object — its success body is `{ key: … }` ' +
        '(custody/src/server.ts:368), and the address is inside it',
    )
  }
  const address = key.address
  if (typeof address !== 'string' || address.trim().length === 0) {
    throw new CustodyContractError('custody returned a key with no address on it')
  }
  // **CUSTODY ECHOES ITS OWN CHAIN NAME, SO THE COMPARISON IS AGAINST THE TRANSLATED VALUE.**
  // Comparing custody's `ethereum` against this service's `eth` would reject every correct reply
  // as a contract violation — which is the mirror of the defect on the request side, and it is
  // load-bearing that both halves move together: fixing only the request turns a 400 from custody
  // into a `CustodyContractError` here, which is the same outage wearing a different name.
  const expectedChain = custodyChainOf(request.chain)
  if (key.chain !== expectedChain) {
    throw new CustodyContractError(
      `custody minted a ${String(key.chain)} address for a ${expectedChain} request`,
    )
  }
  if (key.network !== request.network) {
    throw new CustodyContractError(
      `custody minted a ${String(key.network)} address for a ${request.network} request`,
    )
  }
  const scheme = key.scheme
  if (typeof scheme !== 'string' || !SCHEMES.has(scheme)) {
    throw new CustodyContractError(
      `custody named the scheme '${String(scheme)}', which is not one this service can offer an ` +
        'export format for — 04-domain-model §3.3 says the scheme decides which formats exist',
    )
  }
  // `derivationPath` is `string | null` on the wire and optional here: `exactOptionalPropertyTypes`
  // means the null must be dropped rather than assigned, and SDR-08 means a legacy key's absent
  // path is a fact to carry honestly rather than an empty string to invent.
  const derivationPath = key.derivationPath
  if (derivationPath !== null && derivationPath !== undefined && typeof derivationPath !== 'string') {
    throw new CustodyContractError('custody returned a derivation path that is not a string')
  }
  return {
    custodyKeyUrn: custodyKeyUrn({ chain: request.chain, network: request.network, address }),
    address,
    chain: request.chain,
    network: request.network,
    scheme: scheme as KeyScheme,
    ...(typeof derivationPath === 'string' ? { derivationPath } : {}),
  }
}

/**
 * Turn an HTTP failure into one of the two things a caller can act on.
 *
 * `HttpError.peerDecided` is the discriminator, exactly as in `ledgerclient.ts`: a 4xx means
 * custody looked at the request and said no, and the reason is a fact worth carrying. Anything
 * else — 5xx, a timeout, an open circuit — means we do not know whether an address was minted, and
 * the only safe instruction is to retry with the same idempotency key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new CustodyRefusedError(err.status, parsed.code, parsed.message)
  }
  return new CustodyUnavailableError(err instanceof Error ? err.message : String(err))
}

/**
 * Read custody's error envelope.
 *
 * Custody replies `{ error: { code, message, requestId } }` — the estate's one error shape, which
 * this service serves too. Falling back to the raw body rather than to a fixed string keeps a
 * refusal from a proxy or a misrouted request legible instead of silently becoming
 * `custody_refused` with nothing attached.
 */
function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'custody_refused',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'custody_refused', message: body.slice(0, 500) }
  }
}
