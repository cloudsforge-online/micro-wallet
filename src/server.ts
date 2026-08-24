/**
 * The HTTP surface.
 *
 * Plain `node:http`, following the service template, with path parameters added because half the
 * routes here are scoped by a wallet id. The `route` metric label is the **pattern**, never the
 * resolved path — using the raw path would let any caller mint unbounded time series by requesting
 * a million wallet ids and take the scrape target down with cardinality.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ## Four decisions in this file are load-bearing
 *
 * 1. **A missing idempotency key on a money route is a 400.** Every one of them, including
 *    `POST /v1/spend`. forge-pay's `/spend` is the estate's one money route that accepts a missing
 *    key — its own comment says a retry without one debits twice — and it is the most-retried
 *    money route in the estate, called by games on every action over mobile networks. There is no
 *    route below that reaches a store function without a key.
 *
 * 2. **Amounts cross the wire as strings.** A JSON number is an IEEE 754 double and an 18-decimal
 *    EMBER amount does not survive one. A number is accepted only when it is already a safe
 *    integer, and the error otherwise says to send a string rather than silently storing a value
 *    that is not the one the caller meant.
 *
 * 3. **A bad token is 401; a verifier that could not reach the JWKS is 503.** Answering 401 there
 *    signs every user in the estate out because identity is having a bad minute. Five services in
 *    the estate currently disagree about this; `statusFor` is the one place that decides.
 *
 * 4. **The event intake is authenticated by HMAC, not by a bearer token.** It is the endpoint the
 *    indexer's relay posts deposits to, and the relay signs the exact bytes it sends. Verifying
 *    the signature before parsing is what makes an unauthenticated body incapable of reaching the
 *    crediting path at all.
 */

import { NetworkUnknownError, requestNetwork } from '@cloudsforge/http'
import type { NetworkSql } from '@cloudsforge/db'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { Actor } from '@cloudsforge/contracts-money'
import {
  CHAINS,
  assertIssuable,
  type AssetCode,
  type IssuableAssetCode,
  type Network,
} from '@cloudsforge/contracts-chain'
import { AddressError, isChainId, type ChainId } from './addresses.ts'
import { CustodyContractError, CustodyRefusedError, CustodyUnavailableError } from './custodyclient.ts'
import {
  assignDepositAddress,
  depositableAssets,
  DepositError,
  handleDepositConfirmed,
  listAssignments,
  listCredits,
  listTokenSightings,
  type DepositDeps,
  type DepositEventPayload,
} from './deposits.ts'
import {
  IdempotencyInFlightError,
  IdempotencyKeyRequiredError,
  IdempotencyKeyReuseError,
  requireIdempotencyKey,
} from './idempotency.ts'
import { LedgerRefusedError, LedgerUnavailableError } from './ledgerclient.ts'
import {
  createChallenge,
  grantAuthorisation,
  isAuthorisation,
  LinkError,
  readLink,
  revokeAuthorisation,
  verifyChallenge,
  type Authorisation,
} from './links.ts'
import {
  convert,
  DESK_SUBJECT,
  deskInventory,
  fundDesk,
  listConversions,
  listTransfers,
  MoneyError,
  quoteConversion,
  readConversion,
  spend,
  transfer,
  type MoneyDeps,
} from './money.ts'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  verifyDelivery,
} from '@cloudsforge/contracts-events'
import { INDEXER_DEPOSIT_CONFIRMED, type Db } from './outbox.ts'
import { readPortfolio, type PortfolioDeps } from './portfolio.ts'
import { SETTLEMENT_CONFIRMED, SETTLEMENT_FAILED } from './settlement.ts'
import {
  DEFAULT_PAGE_SIZE,
  listWallets,
  MAX_PAGE_SIZE,
  findWallet,
  relabelWallet,
  setPrimary,
  transitionWallet,
  WalletError,
  type WalletOrigin,
  type WalletStatus,
} from './wallets.ts'
import {
  failWithdrawal,
  findWithdrawal,
  listWithdrawals,
  requestWithdrawal,
  settleWithdrawal,
  WithdrawalError,
  type WithdrawalDeps,
} from './withdrawals.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  /**
   * The boot-time default. `forRequest` replaces it with the estate the gateway stamped.
   *
   * Not a label: wallet's `network` decides which chain a deposit is watched on and which estate a
   * withdrawal leaves. One pod serving both has no process-wide answer.
   */
  readonly network: Network
  /**
   * The per-network SELECTOR. The four bundles below are boot-time values; `forRequest` rebuilds
   * each against this request's handle before any route sees them.
   *
   * `NetworkSql` has no query methods, so nothing can read it directly by mistake.
   */
  readonly sql: NetworkSql
  /** `CF_NETWORK_SINGLE`, for `pnpm dev`, which has no gateway to stamp the header. */
  readonly singleNetwork?: Network
  readonly deposits: DepositDeps
  readonly withdrawals: WithdrawalDeps
  readonly money: MoneyDeps
  readonly portfolio: PortfolioDeps
  /**
   * Verifies the HMAC on inbound events — the secrets a producing service may have signed with.
   *
   * A LIST as well as a scalar, and the list is the point: `OUTBOX_SIGNING_SECRET` is one key
   * shared across the estate, and it can only be replaced by a rolling change if a receiver
   * accepts both the outgoing and the incoming key for the length of the cutover. Accepting one
   * means the instant a producer's relay moves, every delivery 401s and the relay retries for
   * ever — a partition with a green `/livez`. A scalar still behaves exactly as it always has;
   * `env.outboxAcceptSecrets` is what production passes.
   *
   * The array goes STRAIGHT into `verifyDelivery` rather than being looped over here, so the
   * timing-safe comparison and the freshness window stay in the contract where they are tested.
   */
  readonly eventSigningSecret: string | readonly string[]
  readonly challengeDomain: string
  readonly challengeUri: string
  readonly challengeTtlSeconds: number
  readonly beforeScrape?: () => Promise<void>
}

/**
 * The scopes a service token must carry.
 *
 * Three rather than one `wallet:write`, because reading a portfolio, registering a wallet and
 * moving money are three different authorities and a service that needs one rarely needs all
 * three: `hub-api` reads, a game spends, an operator console writes.
 */
