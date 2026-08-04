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
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { Actor } from '@cloudsforge/contracts-money'
import type { Network } from '@cloudsforge/contracts-chain'
import { AddressError, isChainId, type ChainId } from './addresses.ts'
import { CustodyContractError, CustodyRefusedError, CustodyUnavailableError } from './custodyclient.ts'
import {
  assignDepositAddress,
  DepositError,
  handleDepositConfirmed,
  listAssignments,
  listCredits,
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
import { convert, MoneyError, spend, transfer, type MoneyDeps } from './money.ts'
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  verifyDelivery,
} from '@cloudsforge/contracts-events'
import { INDEXER_DEPOSIT_CONFIRMED } from './outbox.ts'
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
  readonly network: Network
  readonly deposits: DepositDeps
  readonly withdrawals: WithdrawalDeps
  readonly money: MoneyDeps
  readonly portfolio: PortfolioDeps
  /** Verifies the HMAC on inbound events. The same secret the producing service signs with. */
  readonly eventSigningSecret: string
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
    .register({
      name: 'wallet_deposit_credits_pending',
      help: 'Deposit credits claimed locally whose ledger posting has not landed. Should be 0.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'wallet_deposit_addresses_unwatched',
      help: 'Deposit addresses the indexer has not been asked to watch. Should be 0.',
      kind: 'gauge',
      labels: [],
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
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 64 * 1024

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly requestId: string
  readonly log: Logger
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

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, params: matched?.params ?? {}, requestId, log }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        // Reaching here means the error mapping itself failed. Answer, then say so loudly.
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
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
      // (`custody/src/keys.ts:101` mints unconditionally); the header is sent so that it works the
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
      assertOwner(principal, wallet.userId)
      const link = await readLink(deps.portfolio.sql, wallet.id)
      return { status: 200, body: { wallet, link } }
    }),

    route('PATCH', '/v1/wallets/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps, WRITE_SCOPE)
      const id = ctx.params['id'] ?? ''
      const wallet = await findWallet(deps.portfolio.sql, id)
      if (!wallet) throw new BadRequestError('wallet_not_found', 'no such wallet', 404)
      assertOwner(principal, wallet.userId)

      const body = await readJson(ctx.req)
      let updated = wallet
      if ('label' in body) updated = await relabelWallet(deps.portfolio.sql, id, optionalString(body, 'label') ?? null)
      if (body['isPrimary'] === true) updated = await setPrimary(deps.portfolio.sql, id)
      if (typeof body['status'] === 'string') {
        updated = await transitionWallet(deps.portfolio.sql, id, body['status'] as WalletStatus)
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
      const wallet = await findWallet(deps.portfolio.sql, id)
      if (!wallet) throw new BadRequestError('wallet_not_found', 'no such wallet', 404)
      assertOwner(principal, wallet.userId)

      const body = await readJson(ctx.req)
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
      assertOwner(principal, wallet.userId)

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
      assertOwner(principal, withdrawal.userId)
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

function assertOwner(principal: Principal, ownerUserId: string): void {
  if (isAdmin(principal) || principal.kind === 'service') return
  if (principal.userId !== ownerUserId) throw new ForbiddenError('acting for another user')
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
