/**
 * The indexer, as this service uses it.
 *
 * Two calls, and the division of labour between them is the whole architecture of deposits:
 *
 *   * **`watch`** registers an address in the indexer's `watched_addresses`. `address_activity` is
 *     written for every address a block touches — six products need that general record — but a
 *     deposit *event* is a different thing, because a topic every wallet replica subscribes to
 *     cannot be every transfer on the chain. This call is what says "this one is worth telling us
 *     about". It is not a decision about money; it decides who is worth telling.
 *   * **`activity`** reads what the chain did for an address, paginated. Used by the portfolio for
 *     `external` and `watch` wallets, where the platform holds nothing and the only truth is on
 *     chain.
 *
 * **The indexer never decides a credit and this client cannot ask it to.** There is no method here
 * that returns "should I credit this". The indexer reports; `deposits.ts` decides. A service that
 * both watches the chain and moves the money is a service where a bug in the first half spends the
 * second half — which is the indexer's own stated reason for splitting the two.
 *
 * ## `watch` is idempotent and must be treated as such
 *
 * Its store does an upsert on `(chain, network, address)` and it answers 202. Re-registering a
 * known address is therefore free, which is what lets the retry job in `jobs.ts` be a blunt
 * "register everything unwatched" pass rather than something that has to track its own progress.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'
import type { Network } from '@cloudsforge/contracts-chain'
import type { ChainId } from './addresses.ts'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call the indexer.
 *
 * Both, and both are used. `PUT /v1/watch/:chain/:network/:address` registers a deposit address
 * to watch and goes through `authorise(…, WRITE_SCOPE)` (`indexer/src/server.ts:90,551`);
 * `GET /v1/addresses/…/activity` goes through `authoriseRead`, which demands
 * `READ_SCOPE = 'indexer:read'` (`:89,727`).
 *
 * `readonly LiveScope[]` rather than `readonly string[]`: see the header of `custodyclient.ts`, where
 * the untyped form let a scope that does not exist sit in this repository unnoticed.
 */
export const INDEXER_SCOPES: readonly LiveScope[] = Object.freeze(['indexer:read', 'indexer:write'])

export class IndexerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndexerUnavailableError'
  }
}

/** The indexer refused: an unknown chain, an address that is not a plausible one. Not retriable. */
export class IndexerRefusedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'IndexerRefusedError'
    this.code = code
  }
}

/**
 * One movement the indexer observed. Mirrors `ActivityView` in `indexer/src/reads.ts`, with the
 * amount parsed back into a `bigint` here so no caller has to remember that it arrived as a string.
 */
export interface ObservedActivity {
  readonly id: string
  readonly address: string
  readonly direction: 'in' | 'out'
  readonly assetCode: string
  readonly assetKind: 'native' | 'token'
  readonly tokenAddress: string | null
  readonly amount: bigint
  readonly txHash: string
  readonly explorerUrl: string | null
  readonly logIndex: number | null
  readonly blockHeight: number
  readonly status: 'included' | 'orphaned'
  readonly confirmations: number | null
  readonly confirmed: boolean
  readonly firstSeenAt: string
  readonly confirmedAt: string | null
}

export interface ActivityPage {
  readonly address: string
  readonly tipHeight: number | null
  readonly requiredConfirmations: number
  readonly items: readonly ObservedActivity[]
  readonly nextCursor: string | null
}

/**
 * What the indexer says about ONE chain on ONE network.
 *
 * Narrowed to the three fields this service acts on. `micro-indexer`'s `/v1/chains/:c/:n/status`
 * answers a good deal more — reorg history, lag, per-provider latency — and none of it is a
 * decision wallet makes, so none of it is typed here. Additive on the far side by contract.
 */
export interface ChainStatus {
  readonly chain: ChainId
  readonly network: Network
  /**
   * **How many sources the indexer has for this chain, and the whole of what "observable" means.**
   *
   * `listProviderHealth` returns a row per configured provider, so this is empty exactly when the
   * indexer follows no source for this scope — which on the estate today is every chain but EMBER,
   * because `INDEXER_CHAINS` names one. It is the right discriminator rather than `indexedHeight`,
   * which is also null for a chain that was configured a minute ago and has not caught up: refusing
   * on that would make a newly-added chain unusable until its first block landed.
   */
  readonly providers: number
  readonly indexedHeight: number | null
  /** The follower has stopped on purpose. A configured chain that is not currently advancing. */
  readonly halted: boolean
}

export interface IndexerClient {
  /** Read-only, and never throws for "this chain is not followed" — that is an ANSWER. */
  chainStatus(chain: ChainId, network: Network): Promise<ChainStatus>
  watch(chain: ChainId, network: Network, address: string, label: string | null): Promise<void>
  activity(
    chain: ChainId,
    network: Network,
    address: string,
    limit: number,
    cursor: string | null,
  ): Promise<ActivityPage>
}

export interface IndexerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpIndexerClient(options: IndexerClientOptions): IndexerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'indexer',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async chainStatus(chain, network) {
      try {
        const body = await client.get<RawChainStatus>(`/v1/chains/${chain}/${network}/status`)
        return {
          chain,
          network,
          // `?? []` rather than a throw: an older indexer that does not send the field must not
          // make every chain unobservable, and a LENGTH of zero is then the honest reading of
          // "it did not tell us it had one".
          providers: Array.isArray(body?.providers) ? body.providers.length : 0,
          indexedHeight: typeof body?.indexedHeight === 'number' ? body.indexedHeight : null,
          halted: body?.halted === true,
        }
      } catch (err) {
        throw translate(err)
      }
    },

    async watch(chain, network, address, label) {
      try {
        await client.request(
          `/v1/watch/${chain}/${network}/${encodeURIComponent(address)}`,
          {
            method: 'POST',
            body: { label },
            // An upsert on the far side, so a retry is a no-op rather than a second row.
            idempotencyKey: `wallet:watch:${chain}:${network}:${address.toLowerCase()}`,
          },
        )
      } catch (err) {
        throw translate(err)
      }
    },

    async activity(chain, network, address, limit, cursor) {
      const query = new URLSearchParams({ limit: String(limit) })
      if (cursor) query.set('cursor', cursor)
      try {
        const body = await client.get<RawActivityPage>(
          `/v1/addresses/${chain}/${network}/${encodeURIComponent(address)}/activity?${query}`,
        )
        return {
          address: body.address,
          tipHeight: body.tipHeight,
          requiredConfirmations: body.requiredConfirmations,
          items: body.items.map((item) => ({ ...item, amount: BigInt(item.amount) })),
          nextCursor: body.nextCursor,
        }
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

interface RawChainStatus {
  readonly providers?: readonly unknown[]
  readonly indexedHeight?: number | null
  readonly halted?: boolean
}

interface RawActivityPage {
  readonly address: string
  readonly tipHeight: number | null
  readonly requiredConfirmations: number
  readonly items: readonly (Omit<ObservedActivity, 'amount'> & { amount: string })[]
  readonly nextCursor: string | null
}

function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    return new IndexerRefusedError('indexer_refused', err.message)
  }
  return new IndexerUnavailableError(err instanceof Error ? err.message : String(err))
}