export const READ_SCOPE = 'wallet:read'
export const WRITE_SCOPE = 'wallet:write'
export const MONEY_SCOPE = 'wallet:money'

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'wallet_deposit_credits_total',
      help: 'Deposit events acted on, by outcome. `duplicate` is the redelivery path and is healthy.',
      kind: 'counter',
      labels: ['outcome'],
    })
    /**
     * Money that arrived on chain, was claimed, and has not been posted to the ledger — so the
     * owner cannot see it. Written from exactly one place, `deposits.pendingCreditCount`, called by
     * `beforeScrape` in `index.ts`.
     *
     * **It is an exact count and it must stay one.** It was the `.length` of a 500-row page, so it
     * saturated at 500 and reported the same value for a backlog of five hundred and one of forty
     * thousand; the `deposit.post-credit` job separately wrote its own 50-row cap from whichever
     * replica held the lease. micro-org#326 removed both. `DepositCreditsUnposted` is now deployed
     * against this series, and a rule cannot escalate on an input that stops moving.
     *
     * Unlabelled, unlike the three address series below. The condition has no dimension an operator
     * would act on differently: every unposted credit has the same repair — find out why the
     * posting is being refused — and the `creditId` and `err` are in wallet's logs, which is where a
     * per-row answer belongs rather than in a label Prometheus would carry for ever.
     */
    .register({
      name: 'wallet_deposit_credits_pending',
      help: 'Deposit credits claimed locally whose ledger posting has not landed. Should be 0.',
      kind: 'gauge',
      labels: [],
    })
    /**
     * **Money that arrived at a deposit address and is in nobody's ledger** — micro-org#200.
     *
     * Unlike `wallet_deposit_credits_pending`, which is a backlog that drains, this one only ever
     * goes up: a token sighting is never resolved by this service, because crediting a `TOKEN:`
     * asset needs a decimals source, a `chain_assets` row and a withdrawal path none of which
     * exist. So it is not an error rate — it is the size of an obligation the estate has taken on
     * and has not recorded, and the number an operator needs before deciding whether the token
     * work is still ahead of the queue.
     *
     * Unlabelled for the same reason the pending-credits gauge is: every row has the same repair,
     * which is a human one, and the chain, contract and user are in the row rather than in a label
     * Prometheus would carry for ever.
     */
    .register({
      name: 'wallet_deposit_token_sightings',
      help:
        'Token transfers observed at deposit addresses and not credited. Never drains — see ' +
        'micro-org#200. Non-zero means customer money is held against no ledger liability.',
      kind: 'gauge',
      labels: [],
    })
    /**
     * The three series below are one reading, taken together at scrape time by
     * `sampleDepositAddressMetrics`. Read them together too — `unwatched - unobservable` per chain
     * is the part of the backlog somebody has to fix, and either half alone says the wrong thing.
     *
     * `chain` was added in micro-org#310. The two gauges were scalars, and eleven unwatched
     * addresses on an estate whose indexer follows one chain is a number an operator could do
     * nothing with without opening psql. `sum(wallet_deposit_addresses_unwatched)` is the old
     * value, exactly.
     */
    .register({
      name: 'wallet_deposit_addresses_unwatched',
      help: 'Deposit addresses on this chain the indexer has not been asked to watch. Should be 0.',
      kind: 'gauge',
      labels: ['chain'],
    })
    .register({
      name: 'wallet_deposit_addresses_unobservable',
      help:
        'Of the unwatched, how many are on a chain the indexer follows no source for. Not a fault ' +
        'and not zero-by-default: it is the owner deciding whether to support the chain.',
      kind: 'gauge',
      labels: ['chain'],
    })
    /**
     * **Deposit addresses this deployment has already issued on a chain it cannot pay out of** —
     * promises outstanding against a capability that is gone or never arrived.
     *
     * The gate in `observability.ts` shuts the door on NEW addresses. It cannot recall the ones
     * already handed out, and micro-org#373 §6.2 is exactly one of those: a `btc | mainnet`
     * assignment minted on 2026-08-05, before #183 closed, on an estate where nothing followed
     * Bitcoin and nothing could move a satoshi. Auditing it took a psql session and a full
     * `scantxoutset`; nothing said the row existed. It was not alone — one account's scripted run
     * that morning took an address on six chains in three seconds, and three of those (eth, sol,
     * xrp) are still on chains this estate can neither watch nor pay.
     *
     * So the class gets a series rather than the instance getting a note. Non-zero is not
     * automatically a fault — a chain can close after an address was issued, which is an owner's
     * decision — but it is always a number somebody should be able to state, and until now nobody
     * could. `active` assignments only: a rotated or retired address is no longer a promise.
     */
    .register({
      name: 'wallet_deposit_addresses_unretrievable',
      help:
        'Active deposit addresses issued on a chain this deployment states no way to pay out of. ' +
        'Coins sent to them would be held with no withdrawal path. See wallet_chain_retrievable.',
      kind: 'gauge',
      labels: ['chain'],
    })
    /**
     * **Whether this deployment will issue and credit a deposit address on this chain at all** —
     * the one fact behind every refusal on the deposit path, and invisible from outside until now.
     *
     * It is a gauge rather than a config assertion because the answer is MEASURED per deployment —
     * see `observability.ts` on why a second hardcoded list of supported chains is how the estate
     * came to hand out a real Bitcoin address nothing watched.
     *
     * It reports the GATE'S DECISION, not the chain's truth: an indexer this process cannot reach
     * and has no cached answer for reads 0, because 0 is what the deposit path will act on.
     *
     * **Since micro-org#373 §6.1 this is an AND of two independent conditions**, and the help text
     * below used to name only the first. That mattered: an operator who read "1 if the indexer
     * reports a source" off a `chain="btc"` zero would go and look at the indexer, and find nothing
     * wrong with it, because the refusal was a missing `WALLET_FEE_QUOTES` entry. The two
     * conditions each have their own series so the zero can be decomposed without reading source.
     */
    .register({
      name: 'wallet_chain_observable',
      help:
        '1 if this deployment issues and credits deposit addresses on this chain. It is an AND: ' +
        'the indexer reports a source AND a withdrawal of the native asset can be priced. ' +
        'Decompose a 0 with wallet_chain_retrievable and wallet_chain_observability_unknown.',
      kind: 'gauge',
      labels: ['chain'],
    })
    /**
     * **The second half of the gate, and the one an indexer dashboard cannot explain.**
     *
     * `wallet_chain_observable` was the whole gate until micro-org#373 §6.1: adding a scope to the
     * indexer's `INDEXER_CHAINS` opened this service's deposit route for that chain in the same
     * instant, with no second decision anywhere. §6.1 measured what that meant for Bitcoin — a
     * complete PSBT adapter in micro-settlement that could not run against the estate's node — and
     * the repair was a second condition read from `WALLET_FEE_QUOTES`, the table where an operator
     * already states "this estate can pay this asset out".
     *
     * **Positive sense, and deliberately so.** The write this replaces was
     * `wallet_chain_not_retrievable`, and it was never registered here, so `Metrics.set` dropped it
     * on its first line and the series has never appeared on a single scrape — the §6.1 gate has
     * been refusing deposits with no way for an operator to see it since 2.5.18. Renaming it costs
     * nothing precisely because nothing has ever been able to read it. What positive sense buys is
     * that the decomposition reads as written: `observable` is `retrievable` AND an indexer answer,
     * so `retrievable == 1 and observable == 0` names the indexer as the blocker and
     * `retrievable == 0` names the fee table, with no negation to hold in your head.
     *
     * This never consults the indexer. `payableChainsOnly` is the OUTERMOST gate and short-circuits
     * before the request is made, so this series is available even when the indexer is down — which
     * is the moment an operator most needs to know which of the two conditions they are looking at.
     */
    .register({
      name: 'wallet_chain_retrievable',
      help:
        '1 if this deployment states a way to send the chain native asset back out, read from ' +
        'WALLET_FEE_QUOTES; 0 if not, in which case deposits are refused however well the indexer ' +
        'follows the chain. A deposit address is a promise the coins remain retrievable.',
      kind: 'gauge',
      labels: ['chain'],
    })
    /**
     * **Read this BEFORE `wallet_chain_observable`, or read a 0 there as the wrong thing.**
     *
     * A zero on that gauge is either an owner's decision — the indexer follows no source for the
     * chain, which is the steady state for seven of the eight and is not a fault — or a process
     * that has never once obtained an answer and is refusing deposits on that basis, which is. The
     * two need opposite responses and a single 0/1 gauge cannot tell them apart, exactly as
     * `ledger_reconciliation_observed` exists because a drift gauge cannot say "nobody looked".
     */
    .register({
      name: 'wallet_chain_observability_unknown',
      help:
        '1 if this replica has never obtained an observability answer for the chain and is ' +
        'refusing deposits on it for that reason rather than because no source is followed.',
      kind: 'gauge',
      labels: ['chain'],
    })
    .register({
      name: 'wallet_withdrawals_total',
      help: 'Withdrawal requests, by outcome',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'wallet_withdrawals_unreserved',
      help: 'Withdrawals claimed but never reserved. Should be 0.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'wallet_withdrawals_stuck_total',
      help: 'Withdrawals that outlived the settlement deadline',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'wallet_links_verified_total',
      help: 'External wallet links verified, by scheme',
      kind: 'counter',
      labels: ['scheme'],
    })
    .register({
      name: 'wallet_money_operations_total',
      help: 'Spends, transfers and conversions, by route and outcome',
      kind: 'counter',
      labels: ['route', 'outcome'],
    })
    /**
     * What the conversion desk is holding, per asset — micro-org#501. Written from one place,
     * `money.sampleDeskInventory`, called by `beforeScrape` in `index.ts`.
     *
     * **Whole units, not the smallest unit, and that is load-bearing.** A Prometheus sample is a
     * float64 and the desk's EMBER balance is 2.84e22 wei — four orders of magnitude past the last
     * integer a float64 holds exactly. A wei-valued gauge would silently round the input to a
     * threshold. `formatAmount` is the same conversion the admin surface uses, so the gauge and
     * that page cannot disagree about what is in the desk.
     *
     * **An absent series is not a zero.** This can only publish an asset the desk holds a balance
     * row for, so an asset it was never funded in has no series at all and
     * `wallet_desk_inventory < x` never fires for it. `ExchangeDeskInventoryShort` alerts on the
     * REFUSAL instead — the `desk_short` outcome on the counter above, which is emitted whether or
     * not an account exists — and the two rules together cover both shapes.
     *
     * Labelled by asset, unlike the two deposit gauges: the desk is per-asset by construction, the
     * repair differs per asset (each one is funded separately), and the cardinality is the number
     * of assets the desk trades, which is one.
     */
    .register({
      name: 'wallet_desk_inventory',
      help:
        'Conversion desk inventory in whole units, per asset. Falling to 0 means conversions out ' +
        'of that asset start being refused — see micro-org#501.',
      kind: 'gauge',
      labels: ['asset'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 64 * 1024

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

/**
 * Routes that answer without belonging to a network.
 *
 * Kubelet probes the first two and Prometheus scrapes the third; none arrives through the gateway,
 * so none carries `CF-Network`. Refusing them turns a data-isolation rule into a CrashLoopBackOff.
 */
const OPERATIONAL_ROUTES: ReadonlySet<string> = new Set(['/livez', '/readyz', '/metrics'])

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly requestId: string
  readonly log: Logger
  /**
   * The estate this REQUEST belongs to, from the `CF-Network` header the gateway stamped.
   *
   * Not a property of the process: one pod serves both since the network consolidation, so "which
   * estate am I" has no answer.
   */
  readonly network: Network
  /**
   * The handle for `network`, resolved once at the edge.
   *
   * Every route uses this rather than `deps.sql`, which is a `NetworkSql` with no query methods —
   * so the mistake does not compile. In THIS service a wrong handle credits a testnet deposit to a
   * mainnet balance, and the wallet is where a user looks to find out what they own.
   */
  readonly sql: Db
}

interface Route {
  readonly method: string
  /** The declared pattern. Also the metric label, which is why it is stored rather than derived. */
  readonly path: string
  readonly matcher: RegExp
  readonly names: readonly string[]
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote. This is
    // the workflow Lantern already depends on and it must keep working.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'
    const matched = match(routes, method, url.pathname)
    const routeLabel = matched ? matched.route.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number, metricNetwork: string) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
        // One target now serves both estates, so the network has to be on the SERIES. Labelled
        // per target it would say nothing — micro-org#398 in a form nothing could recover.
        network: metricNetwork,
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method,
        route: routeLabel,
        network: metricNetwork,
      })
    }

    // ── THE ESTATE, THEN THE HANDLE, BEFORE ANY ROUTE RUNS ────────────────────────────────────
    //
    // `requestNetwork` REFUSES an unstamped request rather than assuming mainnet. A 500 is a
    // routing fault somebody fixes; a default credits one estate's deposit to the other estate's
    // balance, and the wallet is precisely where a user goes to find out what they own.
    const networkless = matched !== null && OPERATIONAL_ROUTES.has(matched.route.path)
    let network: Network
    try {
      network = networkless
        ? (deps.singleNetwork ?? deps.sql.networks[0] ?? 'mainnet')
        : requestNetwork(req.headers, deps.singleNetwork ? { fallback: deps.singleNetwork } : {})
    } catch (err) {
      log.error('request carries no usable network', {
        err: err instanceof NetworkUnknownError ? err.message : err,
      })
      send(res, errorReply(500, 'network_unknown', 'this request could not be attributed to a network', requestId), requestId)
      finish(500, 'unknown')
      return
    }
    // ── RESOLVED INSIDE A TRY, AND THAT IS NOT DEFENSIVE PADDING ───────────────────────────────
    //
    // `deps.sql.for()` THROWS when this deployment holds no handle for that network, and that
    // refusal is the safety property the consolidation rests on — better a loud 500 than a query
    // answered out of the other estate's rows.
    //
    // It runs BEFORE `handle` returns a promise, so an uncaught throw escapes the `void` expression
    // past a `.catch` that is not attached yet, and the listener returns having sent NOTHING. The
    // connection then hangs until the client gives up: the one path the design most depends on
    // being loud was the one path that was silent.
    let sql: Db
    try {
      sql = deps.sql.for(network) as unknown as Db
    } catch (err) {
      log.error('no usable database handle for this request', { err, network })
      send(
        res,
        errorReply(500, 'network_unavailable', 'this deployment cannot serve that network', requestId),
        requestId,
      )
      finish(500, network)
      return
    }

    void handle(
      matched,
      { req, url, params: matched?.params ?? {}, requestId, log, network, sql },
      forRequest(deps, network, sql),
    )
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status, network)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500, network)
      })
  })
}

