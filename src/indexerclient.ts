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

export const INDEXER_SCOPES: readonly string[] = Object.freeze(['indexer:read', 'indexer:write'])

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

export interface IndexerClient {
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
