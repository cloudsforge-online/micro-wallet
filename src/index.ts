/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step below carries the reason it must precede the next; the ordering is the substance of
 * this file, and getting it wrong reproduces a defect the estate already has.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process. See AD-17 and rule 7.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`: the service does not read them, so under rule 9 it
 * must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier, serviceTokenProbe } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring, type JobDeps } from './jobs.ts'
import { buildUpstreams } from './upstreams.ts'
import { staticFeeQuoter } from './settlement.ts'
import { indexerObservability } from './observability.ts'
import {
  pendingCreditCount,
  sampleDepositAddressMetrics,
  tokenSightingCount,
  type DepositDeps,
} from './deposits.ts'
import type { MoneyDeps } from './money.ts'
import type { PortfolioDeps } from './portfolio.ts'
import type { WithdrawalDeps } from './withdrawals.ts'
import type { Db } from './outbox.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  network: env.network,
})

// 3. The database pool. Opened before the schema assertion because the assertion is a query, and
//    before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does **not** migrate — the migrator job does, and it has already run
//    by the time a container starts. Failing here rather than serving is the point: a replica of
//    the new code answering requests against the old schema corrupts data quietly, whereas a
//    container that refuses to start is a deploy that visibly stops. For this service, below
//    SCHEMA_VERSION the `deposit_credits.credit_key` unique constraint may not exist — and that
//    constraint is one of the two things stopping a redelivered deposit crediting twice.
try {
  // The runtime packages accept a narrow structural `Sql` rather than importing postgres.js, so
  // they stay testable and driver-swappable. The cast is the price of that.
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The upstreams, and the credential that authenticates every call to them. Built before the
//    Lifecycle so the probes can close over them, and before the stores because every store takes
//    one. The wiring itself lives in `./upstreams.ts` and is covered by `servicetoken.test.ts` —
//    it was untestable here, and what was untestable here was wrong for months. See that file.
const { identityTokens, ledger, custody, indexer, pricing } = buildUpstreams(env, {
  originatingService: SERVICE,
  onEvent: (event) => {
    if (event.kind === 'exchange_failed') {
      // `warn`, not `error`, while a usable token is still held: the 20% slack after the refresh
      // point exists precisely so a few of these are survivable and uninteresting.
      const level = event.hadUsableToken ? 'warn' : 'error'
      logger[level]('service token exchange failed', {
        err: event.err,
        hadUsableToken: event.hadUsableToken,
      })
    } else if (event.kind === 'minted') {
      logger.info('service token minted', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      })
    } else {
      logger.warn('service token', { event: event.kind, url: event.url })
    }
  },
})

if (!identityTokens) {
  // Not `fatal` and exit: the image must be able to boot without this so CI's startup smoke test
  // can read /livez, and a service that refuses to start is a service whose logs nobody reads.
  // `/readyz` is where the absence is enforced — the `identity-credential` probe below is hard,
  // so an unconfigured replica takes no traffic.
  logger.error('WALLET_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
    hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
  })
}
if (env.legacyServiceTokenPresent) {
  logger.error('WALLET_SERVICE_TOKEN is set and is IGNORED', {
    hint: 'it was a 600-second token read once at boot; WALLET_IDENTITY_CREDENTIAL replaces it',
  })
}

// 6. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignored
      // the signal would hang `/readyz` for ever. Racing the signal here is what turns "the
      // database is not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  // All three upstream probes are **soft**, and that is a deliberate reading of what this service
  // can still do without them. With the ledger down it can still list wallets, verify a link and
  // register a deposit address; with pricing down a portfolio renders without valuations. Marking
  // any of them hard means one upstream blip removes every wallet replica from its balancer at
  // once, which is a cascade rather than a safety measure. The money routes fail individually with
  // 503 and say which upstream did not answer, which is a better answer than an unroutable
  // service.
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // HARD, and the only hard probe here besides the database. Unlike the three below, this does not
  // report a peer having a bad minute — it fails only when no credential is configured at all,
  // which is a deployment that cannot serve a single money route and will not fix itself. An
  // identity OUTAGE returns warn, deliberately, so one bad minute in identity does not empty every
  // balancer in the estate at once.
  .addProbe(serviceTokenProbe(identityTokens))
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('indexer', `${env.indexerUrl}/livez`, { kind: 'soft' }))

// 7. The stores, as dependency bundles. Constructed after the pool so they are real rather than a
//    lazily-connected surprise on the first request.
const db = sql as unknown as Db

const deposits: DepositDeps = {
  sql: db,
  producer: SERVICE,
  network: env.network,
  custody,
  indexer,
  ledger,
  // Measured from the indexer per request (cached 60s), never asserted from a list here. See
  // `observability.ts`: a second hardcoded list of supported chains is how the estate came to offer
  // a real Bitcoin address that nothing was watching.
  observability: indexerObservability({ indexer }),
}

const withdrawals: WithdrawalDeps = {
  sql: db,
  producer: SERVICE,
  network: env.network,
  ledger,
  /**
   * Fees come from configuration until `micro-settlement` exists to quote them live.
   *
   * This is the one line that changes when it does: `staticFeeQuoter(...)` becomes
   * `httpFeeQuoter({ baseUrl: env.settlementUrl, ... })`. An asset absent from the table is
   * refused with 503 rather than priced by guessing — see `settlement.ts`.
   */
  fees: staticFeeQuoter(env.feeQuotes),
  withdrawalsEnabled: env.withdrawalsEnabled,
  minFeeMultiple: env.withdrawalMinFeeMultiple,
  stuckMinutes: env.withdrawalStuckMinutes,
}

const money: MoneyDeps = { sql: db, producer: SERVICE, ledger, pricing }
const portfolio: PortfolioDeps = { sql: db, network: env.network, ledger, indexer, pricing }

// 8. Routes. After the Lifecycle so the health handlers report real state.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  network: env.network,
  deposits,
  withdrawals,
  money,
  portfolio,
  // The ACCEPT list, not the signing key: verification widens for the rotation window, signing
  // does not. Absent `OUTBOX_ACCEPT_SECRETS` this is `[env.outboxSigningSecret]`, i.e. unchanged.
  eventSigningSecret: env.outboxAcceptSecrets,
  challengeDomain: env.challengeDomain,
  challengeUri: env.challengeUri,
  challengeTtlSeconds: env.challengeTtlSeconds,
  // Sampled at scrape time rather than on a timer. There is no `setInterval` in this repository
  // and CI greps for one — rule 8. A scrape is already periodic, so the scrape is when to sample.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
    // Both of these must read zero in a healthy service, and both are invisible without a gauge:
    // a credit claimed but never posted is money the user cannot see, and an unwatched deposit
    // address is money nobody will ever be told about.
    //
    // `pendingCreditCount` and not `(await pendingCredits(db, 500)).length`: the second is
    // `min(backlog, 500)`, so the series pinned at 500 and stopped moving at the point the incident
    // was worst — and it selected 500 UUIDs on every scrape on every replica to throw them away
    // after reading their count. The argument is on the function; `DepositCreditsUnposted` is the
    // rule that now reads this and cannot escalate on a saturating input.
    metrics.set('wallet_deposit_credits_pending', await pendingCreditCount(db))
    // Customer money at a deposit address that no ledger entry accounts for — micro-org#200. Reads
    // 0 on an estate that has never been sent a token, and once it is non-zero it stays non-zero,
    // because nothing in this service can resolve a sighting. It is the size of an unrecorded
    // obligation rather than a queue length, which is why it is worth a gauge before it is worth
    // anything else.
    metrics.set('wallet_deposit_token_sightings', await tokenSightingCount(db))
    // Per chain, from one query, on every replica — and the only writer of these three series.
    // The argument for all of that is on the function; the short version is that a leased job was
    // publishing a batch-capped copy of one of them from one replica.
    await sampleDepositAddressMetrics(deposits, metrics)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving — `shouldClaim` is wired to
//    the Lifecycle for exactly that.
const jobDeps: JobDeps = {
  sql: db,
  logger,
  metrics,
  signingSecret: env.outboxSigningSecret,
  idempotencyTtlDays: env.idempotencyTtlDays,
  deposits,
  withdrawals,
}

const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, jobDeps)
await seedRecurring(queue)
runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//     balancer is allowed to send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready, and the drain races the construction above.
//     Hooks run in reverse registration order, so the server closes first, then the runner stops
//     claiming and drains, then the pool closes with nothing left to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