/**
 * Map every failure onto a status.
 *
 * Grouped by what the caller should do about it, which is the only grouping that helps at the
 * other end of the wire:
 *
 *   * **400** — the request could not be acted on. Fix it; retrying will not help. A missing
 *     idempotency key is here, deliberately: it is a client bug and answering 200 by doing the
 *     work anyway is how a retry double-debits.
 *   * **403** — authenticated, but this authority is missing. An unverified withdrawal
 *     destination is here.
 *   * **409** — well formed, but the state refuses it: insufficient funds, a key reused with a
 *     different body, an illegal state transition.
 *   * **501** — a real feature of the model this build cannot perform. Never faked.
 *   * **503** — an upstream did not answer, or a fee could not be quoted. Retriable.
 */
/**
 * The deps a REQUEST sees: the estate, and all four domain bundles against its handle.
 *
 * Every one of them carries a pool reference, so rebuilding one and not the others would leave a
 * deposit credited in one estate and a balance read from the other — which is worse than either
 * mistake alone, because the two would disagree and neither would look wrong on its own.
 */
function forRequest(deps: ServerDeps, network: Network, sql: Db): ServerDeps {
  return {
    ...deps,
    network,
    deposits: { ...deps.deposits, sql },
    withdrawals: { ...deps.withdrawals, sql },
    money: { ...deps.money, sql },
    portfolio: { ...deps.portfolio, sql },
  }
}

