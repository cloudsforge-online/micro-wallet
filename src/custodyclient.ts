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
import type { ChainId } from './addresses.ts'
import type { Scope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call custody. Named here so the deploy can be
 * derived from it (`micro-deploy`'s `scripts/derive-grants.mjs`).
 *
 * ── IT SAID `custody:address`, AND NO SUCH SCOPE HAS EVER EXISTED ────────────────────────────
 *
 * `@cloudsforge/contracts-auth` registers `custody:address:create`, and custody gates the only
 * route this file calls on exactly that: `ADDRESS_CREATE_SCOPE = 'custody:address:create'`
 * (`custody/src/server.ts:104`). Both sides were re-read before this line was edited; the
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
 * `readonly Scope[]`, not `readonly string[]`. `Scope` is `keyof typeof SCOPES` — the registry
 * itself — so a scope the registry does not have is a COMPILE ERROR here rather than a boot
 * failure found by a deploy script months later. Nothing else was looking: `service-ci.yml`'s
 * scope audit reads a repository's INBOUND route gates, and this is an outbound demand.
 *
 * `Scope` still admits a DEPRECATED scope, which identity will not mint either — the registry
 * exports no live-only type. `scopes.test.ts` covers that at test time.
 */
export const CUSTODY_SCOPES: readonly Scope[] = Object.freeze(['custody:address:create'])

export class CustodyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyUnavailableError'
  }
}

/** Custody looked at the request and refused it. Not retriable. */
export class CustodyRefusedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CustodyRefusedError'
    this.code = code
  }
}

export type KeyScheme = 'flat_random' | 'hd_bip44'

export interface CustodyAddress {
  /** `cf:custody:key:<id>`. A handle, never key material. */
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
   * Makes the call safe to retry. Custody returns the same address for the same key rather than
   * minting a second one — a second address for one assignment is an address nobody is watching
   * and a deposit nobody sees.
   */
  readonly idempotencyKey: string
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
      try {
        const body = await client.request<CustodyAddress>('/v1/addresses', {
          method: 'POST',
          body: {
            userId: request.userId,
            chain: request.chain,
            network: request.network,
            purpose: request.purpose,
          },
          idempotencyKey: request.idempotencyKey,
        })
        return body
      } catch (err) {
        if (err instanceof HttpError && err.peerDecided) {
          throw new CustodyRefusedError('custody_refused', err.message)
        }
        throw new CustodyUnavailableError(err instanceof Error ? err.message : String(err))
      }
    },
  }
}
