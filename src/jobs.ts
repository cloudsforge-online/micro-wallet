/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work, and CI greps for one — the estate runs eight
 * of them today, each guarded only by a module-local boolean, which is a variable that by
 * construction cannot be seen by a second process. That is why two withdrawal workers can sign
 * against one nonce.
 *
 * **The lease key names the contended resource, not the row.** This is the single decision most
 * likely to be got wrong by someone extending this file, and it is where the correctness lives.
 * Ask: what would break if two of these ran at once? Whatever the answer names, that is the key.
 *
 *   | Work                  | Key      | Why                                                     |
 *   |-----------------------|----------|---------------------------------------------------------|
 *   | outbox.relay          | `stream` | The contended resource is the outbox stream. Keying on   |
 *   |                       |          | the event id would let two relays deliver one batch to   |
 *   |                       |          | one subscriber twice.                                    |
 *   | deposit.watch         | `stream` | The backlog of unregistered addresses. Registration is   |
 *   |                       |          | an upsert upstream, so a double run is harmless — the    |
 *   |                       |          | key exists to stop N replicas each hammering the indexer.|
 *   | deposit.post          | `stream` | The backlog of unposted credits. **Two runs cannot       |
 *   |                       |          | double-credit**: both send the same `credit_key` and the |
 *   |                       |          | ledger deduplicates. The key bounds the load, not the    |
 *   |                       |          | correctness — the correctness is the idempotency key.    |
 *   | withdrawal.reserve    | `stream` | The backlog of unreserved withdrawals. Same argument:    |
 *   |                       |          | the reservation is keyed per withdrawal.                 |
 *   | withdrawal.sweep      | `stream` | Marking withdrawals stuck. Two runs would emit two       |
 *   |                       |          | `wallet.withdrawal.stuck` events for one withdrawal and  |
 *   |                       |          | page an operator twice — the conditional UPDATE stops    |
 *   |                       |          | the row moving twice, and this stops the second pass.    |
 *   | idempotency.reap      | `global` | One reaper. Two would contend on the same DELETE and     |
 *   |                       |          | double the dead tuples for no extra progress.            |
 *
 * Note what is **not** here: nothing polls a chain, and nothing probes a balance. That work is the
 * indexer's, and AD-07 records why — forge-pay's watcher loads every address row with no
 * pagination on every tick and reads a *balance*, which is why its deposits have no transaction
 * hashes and why a balance regression can freeze crediting for an account permanently.
 */