async function handle(
  matched: { route: Route; params: Record<string, string> } | null,
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<Reply> {
  if (!matched) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await matched.route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }

    if (err instanceof IdempotencyKeyRequiredError) {
      return errorReply(400, 'idempotency_key_required', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyKeyReuseError) {
      return errorReply(409, 'idempotency_key_reuse', err.message, ctx.requestId)
    }
    if (err instanceof IdempotencyInFlightError) {
      return errorReply(409, 'idempotency_in_flight', err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof AddressError) {
      return errorReply(422, 'invalid_address', err.message, ctx.requestId)
    }
    if (
      err instanceof WalletError ||
      err instanceof LinkError ||
      err instanceof DepositError ||
      err instanceof WithdrawalError ||
      err instanceof MoneyError
    ) {
      const status = 'status' in err && typeof err.status === 'number' ? err.status : 400
      if (status >= 500) ctx.log.error('request refused by a store', { err })
      return errorReply(status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof LedgerRefusedError) {
      // The ledger looked at it and said no. Shown to the user, never retried.
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof LedgerUnavailableError) {
      // We do not know whether it posted. 503 tells the caller to retry with the same key, which
      // is the only safe instruction.
      ctx.log.error('ledger unavailable', { err })
      return errorReply(503, 'ledger_unavailable', 'the ledger is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof CustodyRefusedError) {
      // ────────────────────────────────────────────────────────────────────────────────────────
      // NEITHER CUSTODY ERROR WAS CAUGHT ANYWHERE, SO POST /v1/deposits ANSWERED 500 — AND DID SO
      // ON THE LIVE ESTATE. Both are thrown by `custodyclient.ts` and both fell through to the
      // generic branch below. They are wrong as a 500 in different ways, which is why they are
      // two branches and not one.
      //
      // This one is a decision: custody read the request and said no. Shown and never retried,
      // the same treatment `LedgerRefusedError` gets four lines above — one upstream, one rule.
      //
      // 401 and 403 are the exception, and they are not this caller's to answer for. Custody
      // gates /v1/addresses on `custody:address:create` (`CUSTODY_SCOPES`), so a refusal there is
      // THIS service's token failing. Passing it through tells a user whose own token is
      // perfectly good that they are no longer authenticated, and their client signs them out —
      // rule 3 at the head of this file, one hop further out. Address issuance genuinely is not
      // working, so that is what is reported.
      // ────────────────────────────────────────────────────────────────────────────────────────
      if (err.status === 401 || err.status === 403) {
        ctx.log.error('custody refused this service’s own credential', { err })
        return errorReply(503, 'custody_unavailable', 'address issuance is temporarily unavailable', ctx.requestId)
      }
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof CustodyUnavailableError) {
      // Not a decision: we do not know whether an address was minted. A retry is safe because
      // `assignDepositAddress` looks for an active assignment first, so the second attempt only
      // reaches custody if the first left no row — NOT because the idempotency key dedupes, which
      // this comment used to claim. Custody has no idempotency handling at all
      // (`custody/src/keys.ts` mints unconditionally); the header is sent so that it works the
      // day custody honours it, and until then the row check is the whole guarantee.
      ctx.log.error('custody unavailable', { err })
      return errorReply(503, 'custody_unavailable', 'address issuance is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof CustodyContractError) {
      // Custody answered, and this service could not read the answer. Neither of the two above:
      // not a refusal, because nothing was refused; not an outage, because a retry produces the
      // identical unreadable reply. 502 — the upstream's answer was invalid — and the detail stays
      // in the log, because "custody sent a body we do not understand" is an operator's sentence.
      ctx.log.error('custody answered in a shape this service cannot read', { err })
      return errorReply(502, 'custody_contract', 'address issuance is temporarily unavailable', ctx.requestId)
    }

    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

/* ------------------------------------------------------------------ routing */

function compile(path: string): { matcher: RegExp; names: string[] } {
  const names: string[] = []
  const pattern = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(segment.slice(1))
      // One segment, never empty, never a slash — so a parameter cannot swallow the rest of the
      // path and make one route answer for another.
      return '([^/]+)'
    })
    .join('/')
  return { matcher: new RegExp(`^${pattern}$`), names }
}

function match(
  routes: readonly Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue
    const found = route.matcher.exec(pathname)
    if (!found) continue
    const params: Record<string, string> = {}
    route.names.forEach((name, index) => {
      const value = found[index + 1]
      if (value !== undefined) params[name] = decodeURIComponent(value)
    })
    return { route, params }
  }
  return null
}

function route(
  method: string,
  path: string,
  handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
): Route {
  const { matcher, names } = compile(path)
  return { method, path, matcher, names, handle: handler }
}

function buildRoutes(): Route[] {
  return [
    route('GET', '/livez', async (_ctx, deps) => ({
      status: 200,
      /**
       * Static, deliberately. Liveness answers one question — should this process be killed and
       * restarted — and a liveness probe that consults a dependency restarts a healthy process
       * every time the database blinks, turning a brief outage into a rolling restart of the whole
       * estate. Readiness is where dependencies belong.
       */
      body: deps.lifecycle.livez(),
    })),

    route('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      // 503 is what removes this replica from the balancer. A soft probe failure leaves the report
      // degraded but still ready, because taking a whole product out of rotation over a
      // non-essential upstream is worse than serving without it.
      return { status: report.ready ? 200 : 503, body: report }
    }),

    route('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // A gauge that could not be sampled is a stale gauge. Failing the scrape instead would
        // lose every other metric too, and blind the dashboard at the moment it is needed.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    route('POST', '/events', handleEvent),

    /* --------------------------------------------------------------- wallets */

    route('GET', '/v1/wallets', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const page = await listWallets(deps.portfolio.sql, {
        userId,
        limit: limitFrom(ctx),
        ...cursorFrom(ctx),
        ...(ctx.url.searchParams.get('origin')
          ? { origin: ctx.url.searchParams.get('origin') as WalletOrigin }
          : {}),
        includeRetired: ctx.url.searchParams.get('includeRetired') === 'true',
      })
      return { status: 200, body: page }
    }),

    /**
     * Register an external or watch address.
     *
     * `external` issues a challenge and leaves the wallet `provisioning`. `watch` does not, and
     * that asymmetry is the whole of §3.2's invariant: a watch wallet has no link, so
     * `authorisationHolds` is false for it by construction and it can never be a withdrawal
     * destination.
     */
    route('POST', '/v1/wallets', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, optionalString(body, 'userId'))
      const chain = requireChainField(body)
      const origin = requireString(body, 'origin')
      if (origin !== 'external' && origin !== 'watch') {
        throw new BadRequestError('invalid_origin', 'origin must be external or watch')
      }
      // A managed wallet is never created through this route: it is created by the deposit
      // assignment path, which is the only place a custody key is minted. Accepting `managed`
      // here would let a caller claim the platform holds a key it does not.

      const done = deps.lifecycle.track()
      try {
        const result = await createChallenge(deps.portfolio.sql, deps.deposits.producer, {
          userId,
          chain,
          // From configuration, never from the body. See env.ts: a caller naming the network is
          // what makes the other network's balance reachable at all.
          network: deps.network,
          address: requireString(body, 'address'),
          label: optionalString(body, 'label') ?? null,
          origin,
          domain: deps.challengeDomain,
          uri: deps.challengeUri,
          ttlSeconds: deps.challengeTtlSeconds,
          ...(optionalString(body, 'statement') !== undefined
            ? { statement: optionalString(body, 'statement')! }
            : {}),
          correlationId: ctx.requestId,
        })
        return { status: 201, body: result }
      } finally {
        done()
      }
    }),

    route('GET', '/v1/wallets/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const wallet = await findWallet(deps.portfolio.sql, ctx.params['id'] ?? '')
      if (!wallet) throw new BadRequestError('wallet_not_found', 'no such wallet', 404)
      assertOwner(principal, wallet.userId, requestedUser(ctx))
      const link = await readLink(deps.portfolio.sql, wallet.id)
      return { status: 200, body: { wallet, link } }
    }),

    route('PATCH', '/v1/wallets/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, WRITE_SCOPE)
      const id = ctx.params['id'] ?? ''
      // The body is read before the row, because it carries the subject a service principal must
      // name for `assertOwner` to have anything to check against.
      const body = await readJson(ctx.req)
      const wallet = await findWallet(deps.portfolio.sql, id)
      if (!wallet) throw new BadRequestError('wallet_not_found', 'no such wallet', 404)
      assertOwner(principal, wallet.userId, optionalString(body, 'userId') ?? requestedUser(ctx))

      let updated = wallet
      if ('label' in body) updated = await relabelWallet(deps.portfolio.sql, id, optionalString(body, 'label') ?? null)
      if (body['isPrimary'] === true) updated = await setPrimary(deps.portfolio.sql, id)
      if (typeof body['status'] === 'string') {
        updated = await transitionWallet(deps.portfolio.sql, id, settableStatus(body['status']), {
          actor: actorOf(principal),
          // Required, and 400 without it. A freeze that nobody can attribute to a decision is one
          // no reviewer can defend and no operator can safely lift.
          reason: requireString(body, 'reason'),
        })
      }
      return { status: 200, body: { wallet: updated } }
    }),

    /** Submit a signature over an issued challenge. */
    route('POST', '/v1/wallets/verify', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, optionalString(body, 'userId'))
      const authorisations = readAuthorisations(body)

      const done = deps.lifecycle.track()
      try {
        const link = await verifyChallenge(deps.portfolio.sql, deps.deposits.producer, {
          userId,
          nonce: requireString(body, 'nonce'),
          signature: requireString(body, 'signature'),
          expectedDomain: deps.challengeDomain,
          expectedUri: deps.challengeUri,
          correlationId: ctx.requestId,
          ...(authorisations.length > 0 ? { authorisations } : {}),
        })
        deps.metrics.increment('wallet_links_verified_total', { scheme: link.scheme })
        ctx.log.info('external wallet link verified', {
          walletId: link.walletId,
          scheme: link.scheme,
          authorisations: link.authorisations,
        })
        return { status: 200, body: { link } }
      } finally {
        done()
      }
    }),

    route('POST', '/v1/wallets/:id/authorisations', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, WRITE_SCOPE)
      const id = ctx.params['id'] ?? ''
      const body = await readJson(ctx.req)
      const wallet = await findWallet(deps.portfolio.sql, id)
      if (!wallet) throw new BadRequestError('wallet_not_found', 'no such wallet', 404)
      assertOwner(principal, wallet.userId, optionalString(body, 'userId') ?? requestedUser(ctx))

      const authorisation = requireString(body, 'authorisation')
      if (!isAuthorisation(authorisation)) {
        throw new BadRequestError('unknown_authorisation', `not an authorisation: ${authorisation}`)
      }
      const link = await grantAuthorisation(
        deps.portfolio.sql,
        id,
        authorisation,
        actorOf(principal),
      )
      return { status: 200, body: { link } }
    }),

    route('DELETE', '/v1/wallets/:id/authorisations/:authorisation', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, WRITE_SCOPE)
      const id = ctx.params['id'] ?? ''
      const wallet = await findWallet(deps.portfolio.sql, id)
      if (!wallet) throw new BadRequestError('wallet_not_found', 'no such wallet', 404)
      assertOwner(principal, wallet.userId, requestedUser(ctx))

      const raw = ctx.params['authorisation'] ?? ''
      // `all` is "disconnect this wallet": revoke every authorisation and the link itself, in one
      // transaction, per §3.2.
      const authorisation: Authorisation | null = raw === 'all' ? null : (raw as Authorisation)
      if (authorisation !== null && !isAuthorisation(authorisation)) {
        throw new BadRequestError('unknown_authorisation', `not an authorisation: ${raw}`)
      }
      const link = await revokeAuthorisation(deps.portfolio.sql, deps.deposits.producer, {
        walletId: id,
        userId: wallet.userId,
        authorisation,
        by: actorOf(principal),
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { link } }
    }),

    /* --------------------------------------------------------------- deposits */

    route('POST', '/v1/deposits', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, optionalString(body, 'userId'))
      const done = deps.lifecycle.track()
      try {
        const assignment = await assignDepositAddress(deps.deposits, {
          userId,
          assetCode: requireString(body, 'assetCode'),
          correlationId: ctx.requestId,
          // A rotation is an explicit ask. Defaulting to it would mint a new address on every
          // page load and leave a trail of addresses nobody was told about.
          ...(body['rotate'] === true ? { rotate: true } : {}),
        })
        return { status: 201, body: { assignment } }
      } finally {
        done()
      }
    }),

    /**
     * What this deployment can take a deposit in, right now — **and what it cannot, and why.**
     *
     * Read-scope and not user-specific: the answer is a property of the estate, not of an account.
     * It exists so a client never has to guess — Receive used to build its menu from the caller's
     * HOLDINGS, which made a new asset unreachable, because you could only receive what you already
     * had.
     *
     * Every asset in `ON_CHAIN_ASSETS` is listed, including the ones on offer nowhere: a row carries
     * `depositable`, the machine word `reason`, and since micro-org#481 a `detail` sentence that is
     * the SAME string `POST /v1/deposits` raises as its 503 message for that asset. A consumer that
     * drops the refused rows — `hub-web` filters on `depositable` — is why the owner reported seeing
     * no Dogecoin anywhere in the wallet while this route had been answering with a DOGE row all
     * along. `detail` exists so rendering that row costs a client no prose of its own.
     */
    route('GET', '/v1/deposits/assets', async (ctx, deps) => {
      await authenticate(ctx, deps, READ_SCOPE)
      const assets = await depositableAssets(deps.deposits)
      return { status: 200, body: { assets, network: deps.network } }
    }),

    route('GET', '/v1/deposits', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const assignments = await listAssignments(deps.portfolio.sql, userId, deps.network)
      return { status: 200, body: { assignments } }
    }),

    route('GET', '/v1/deposits/credits', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const page = await listCredits(
        deps.portfolio.sql,
        userId,
        limitFrom(ctx),
        ctx.url.searchParams.get('cursor'),
      )
      return { status: 200, body: page }
    }),

    /**
     * Token transfers that arrived at this user's deposit addresses and were **not credited**.
     *
     * micro-org#200. A separate route from `/v1/deposits/credits` on purpose: those rows are money
     * in the user's balance and these are money that is not, and the two must not arrive in one
     * list to be told apart by a flag. Every row here says `credited: false` and carries no
     * formatted amount, because the token's decimals are not something this service has a source
     * for — see `listTokenSightings`.
     */
    route('GET', '/v1/deposits/token-sightings', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const page = await listTokenSightings(
        deps.portfolio.sql,
        userId,
        limitFrom(ctx),
        ctx.url.searchParams.get('cursor'),
      )
      return { status: 200, body: page }
    }),

    /* --------------------------------------------------------------- withdrawals */

    route('POST', '/v1/withdrawals', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, MONEY_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, optionalString(body, 'userId'))
      const clientKey = requireIdempotencyKey(
        'POST /v1/withdrawals',
        idempotencyKeyOf(ctx, body),
      )

      const done = deps.lifecycle.track()
      try {
        const result = await requestWithdrawal(deps.withdrawals, {
          userId,
          assetCode: requireString(body, 'assetCode'),
          destination: requireString(body, 'destination'),
          amount: requireAmount(body, 'amount'),
          clientKey,
          correlationId: ctx.requestId,
          actor: actorOf(principal),
        })
        deps.metrics.increment('wallet_withdrawals_total', {
          outcome: result.replayed ? 'replayed' : result.withdrawal.state,
        })
        ctx.log.info('withdrawal requested', {
          withdrawalId: result.withdrawal.id,
          state: result.withdrawal.state,
          assetCode: result.withdrawal.assetCode,
          replayed: result.replayed,
        })
        // 200 on a replay, 201 on a fresh request: the caller can tell whether its retry did the
        // work or merely found it done, without comparing bodies.
        return { status: result.replayed ? 200 : 201, body: result }
      } catch (err) {
        deps.metrics.increment('wallet_withdrawals_total', { outcome: 'refused' })
        throw err
      } finally {
        done()
      }
    }),

    route('GET', '/v1/withdrawals', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const page = await listWithdrawals(
        deps.portfolio.sql,
        userId,
        limitFrom(ctx),
        ctx.url.searchParams.get('cursor'),
      )
      return { status: 200, body: page }
    }),

    route('GET', '/v1/withdrawals/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const withdrawal = await findWithdrawal(deps.portfolio.sql, ctx.params['id'] ?? '')
      if (!withdrawal) throw new BadRequestError('withdrawal_not_found', 'no such withdrawal', 404)
      assertOwner(principal, withdrawal.userId, requestedUser(ctx))
      return { status: 200, body: { withdrawal } }
    }),

    /* --------------------------------------------------------------- money */

    route('POST', '/v1/spend', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, MONEY_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, optionalString(body, 'userId'))
      // **The line this whole service exists to add.** forge-pay's /spend accepts a missing key.
      const clientKey = requireIdempotencyKey('POST /v1/spend', idempotencyKeyOf(ctx, body))

      const done = deps.lifecycle.track()
      try {
        const result = await spend(deps.money, {
          userId,
          amount: requireAmount(body, 'amount'),
          reason: requireString(body, 'reason'),
          clientKey,
          correlationId: ctx.requestId,
          actor: actorOf(principal),
          // OPTIONAL, defaulting to EMBER inside `spend`. A caller that names a retired asset is
          // refused HERE, with a 400 naming the asset, rather than reaching the ledger and getting
          // its trigger's message — the two are the same refusal and only one of them tells the
          // caller which field to change.
          ...issuableAsset(optionalString(body, 'assetCode')),
        })
        deps.metrics.increment('wallet_money_operations_total', {
          route: 'spend',
          outcome: result.replayed ? 'replayed' : 'posted',
        })
        return { status: result.replayed ? 200 : 201, body: result }
      } finally {
        done()
      }
    }),

    route('POST', '/v1/transfers', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, MONEY_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, optionalString(body, 'userId'))
      const clientKey = requireIdempotencyKey('POST /v1/transfers', idempotencyKeyOf(ctx, body))

      const done = deps.lifecycle.track()
      try {
        const result = await transfer(deps.money, {
          userId,
          toUserId: requireString(body, 'toUserId'),
          assetCode: requireString(body, 'assetCode'),
          amount: requireAmount(body, 'amount'),
          clientKey,
          correlationId: ctx.requestId,
          actor: actorOf(principal),
        })
        deps.metrics.increment('wallet_money_operations_total', {
          route: 'transfer',
          outcome: result.replayed ? 'replayed' : 'posted',
        })
        return { status: result.replayed ? 200 : 201, body: result }
      } finally {
        done()
      }
    }),

    route('POST', '/v1/conversions', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, MONEY_SCOPE)
      const body = await readJson(ctx.req)
      const userId = subjectUserId(principal, optionalString(body, 'userId'))
      const clientKey = requireIdempotencyKey('POST /v1/conversions', idempotencyKeyOf(ctx, body))

      const done = deps.lifecycle.track()
      try {
        const result = await convert(deps.money, {
          userId,
          fromAssetCode: requireString(body, 'fromAssetCode'),
          toAssetCode: requireString(body, 'toAssetCode'),
          amount: requireAmount(body, 'amount'),
          clientKey,
          correlationId: ctx.requestId,
          actor: actorOf(principal),
        })
        deps.metrics.increment('wallet_money_operations_total', {
          route: 'conversion',
          outcome: result.replayed ? 'replayed' : 'posted',
        })
        return { status: result.replayed ? 200 : 201, body: result }
      } catch (err) {
        /**
         * micro-org#501. An empty desk was the ONE outcome of this route that nothing counted.
         * `convert` throws `desk_inventory_short` before the increment above, so a desk that had
         * run dry produced a 409 to the user and complete silence to the estate — no series moved,
         * and `wallet_desk_inventory` cannot cover it either, because an asset the desk holds no
         * account in has no balance row and therefore no series at all.
         *
         * Only this one code is caught and re-thrown. A blanket `outcome: 'failed'` here would fold
         * a user's own shortfall, a bad asset code and a pricing outage into the series an operator
         * would page on, and the alert would then fire for four reasons with one repair listed.
         *
         * The ASSET is not a label. Which asset the desk is out of is the same trading signal the
         * 409's wording withholds, and `/metrics` is only unpublished today — one gateway route
         * away from being the disclosure the refusal refuses. The operator learns which asset from
         * `wallet_desk_inventory` and from the admin route, both of which are already gated.
         */
        if (err instanceof MoneyError && err.code === 'desk_inventory_short') {
          deps.metrics.increment('wallet_money_operations_total', {
            route: 'conversion',
            outcome: 'desk_short',
          })
        }
        throw err
      } finally {
        done()
      }
    }),

    /**
     * What a conversion would come to, without making one.
     *
     * `MONEY_SCOPE` rather than `READ_SCOPE`, and it is a POST rather than a GET, for the same
     * reason: this is not a read of this service's state, it is the front half of the conversion —
     * the same validation, the same pricing upstream, the same refusals — with the booking left
     * off. A service that may not convert has no business asking the platform to quote it a market,
     * and a caller that has this may as well be told the figures before it commits to them.
     *
     * No idempotency key, because nothing is claimed. `hold: false` and `holdNotice` in the body
     * say that in a field a surface can render, which is the whole point of them being fields.
     */
    route('POST', '/v1/conversions/quote', async (ctx, deps) => {
      await authenticate(ctx, deps, MONEY_SCOPE)
      const body = await readJson(ctx.req)
      const done = deps.lifecycle.track()
      try {
        const quote = await quoteConversion(deps.money, {
          fromAssetCode: requireString(body, 'fromAssetCode'),
          toAssetCode: requireString(body, 'toAssetCode'),
          amount: requireAmount(body, 'amount'),
        })
        return { status: 200, body: { quote } }
      } finally {
        done()
      }
    }),

    /**
     * This user's conversions, newest first — read out of the journal, not out of a local table.
     *
     * micro-org#495 §3, and the header of `money.ts`'s reading section has the argument: the entry
     * IS the conversion, and a wallet-side copy would be a second record of one fact, written in a
     * second transaction, free to disagree with the first in a way the surface could not see.
     */
    route('GET', '/v1/conversions', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const done = deps.lifecycle.track()
      try {
        const page = await listConversions(deps.money, {
          userId,
          limit: limitFrom(ctx),
          ...cursorFrom(ctx),
        })
        return { status: 200, body: page }
      } finally {
        done()
      }
    }),

    /**
     * One conversion, by the id of the journal entry that is it.
     *
     * **404 for somebody else's, not 403.** `readConversion` returns null for "no such entry", "not
     * a conversion" and "not yours" alike, and this route cannot tell them apart either — which is
     * deliberate, because a 403 on an id that exists and a 404 on one that does not is an oracle
     * that turns this route into a way of enumerating other people's entry ids.
     */
    route('GET', '/v1/conversions/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const done = deps.lifecycle.track()
      try {
        const conversion = await readConversion(deps.money, {
          userId,
          entryId: ctx.params['id'] ?? '',
        })
        if (!conversion) {
          throw new BadRequestError('conversion_not_found', 'no such conversion', 404)
        }
        return { status: 200, body: { conversion } }
      } finally {
        done()
      }
    }),

    /**
     * This user's transfers, sent and received, newest first.
     *
     * Same source and same reason as `/v1/conversions`. Both ends are here rather than only the
     * sent ones: the ledger's subject filter returns an ENTRY that touches this user's account
     * whichever side of it they were on, and a "transfers" list missing what somebody was sent
     * would be a strange thing to hand a person looking for money a friend says they sent.
     */
    route('GET', '/v1/transfers', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const done = deps.lifecycle.track()
      try {
        const page = await listTransfers(deps.money, {
          userId,
          limit: limitFrom(ctx),
          ...cursorFrom(ctx),
        })
        return { status: 200, body: page }
      } finally {
        done()
      }
    }),

    /* --------------------------------------------------------------- the exchange desk */

    /*
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * BOTH DESK ROUTES ARE `requireAdmin`, AND THAT IS A DIFFERENT GATE FROM A SERVICE SCOPE.
     *
     * micro-org#495 §2 asked for the role and not a scope, and the difference is exactly the one
     * `assertOwner` spends a paragraph on: a scope is an authority a SERVICE token carries, and
     * granting `wallet:money` to a service that needed it for one purpose would hand it the desk's
     * inventory as well. `requireAdmin` is `principal.kind === 'user' && roles.includes('admin')`,
     * so **every service principal is refused here whatever it holds** — funding the desk is an
     * operator's decision, made by a person who can be asked why, and there is no automation in
     * this estate that should be moving the platform's own stock on its own initiative.
     *
     * The scope passed to `authenticate` is therefore unreachable rather than redundant: a service
     * that satisfies it still fails the next line. It is stated anyway so that these routes read
     * like every other one in this file and so the scope catalogue stays true.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */

    /**
     * What the desk is holding, per asset.
     *
     * The figure IS returned here, unlike in the `desk_inventory_short` a user gets — the audience
     * is an operator deciding whether to fund it, not an anonymous caller who would be handed a
     * trading signal for the price of one request. See `deskInventory`.
     */
    route('GET', '/v1/admin/exchange-desk', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      requireAdmin(principal)
      const done = deps.lifecycle.track()
      try {
        const inventory = await deskInventory(deps.money)
        return { status: 200, body: { subject: DESK_SUBJECT, inventory } }
      } finally {
        done()
      }
    }),

    /**
     * Put stock into the desk, or take it back out.
     *
     * `direction: 'in' | 'out'` on the one route is the reversing sibling §2 asks for. A separate
     * un-funding route would have been a second code path for the same two postings with their ends
     * swapped, and the day an operator needed it would have been the day it was found not to work;
     * this way the reversal is exercised by the same tests, carries the same idempotency key
     * discipline and the same recorded `reason`, and is refused by the ledger if it would draw the
     * inventory below zero.
     */
    route('POST', '/v1/admin/exchange-desk/funding', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, MONEY_SCOPE)
      requireAdmin(principal)
      const body = await readJson(ctx.req)
      const clientKey = requireIdempotencyKey(
        'POST /v1/admin/exchange-desk/funding',
        idempotencyKeyOf(ctx, body),
      )

      const done = deps.lifecycle.track()
      try {
        const result = await fundDesk(deps.money, {
          // The OPERATOR, not a user the request names. The desk belongs to nobody, so the
          // idempotency key is namespaced by whoever asked — see `RunInput.userId`.
          adminUserId: subjectUserId(principal),
          sourceAccount: requireString(body, 'sourceAccount'),
          assetCode: requireString(body, 'assetCode'),
          amount: requireAmount(body, 'amount'),
          reason: requireString(body, 'reason'),
          direction: fundingDirection(body),
          clientKey,
          correlationId: ctx.requestId,
          actor: actorOf(principal),
        })
        deps.metrics.increment('wallet_money_operations_total', {
          route: 'desk_funding',
          outcome: result.replayed ? 'replayed' : 'posted',
        })
        ctx.log.info('exchange desk funded', {
          entryId: result.entryId,
          replayed: result.replayed,
          ...result.summary,
        })
        return { status: result.replayed ? 200 : 201, body: result }
      } finally {
        done()
      }
    }),

    /* --------------------------------------------------------------- portfolio */

    route('GET', '/v1/portfolio', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, READ_SCOPE)
      const userId = actingUser(ctx, principal)
      const done = deps.lifecycle.track()
      try {
        const portfolio = await readPortfolio(deps.portfolio, {
          userId,
          limit: limitFrom(ctx),
          ...cursorFrom(ctx),
        })
        return { status: 200, body: portfolio }
      } finally {
        done()
      }
    }),
  ]
}

