/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from the estate's custody service, which is the only
 * place that gets this right today:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic: everything derived from it is forgeable by anyone who can read the
 *      repository, and a placeholder that boots is a placeholder that reaches production.
 *
 * One variable here is load-bearing in a way none of the others is. `WALLET_NETWORK` names the
 * network this deployment settles on, and it is never inferred from a request. 04-domain-model
 * §3.1: "`network` is `mainnet` or `testnet`, never inferred". forge-pay's `network.ts` carries
 * the same rule and the same scar: its shared schema defaulted the field to the literal
 * `'testnet'`, so trusting the request body would mint every address on testnet the day an
 * operator switched the deployment to mainnet — an address on a chain nothing watches, handed to
 * a user as if it worked.
 */

import { hostname } from 'node:os'
import type { Network } from '@cloudsforge/contracts-chain'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a
 * migration advisory lock.
 */
export const SERVICE = 'wallet'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * Values that must never be accepted. The list is short on purpose: it holds the strings that
 * actually appear in this repository's own `.env.example` and compose files, because those are
 * the ones that get copied into a deployment by someone in a hurry.
 */
const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function boolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  throw new EnvError(`${name} must be true or false (got ${raw})`)
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  readonly instanceId: string

  /**
   * The network this deployment settles on. **Never inferred from a request.**
   *
   * A stated network that is not this one is refused; an omitted one means this one. Letting a
   * caller name the network is what makes a balance on the other network reachable at all, and
   * on XRP the same address is valid on both — 00-current-state §3.5.
   */
  readonly network: Network

  /** Where the ledger is, and the service token this service presents to it. */
  readonly ledgerUrl: string
  readonly custodyUrl: string
  readonly indexerUrl: string
  readonly pricingUrl: string
  /**
   * The token this service presents to its peers.
   *
   * One token, not four: it is minted for `service:wallet` with the scopes wallet needs, and the
   * peers each check the scope they care about. Four tokens would be four rotations.
   */
  readonly serviceToken: string

  /** Absolute wall-clock ceiling on one outbound call, retries included. */
  readonly upstreamDeadlineMs: number

  /**
   * How long an EIP-4361 challenge is valid for. Short deliberately: the nonce is single-use, so
   * this bounds how long a stolen unsigned challenge is worth stealing.
   */
  readonly challengeTtlSeconds: number
  /**
   * The domain a challenge must bind to — RFC 4361's `domain` field.
   *
   * Verification refuses a signature whose message names any other domain, which is what stops a
   * signature collected by a phishing site being replayed here. It is configuration rather than a
   * request field for exactly that reason.
   */
  readonly challengeDomain: string
  readonly challengeUri: string

  /** Withdrawals can be paused without a deploy. A pause is a 503, never a silent queue. */
  readonly withdrawalsEnabled: boolean
  /**
   * The operator-stated network fee per asset, in smallest units.
   *
   * An interim: it exists only until `micro-settlement` can quote a live fee, and it disappears
   * with the line in `index.ts` that reads it. **An asset absent from it is refused rather than
   * given a default** — the same fail-closed rule as `withinTolerance` in contracts-money, and for
   * the same reason: an asset silently exempt from a check is an asset with no check.
   */
  readonly feeQuotes: Readonly<Record<string, bigint>>
  /**
   * The smallest withdrawal, as a multiple of the quoted network fee.
   *
   * A withdrawal worth less than the fee to send it is a request to burn the user's money, and
   * one worth barely more is a request to burn most of it.
   */
  readonly withdrawalMinFeeMultiple: number
  /** How long a queued withdrawal may sit before it is `stuck` and an operator is told. */
  readonly withdrawalStuckMinutes: number

  /**
   * How long an idempotency key is honoured. Expiring one EARLY means the next replay of it does
   * the work a second time, so the TTL must outlive every caller's retry horizon rather than be
   * as short as the table would like.
   */
  readonly idempotencyTtlDays: number
}

/**
 * Parse the fee table.
 *
 * Values are converted with `BigInt`, never `Number`: an EVM fee routinely exceeds
 * `Number.MAX_SAFE_INTEGER`, and a float here would round the number a withdrawal is priced at.
 */
export function parseFeeQuotes(raw: string): Readonly<Record<string, bigint>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new EnvError(
      'WALLET_FEE_QUOTES must be a JSON object of asset code to smallest-unit string',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvError('WALLET_FEE_QUOTES must be a JSON object')
  }
  const out: Record<string, bigint> = {}
  for (const [asset, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} must be a decimal string`)
    }
    let fee: bigint
    try {
      fee = BigInt(value)
    } catch {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} is not an integer: ${String(value)}`)
    }
    if (fee < 0n) throw new EnvError(`WALLET_FEE_QUOTES.${asset} must not be negative`)
    out[asset] = fee
  }
  return out
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const network = optional(source, 'WALLET_NETWORK', 'testnet')
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new EnvError(`WALLET_NETWORK must be mainnet or testnet (got ${network})`)
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'WALLET_DATABASE_URL'),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'WALLET_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    network,
    ledgerUrl: required(source, 'LEDGER_URL'),
    custodyUrl: required(source, 'CUSTODY_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    pricingUrl: required(source, 'PRICING_URL'),
    serviceToken: requiredSecret(source, 'WALLET_SERVICE_TOKEN'),
    upstreamDeadlineMs: integer(source, 'WALLET_UPSTREAM_DEADLINE_MS', 8_000, 250, 60_000),
    challengeTtlSeconds: integer(source, 'WALLET_CHALLENGE_TTL_SECONDS', 600, 30, 3_600),
    challengeDomain: required(source, 'WALLET_CHALLENGE_DOMAIN'),
    challengeUri: required(source, 'WALLET_CHALLENGE_URI'),
    withdrawalsEnabled: boolean(source, 'WALLET_WITHDRAWALS_ENABLED', true),
    feeQuotes: parseFeeQuotes(optional(source, 'WALLET_FEE_QUOTES', '{}')),
    withdrawalMinFeeMultiple: integer(source, 'WALLET_WITHDRAWAL_MIN_FEE_MULTIPLE', 3, 1, 1_000),
    withdrawalStuckMinutes: integer(source, 'WALLET_WITHDRAWAL_STUCK_MINUTES', 60, 5, 10_080),
    idempotencyTtlDays: integer(source, 'WALLET_IDEMPOTENCY_TTL_DAYS', 30, 1, 3_650),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed
 * through the telemetry package: nothing that can itself fail may sit between a configuration
 * error and the report of it. The message is the one `loadEnv` produced, which by construction
 * never contains a value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