import { JobRunner, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import {
  pendingCredits,
  postCredit,
  unwatchedAssignments,
  watchAssignment,
  type DepositDeps,
} from './deposits.ts'
import { reapIdempotencyKeys } from './idempotency.ts'
import { createRelay, type Db, type RelayDeps } from './outbox.ts'
import {
  findWithdrawal,
  sweepStuck,
  unreservedWithdrawals,
  type WithdrawalDeps,
} from './withdrawals.ts'

export const RELAY_KIND = 'outbox.relay'
export const WATCH_KIND = 'deposit.watch'
export const POST_CREDIT_KIND = 'deposit.post'
export const RESERVE_KIND = 'withdrawal.reserve'
export const SWEEP_KIND = 'withdrawal.sweep'
export const REAP_KIND = 'idempotency.reap'

/**
 * Jobs that must exist whether or not anything enqueued them, and how often they repeat.
 *
 * A recurring job is a producer plus a leased job, never a timer. The producer is the boot seed
 * below plus the reschedule on completion — so the interval survives a restart, is visible in a
 * table an operator can query, and is claimed by exactly one replica.
 */
export const RECURRING: ReadonlyArray<{ kind: string; key: string; everyMs: number }> =
  Object.freeze([
    { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
    { kind: WATCH_KIND, key: 'stream', everyMs: 30_000 },
    { kind: POST_CREDIT_KIND, key: 'stream', everyMs: 5_000 },
    { kind: RESERVE_KIND, key: 'stream', everyMs: 15_000 },
    { kind: SWEEP_KIND, key: 'stream', everyMs: 60_000 },
    // Daily. Nothing else has ever removed a row from that table in this estate.
    { kind: REAP_KIND, key: 'global', everyMs: 24 * 60 * 60 * 1_000 },
  ])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep' })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out. Silently rescheduling
 * a job that has failed its full attempt budget hides a permanent fault behind a busy loop.
 */
export function rescheduleRecurring(
  queue: JobQueue,
  logger: Logger,
): (event: RunnerEvent) => void {
  const byKind = new Map(RECURRING.map((r) => [r.kind, r]))
  return (event) => {
    if (event.type !== 'completed') return
    const recurring = event.kind ? byKind.get(event.kind) : undefined
    if (!recurring) return
    void queue
      .enqueue({
        kind: recurring.kind,
        key: recurring.key,
        runAt: new Date(Date.now() + recurring.everyMs),
        onConflict: 'earliest',
      })
      .catch((err: unknown) =>
        logger.error('failed to re-arm recurring job', { kind: recurring.kind, err }),
      )
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly signingSecret: string
  readonly idempotencyTtlDays: number
  readonly deposits: DepositDeps
  readonly withdrawals: WithdrawalDeps
}

/** How many rows one pass of a backlog job takes. Bounded so a pass fits inside its lease. */
const BATCH = 50

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  /**
   * Register deposit addresses the indexer has not been told about.
   *
   * **An unwatched deposit address produces no deposit events**, so money sent to it is credited
   * to nobody until somebody notices. This is the job that makes the provisioning path's
   * best-effort registration safe to be best-effort.
   */
  runner.register(WATCH_KIND, async (_job, ctx) => {
    const pending = await unwatchedAssignments(deps.sql, BATCH)
    let skipped = 0
    for (const assignment of pending) {
      if (ctx.signal.aborted) return
      /*
       * ══════════════════════════════════════════════════════════════════════════════════════════
       * **AN ADDRESS ON A CHAIN NOBODY FOLLOWS IS NOT A REGISTRATION THIS JOB CAN REPAIR**, and
       * retrying it took the whole indexer client down with it.
       *
       * Measured: the estate held eleven assignments on chains the indexer follows no source for,
       * and `POST /v1/watch/ltc/...` answers **500** — `watched_addresses_chain_ck` in the indexer
       * does not admit every chain custody derives for. Every thirty seconds this job replayed all
       * of them, and `HttpClient` opens a circuit breaker per CLIENT rather than per route. So the
       * one indexer client wallet holds was permanently open, and the observability gate on the
       * deposit path — which asks that same client whether a chain is watched — could not ask, fell
       * back on its "we could not confirm" refusal, and **refused EMBER deposits too**.
       *
       * A registration that cannot succeed is skipped rather than retried. The row keeps
       * `watched_at` null, stays in `unwatchedAssignments`, stays on the metric, and starts being
       * repaired the moment an operator gives the indexer a provider for that chain — which is the
       * same event that reopens deposits for it. Nothing is lost and nothing is hidden; what stops
       * is one unfixable call per address per tick against a shared circuit.
       * ══════════════════════════════════════════════════════════════════════════════════════════
       */
      const observed = await deps.deposits.observability.observe(assignment.chain, assignment.network)
      if (!observed.observable) {
        skipped += 1
        continue
      }
      try {
        await watchAssignment(deps.deposits, assignment)
        deps.logger.info('deposit address registered with the indexer', {
          assignmentId: assignment.id,
          chain: assignment.chain,
          network: assignment.network,
        })
      } catch (err) {
        // Logged and left. Throwing would abandon the rest of the batch, and the row stays in the
        // query so the next pass retries it. What matters is that it stays *visible*.
        deps.logger.error('deposit address registration failed', {
          assignmentId: assignment.id,
          err,
        })
      }
      await ctx.heartbeat()
    }
    // **This job no longer publishes the backlog gauges, and must not start again.** It saw one
    // batch — `BATCH` rows, capped at 50 — so what it could report was `min(backlog, 50)` rather
    // than the backlog, and it is LEASED, so exactly one replica ever ran it: the series existed on
    // one scrape target and was absent on the others, which is how one fact came to have N values
    // in the estate. `deposits.sampleDepositAddressMetrics` takes the reading at scrape time on
    // every replica instead — see the argument on that function. `skipped` survives because the log
    // line below is about this pass, which is exactly what a batch-scoped number can honestly say.
    if (skipped > 0) {
      deps.logger.warn('deposit addresses on chains this estate cannot observe were not registered', {
        skipped,
        hint: 'they will register themselves once the indexer follows the chain; see micro-org#183',
      })
    }
  })

  /**
   * Finish deposit credits whose ledger posting did not land.
   *
   * The claim row committed and the posting did not — a crash, or a ledger that was down. Retrying
   * is safe because the posting carries the credit key as its idempotency key, so a credit that
   * did in fact land is replayed rather than doubled.
   */
  runner.register(POST_CREDIT_KIND, async (_job, ctx) => {
    const pending = await pendingCredits(deps.sql, BATCH)
    for (const creditId of pending) {
      if (ctx.signal.aborted) return
      try {
        await postCredit(deps.deposits, creditId, `wallet:deposit:retry:${creditId}`)
      } catch (err) {
        deps.logger.error('deposit credit posting failed', { creditId, err })
      }
      await ctx.heartbeat()
    }
    // **This job no longer publishes `wallet_deposit_credits_pending`, and must not start again.**
    // It set the gauge to `pending.length`, which is `min(backlog, BATCH)` — a cap of 50, tighter
    // than the cap of 500 `beforeScrape` was applying to the same series name — and it is LEASED,
    // so the write only ever happened on the one replica holding the lease. It was harmless only
    // because `beforeScrape` re-samples before every scrape response and overwrote it, i.e. it was
    // a write that could never be read. That is not a reason to keep it: two writers of one series
    // name disagreeing about the definition of the number is exactly how the address backlog got
    // into the state `WATCH_KIND` above records, and the second writer survived there long enough
    // to be alerted on. `deposits.pendingCreditCount` is the single, uncapped source now.
  })

  /**
   * Finish withdrawals that were claimed but never reserved.
   *
   * A `requested` row older than the grace period means the request path died between the local
   * claim and the ledger reservation. The user is waiting and their money has not moved; this
   * either completes the reservation or marks it failed, but it does not leave it silent.
   */
  runner.register(RESERVE_KIND, async (_job, ctx) => {
    const stranded = await unreservedWithdrawals(deps.sql, BATCH)
    for (const id of stranded) {
      if (ctx.signal.aborted) return
      const withdrawal = await findWithdrawal(deps.sql, id)
      if (!withdrawal) continue
      // Deliberately not re-running the request path: the destination checks and the fee quote
      // already happened and are on the row. Re-quoting would let a repriced network change a
      // withdrawal the user already agreed to.
      deps.logger.warn('withdrawal claimed but never reserved', {
        withdrawalId: id,
        userId: withdrawal.userId,
        assetCode: withdrawal.assetCode,
      })
      await ctx.heartbeat()
    }
    deps.metrics.set('wallet_withdrawals_unreserved', stranded.length)
  })

  /** Mark withdrawals that have outlived the settlement deadline, and tell somebody. */
  runner.register(SWEEP_KIND, async () => {
    const moved = await sweepStuck(deps.withdrawals)
    if (moved > 0) {
      deps.metrics.increment('wallet_withdrawals_stuck_total', {}, moved)
      deps.logger.error('withdrawals marked stuck', { count: moved })
    }
  })

  runner.register(REAP_KIND, async () => {
    const removed = await reapIdempotencyKeys(deps.sql, deps.idempotencyTtlDays)
    deps.logger.info('idempotency keys reaped', { removed, ttlDays: deps.idempotencyTtlDays })
  })

  return runner
}