/* ------------------------------------------------------------------ events */

/**
 * The event intake.
 *
 * Authenticated by the MAC the producing service's relay put on the exact bytes it sent, and
 * **verified before the body is parsed**. That ordering is the point: an unauthenticated body
 * never reaches a JSON parser, let alone the crediting path. `readRaw` decodes the request ONCE
 * and the same string is handed to `verifyDelivery` and to `JSON.parse` — verifying one string
 * and parsing another is how an implementation drifts towards acting on something other than what
 * it authenticated.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS READ `x-cloudsforge-signature` AND NOTHING ELSE, AND SO IT REFUSED EVERY PRODUCER.**
 *
 * Indexer, settlement, ledger and identity all sign with the contract's `signDelivery` —
 * `t=<seconds>,v1=<hmac over "seconds.body">` under `cf-signature` — and this service was the
 * estate's last verifier of the old `sha256=<hex>` scheme. Measured against the running estate
 * before the change: a correctly contract-signed deposit envelope answered `401 bad_signature`
 * and the legacy MAC answered 200. So no deposit confirmation and no settlement outcome could
 * reach this service at all, while `/livez` stayed green and the producers' relays retried for
 * ever.
 *
 * The old scheme is not kept as a second arm. It covers the body ALONE with no timestamp, which
 * makes any captured POST to a route that CREDITS MONEY a permanent forgery credential; the
 * freshness window `verifyDelivery` enforces is the entire reason to move. `micro-settlement`
 * kept a metered arm because producers still used it — none remain here, so an arm would preserve
 * that credential for nobody. `micro-admin-api` removed the same shape from its audit intake.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A topic this service does not subscribe to is a 202 rather than a 404. The relay treats any
 * non-2xx as a delivery failure and retries it for ever, so answering 404 to an event we do not
 * want would pin a subscriber in a permanent retry loop over something neither side is wrong
 * about.
 */
async function handleEvent(ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  const raw = await readRaw(ctx.req)
  const presented = headerOf(ctx.req, SIGNATURE_HEADER)
  const verification = presented
    ? verifyDelivery(raw, presented, deps.eventSigningSecret)
    : ({ ok: false, reason: 'malformed_header' } as const)
  if (!verification.ok) {
    // The reason is logged and never returned: telling a prober "stale" rather than "mismatch"
    // tells them which half of a forgery to fix.
    ctx.log.warn('event rejected: bad signature', {
      eventId: headerOf(ctx.req, EVENT_ID_HEADER),
      reason: verification.reason,
    })
    return errorReply(401, 'bad_signature', 'the event signature did not verify', ctx.requestId)
  }
  if (verification.keyIndex > 0) {
    // Still accepting a rotated-out secret. Not an error; a countdown.
    ctx.log.warn('event signed with a superseded secret', { keyIndex: verification.keyIndex })
  }

  let envelope: { id?: unknown; topic?: unknown; payload?: unknown }
  try {
    envelope = JSON.parse(raw) as typeof envelope
  } catch {
    return errorReply(400, 'bad_body', 'the event body is not valid JSON', ctx.requestId)
  }
  const eventId = typeof envelope.id === 'string' ? envelope.id : null
  const topic = typeof envelope.topic === 'string' ? envelope.topic : null
  if (!eventId || !topic) {
    return errorReply(400, 'bad_envelope', 'an event needs an id and a topic', ctx.requestId)
  }
  const payload = (envelope.payload ?? {}) as Record<string, unknown>

  const done = deps.lifecycle.track()
  try {
    if (topic === INDEXER_DEPOSIT_CONFIRMED) {
      const decision = await handleDepositConfirmed(deps.deposits, {
        eventId,
        topic,
        payload: payload as unknown as DepositEventPayload,
        correlationId: ctx.requestId,
      })
      deps.metrics.increment('wallet_deposit_credits_total', {
        outcome: decision.kind === 'ignored' ? `ignored:${decision.reason}` : decision.kind,
      })
      ctx.log.info('deposit event handled', { eventId, decision })
      return { status: 200, body: { handled: true, decision } }
    }

    if (topic === SETTLEMENT_CONFIRMED) {
      const withdrawal = await settleWithdrawal(deps.withdrawals, {
        withdrawalId: String(payload['withdrawalId'] ?? ''),
        txHash: String(payload['txHash'] ?? ''),
        correlationId: ctx.requestId,
        actor: `service:${deps.deposits.producer}`,
      })
      return { status: 200, body: { handled: true, state: withdrawal.state } }
    }

    if (topic === SETTLEMENT_FAILED) {
      const withdrawal = await failWithdrawal(deps.withdrawals, {
        withdrawalId: String(payload['withdrawalId'] ?? ''),
        reason: String(payload['reason'] ?? 'settlement failed'),
        // Defaults to **not** refundable. "We do not know" must never refund: refunding a payment
        // that actually landed pays the user twice, and that error cannot be undone.
        refundable: payload['refundable'] === true,
        correlationId: ctx.requestId,
        actor: `service:${deps.deposits.producer}`,
      })
      return { status: 200, body: { handled: true, state: withdrawal.state } }
    }

    ctx.log.info('event ignored: not a subscribed topic', { topic, eventId })
    return { status: 202, body: { handled: false, reason: 'topic_not_subscribed' } }
  } finally {
    done()
  }
}

/* ------------------------------------------------------------------ auth */

/**
 * Authenticate, and check the scope a service token needs.
 *
 * A user token is accepted on every route here — unlike the ledger, this **is** the user-facing
 * surface. What a user token cannot do is act for somebody else: `subjectUserId` throws
 * `ForbiddenError` if it tries, and an admin role is the only exception.
 */
async function authenticate(
  ctx: RequestContext,
  deps: ServerDeps,
  scope: string,
): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  const principal = await deps.verifier.principal(token)
  if (principal.kind === 'service') requireScope(principal, scope)
  return principal
}

/** The user a read acts for: a service or an admin may name one, a user is itself. */
function actingUser(ctx: RequestContext, principal: Principal): string {
  const requested = ctx.url.searchParams.get('userId') ?? undefined
  if (isAdmin(principal) && requested) return requested
  return subjectUserId(principal, requested)
}

/**
 * The gate on a route keyed by a row id rather than by a user id.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A SERVICE PRINCIPAL USED TO PASS THIS UNCONDITIONALLY, WHICH MADE `wallet:write` ESTATE-WIDE.**
 *
 * The scope catalogue defines `wallet:write` as "mutate non-monetary wallet state **for a named
 * user**". This function is the code that enforces the named-user half, and `principal.kind ===
 * 'service'` returned early before it enforced anything — so any service holding the scope could
 * mutate any user's wallet, on any of the routes below, with no reason recorded and nothing told
 * to the owner. Measured against the running mainnet estate at the time: no service was granted
 * `wallet:write` at all, so nothing could reach it. That is why it was worth closing then — the
 * next grant would have acquired the authority silently, and whoever made it would read the scope
 * description rather than this function.
 *
 * A service now passes only by NAMING the user it acts for, which is `subjectUserId`'s contract and
 * the same thing every user-keyed route in this file already requires of it. `requested` comes from
 * the body where the route reads one and from `?userId=` where it does not.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An admin role still passes, unchanged: an operator acting across accounts is the exception the
 * role exists to express, and it is a role a person holds rather than a credential a service mints.
 */
function assertOwner(principal: Principal, ownerUserId: string, requested?: string): void {
  if (isAdmin(principal)) return
  if (principal.kind === 'service' && requested === undefined) {
    // 403 rather than the 401 `subjectUserId` would raise here. The token is perfectly good; what
    // is missing is the subject, and answering 401 tells a service whose credential is fine that
    // its credential is not — the same mistake `statusFor` exists to stop making one hop out.
    throw new ForbiddenError('a named user: this route acts on one user’s wallet')
  }
  if (subjectUserId(principal, requested) !== ownerUserId) {
    throw new ForbiddenError('acting for another user')
  }
}

/** The user a service says it is acting for, on a route that carries no body. */
function requestedUser(ctx: RequestContext): string | undefined {
  return ctx.url.searchParams.get('userId') ?? undefined
}

function actorOf(principal: Principal): Actor {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

/* ------------------------------------------------------------------ parsing */

class BadRequestError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'BadRequestError'
    this.code = code
    this.status = status
  }
}

/** The header, falling back to a body field. Both spellings are in use across the estate. */
function idempotencyKeyOf(
  ctx: RequestContext,
  body: Record<string, unknown>,
): string | undefined {
  const header = headerOf(ctx.req, 'idempotency-key')
  const fromBody = typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : undefined
  return header ?? fromBody
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('body_too_large', 'request body too large')
    chunks.push(buffer)
  }
  return size === 0 ? '' : Buffer.concat(chunks).toString('utf8')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('bad_body', 'request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('bad_body', 'request body is not valid JSON')
  }
}

/**
 * Narrow a caller-supplied asset code to one that may be newly denominated, or refuse.
 *
 * **THE BOUNDARY WHERE `IssuableAssetCode` STOPS BEING A COMPILE-TIME GUARANTEE.** Inside the
 * service the type carries the rule; a JSON body carries a string, so the rule has to be re-checked
 * exactly once, here, at the point the string becomes a typed value. `assertIssuable` is
 * `contracts-chain`'s own narrowing and throws a `RangeError`, which is turned into a 400 rather
 * than allowed to reach the error handler as a 500 — the caller made a recoverable mistake and the
 * message has to say which asset and why.
 *
 * Returns a SPREADABLE object rather than a value, because `exactOptionalPropertyTypes` is on:
 * passing `assetCode: undefined` is a different thing from not passing it, and the compiler is
 * right to insist the difference be stated.
 */
function issuableAsset(raw: string | undefined): { readonly assetCode?: IssuableAssetCode } {
  if (raw === undefined) return {}
  const upper = raw.toUpperCase()
  // Membership is read off `CHAINS`, which is `Record<AssetCode, ChainSpec>` and therefore TOTAL
  // over the union. A hand-written list here would be a second declaration of `AssetCode`, free to
  // drift from the first in silence — the failure `RETIRED_ASSETS` and `chain_assets` both have
  // paragraphs about.
  if (!Object.hasOwn(CHAINS, upper)) {
    throw new BadRequestError('unknown_asset', `'${raw}' is not an asset this estate knows`)
  }
  try {
    return { assetCode: assertIssuable(upper as AssetCode) }
  } catch {
    throw new BadRequestError(
      'retired_asset',
      `${upper} is retired and may not denominate a new purchase. Existing balances can still be ` +
        'transferred, converted or withdrawn.',
    )
  }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError('bad_field', `${field} is required and must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new BadRequestError('bad_field', `${field} must be a string`)
  return value
}

/**
 * Read a money amount.
 *
 * A string is the expected form and is parsed with `BigInt`, exactly. A JSON number is accepted
 * only when it is already a safe integer — beyond that the value in the request has *already* lost
 * precision before this code ran, so the honest answer is to refuse it and say why rather than to
 * act on a number that is quietly not the one the caller meant.
 */
function requireAmount(body: Record<string, unknown>, field: string): bigint {
  const value = body[field]
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new BadRequestError(
        'bad_amount',
        `${field} is not an exact integer as a JSON number; send it as a decimal string`,
      )
    }
    return BigInt(value)
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new BadRequestError(
      'bad_amount',
      `${field} must be a non-negative integer in smallest units, as a string`,
    )
  }
  return BigInt(value.trim())
}

/**
 * The lifecycle states a caller may assert over HTTP. Two, out of six.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`exported` IS NOT ONE OF THEM, AND THAT IS THE POINT OF THIS FUNCTION.**
 *
 * `PATCH` used to cast the body's string straight to `WalletStatus` and hand it to
 * `transitionWallet`, which accepts anything `TRANSITIONS` permits — and `active` permits
 * `exported`. `exported` means the user has taken the private key, and `wallets.ts` says what it
 * costs: "Irreversible. The platform stops sweeping into treasury from it and every surface marks
 * it self-custodied. There is no transition out, because there is no operation that can un-know a
 * key." So the reachable worst case was not a wallet frozen by mistake, it was a wallet
 * permanently marked self-custodied when no key ever left — `is_primary` cleared, treasury sweeps
 * stopped, the label wrong on every surface, and no route back short of hand-written SQL.
 * `retiring → retired` is terminal in the same way.
 *
 * `exported` is the OUTCOME of a key export in `custody`, not an assertion a caller gets to make,
 * and the transition table is not the place to express that: `TRANSITIONS` describes what the
 * lifecycle allows, this describes what the wire allows, and they are different questions.
 * `transitionWallet` stays reachable in full from `links.ts` and from any internal path that has
 * actually observed the thing it is recording.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A garbage string was already safe — `canTransition` looks the target up in a frozen table — but
 * it answered `illegal_transition` from the store, which says the wallet is in the wrong state
 * rather than that the field will never be accepted. These are different instructions to a client.
 */
const SETTABLE_STATUSES: readonly WalletStatus[] = Object.freeze(['active', 'frozen'])

function settableStatus(raw: string): WalletStatus {
  if (!(SETTABLE_STATUSES as readonly string[]).includes(raw)) {
    throw new BadRequestError(
      'status_not_settable',
      `status may only be set to ${SETTABLE_STATUSES.join(' or ')} here — '${raw}' is not a state a ` +
        'caller may assert, whatever the wallet is in now',
    )
  }
  return raw as WalletStatus
}

/**
 * Which way the desk funding goes.
 *
 * Defaulted to `in`, because that is what an operator who omits it meant — nobody types a funding
 * request intending to empty the desk. Anything other than the two words is refused rather than
 * treated as the default: a client sending `direction: 'reverse'` and being quietly funded again is
 * the failure this refusal exists for, and it moves money.
 */
function fundingDirection(body: Record<string, unknown>): 'in' | 'out' {
  const raw = optionalString(body, 'direction')
  if (raw === undefined) return 'in'
  if (raw !== 'in' && raw !== 'out') {
    throw new BadRequestError('bad_field', "direction must be 'in' or 'out'")
  }
  return raw
}

function requireChainField(body: Record<string, unknown>): ChainId {
  const chain = requireString(body, 'chain').toLowerCase()
  if (!isChainId(chain)) throw new BadRequestError('unknown_chain', `no such chain: ${chain}`, 404)
  return chain
}

function readAuthorisations(body: Record<string, unknown>): readonly Authorisation[] {
  const raw = body['authorisations']
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new BadRequestError('bad_field', 'authorisations must be an array')
  return raw.map((value) => {
    if (typeof value !== 'string' || !isAuthorisation(value)) {
      throw new BadRequestError('unknown_authorisation', `not an authorisation: ${String(value)}`)
    }
    return value
  })
}

function limitFrom(ctx: RequestContext): number {
  const raw = ctx.url.searchParams.get('limit')
  if (raw === null) return DEFAULT_PAGE_SIZE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new BadRequestError('bad_limit', `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`)
  }
  return value
}

function cursorFrom(ctx: RequestContext): { cursor?: string } {
  const cursor = ctx.url.searchParams.get('cursor')
  return cursor ? { cursor } : {}
}

/* ------------------------------------------------------------------ replies */

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line, the trace and
 * the Lantern issue.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health, metrics and balance answers are a point-in-time fact. A cached 200 from a replica
    // that has since gone unready — or a cached portfolio from four minutes ago — is exactly the
    // lie this whole arrangement exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
