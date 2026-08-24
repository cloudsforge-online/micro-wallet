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
import {
  CHAINS,
  chainSpec,
  isRetiredAsset,
  type AssetCode,
  type Network,
} from '@cloudsforge/contracts-chain'
import {
  SecretError,
  assertGeneratedSecret,
  assertServiceCredential,
  parseSecretList as parseSharedSecretList,
} from '@cloudsforge/secrets'

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
 * THE `PLACEHOLDERS` SET THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * It held eight exact strings and was paired with a 24-character floor. Neither could fail for the
 * value that actually reached 44 containers on both networks: micro-org #142's
 * `estate-only-outbox-secret-00000000000000` is 40 characters and was on nobody's list. A check
 * that cannot fail is worse than no check, because the absence of an alarm gets read as the
 * absence of a problem — and this service moves money.
 *
 * A deny-list of exact strings is structurally unable to work: the next placeholder somebody
 * writes is, by definition, not on it. `@cloudsforge/secrets` asserts the SHAPE of a generated
 * value instead, which is the property a placeholder cannot have. It is imported rather than
 * copied so that this service cannot drift from the other sixteen.
 */

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * Re-wrap the shared guard's `SecretError` as this service's `EnvError`.
 *
 * `loadEnv` documents a single error class for every configuration failure, and the boot path
 * catches that one class. The message is preserved verbatim — it already names the variable and
 * the command that fixes it, and it never contains the value.
 */
function asEnvError<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof SecretError) throw new EnvError(err.message)
    throw err
  }
}

/**
 * The estate's shared event-bus HMAC key — one key behind every service-to-service POST, including
 * the ones that credit a deposit.
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. The old `minLength` parameter is gone rather
 * than kept in front: it is a strict subset of the shape check, and running it first answers a
 * 40-character placeholder with "must be at least 24 characters" — true, useless, and about the
 * wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  asEnvError(() => assertGeneratedSecret(name, value))
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

/**
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND IT STAYS ONE ──────────────────────────────────────────────
 *
 * Absent is a deployment that has not been granted a credential yet; it returns `null`, `/readyz`
 * reports it, and the service runs. Turning that into `exit(1)` would convert a gap into an
 * outage on the service that holds user balances. The empty check therefore stays AHEAD of the
 * assertion, because compose interpolates `${WALLET_IDENTITY_CREDENTIAL:-}` and an unset
 * credential arrives as the empty string — that is the supported mode, not a malformed one.
 *
 * What is not supported is a value that is present and rubbish: a 20-character placeholder is a
 * deployment that believes it HAS a credential, and it fails on its first call to a peer with a
 * 401 that reads as "identity rejected wallet" rather than "nobody set this variable".
 *
 * ── WHY NOT `assertGeneratedSecret` ────────────────────────────────────────────────────────────
 *
 * Because it would refuse every credential this estate has ever minted, and wallet would exit 1 at
 * boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64 nor
 * wholly hex — the underscore in its own prefix disqualifies it. Measured live, the testnet
 * credential also CONTAINS A HYPHEN while the mainnet one does not, so the "no hyphens" instinct
 * that is correct for the signing key above would have booted mainnet and killed testnet.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  asEnvError(() => assertServiceCredential(name, value))
  return value
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

/**
 * The secrets the inbound event route accepts, newest first.
 *
 * A LIST, not a value, because rotation without an overlap window means every producer must change
 * secret in the same instant as this service does, and that instant does not exist during a rolling
 * deploy. Each entry gets the checks `requiredSecret` applies to one. The same shape as
 * `devplatform`'s `parseSecretList` and `activity`'s `ACTIVITY_INGEST_SECRETS`.
 */
export function parseSecretList(raw: string, name: string): readonly string[] {
  // Argument order is flipped on the way through: this service's exported signature is
  // `(raw, name)` and the shared one is `(name, raw)`. Kept rather than changed because the
  // signature is part of this module's public surface, and a silent flip of two `string`
  // parameters is a change the type checker cannot catch.
  //
  // EVERY ENTRY FACES THE FULL RULE, INCLUDING THE OUTGOING ONE. In a rotation overlap window the
  // outgoing key is the one an attacker already holds if it leaked, and "just for the drain" is
  // exactly how a placeholder survives the rotation that was meant to remove it.
  return asEnvError(() => parseSharedSecretList(name, raw))
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
  /**
   * The TESTNET database, when this deployment serves both networks. Empty means single-network —
   * `networkSql` then holds one handle and REFUSES a testnet request rather than answering it out
   * of mainnet rows (micro-deploy `docs/network-consolidation.md` §2.2).
   */
  readonly databaseUrlTestnet: string
  /**
   * The network to assume when a request carries no `CF-Network`, or empty to refuse. Set for
   * `pnpm dev`, which has no gateway. Never in production, where guessing makes a routing fault a
   * silent cross-network write.
   */
  readonly singleNetwork: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string

  /**
   * The secrets `POST /events` ACCEPTS, newest first. Signing stays on the single key above.
   *
   * `OUTBOX_SIGNING_SECRET` is one HMAC key shared by every service in the estate, and replacing it
   * is only possible as a rolling change if each receiver holds more than one candidate for the
   * length of the cutover. With one, the instant a producer's relay adopts the new key every
   * delivery here answers 401 and the relay retries it for ever — so deposit confirmations and
   * settlement outcomes stop arriving while `/livez` stays green. That is the failure this exists
   * to make impossible, and it is silent, which is why the window has to be configurable rather
   * than coordinated.
   *
   * `OUTBOX_ACCEPT_SECRETS` is OPTIONAL and defaults to `[OUTBOX_SIGNING_SECRET]`, so a deployment
   * that has not been given it behaves exactly as it does today. That is deliberate: it makes
   * shipping this a no-op, which is what lets the rotation itself be staged one service at a time.
   *
   * `verifyDelivery` reports `keyIndex`, and `handleEvent` logs any index above zero. That line is
   * the countdown: when it stops appearing, every producer has moved and the operator can drop the
   * retired entry from the list.
   */
  readonly outboxAcceptSecrets: readonly string[]

  readonly instanceId: string

  /**
   * The network this deployment settles on. **Never inferred from a request.**
   *
   * A stated network that is not this one is refused; an omitted one means this one. Letting a
   * caller name the network is what makes a balance on the other network reachable at all, and
   * on XRP the same address is valid on both — 00-current-state §3.5.
   */
  readonly network: Network

  /** Where the ledger is, and the peers this service presents a token to. */
  readonly ledgerUrl: string
  readonly custodyUrl: string
  readonly indexerUrl: string
  readonly pricingUrl: string

  /**
   * Where identity is, for `POST /service-tokens/exchange`.
   *
   * Defaults to `IDENTITY_ISSUER`, which is already required and is identity's own base URL — the
   * issuer of a token is by definition where the token came from. `IDENTITY_URL` overrides it for
   * a deployment where the two genuinely differ (an issuer behind a public name, dialled
   * internally). Deriving rather than demanding a fourth identity variable keeps the two in step:
   * a deployment that pointed the exchange at one identity and trusted the JWKS of another would
   * fail with a signature error nobody would read as a configuration mistake.
   */
  readonly identityUrl: string

  /**
   * **The long-lived credential this service exchanges for short-lived tokens.**
   *
   * It replaces `WALLET_SERVICE_TOKEN`, which was a 600-second token read once at boot. Ten
   * minutes into any deployment it expired and every call to a peer failed; nothing could re-mint
   * it, because minting requires the `admin` role. A credential is not a token: it confers nothing
   * by itself, it is revocable, and it survives a restart. See `micro-identity`
   * `src/serviceCredentials.ts` and `@cloudsforge/auth` `ServiceTokenProvider`.
   *
   * OPTIONAL, AND THAT IS DELIBERATE — but it is not "unconfigured is fine". Everything this
   * service does that touches money crosses a service boundary, so a wallet with no credential can
   * serve almost nothing. It is optional because it must be possible to BOOT the image without
   * one: the CI startup smoke test builds the container, migrates it and reads `/livez`, and that
   * job's environment is fixed in a workflow file. Making this `requiredSecret` would fail that
   * job rather than this service.
   *
   * The absence is therefore not silent. `/readyz` reports the `identity-credential` probe as a
   * HARD failure, so an unconfigured replica never takes traffic, and every upstream call fails
   * closed with 503 rather than being sent unauthenticated. Contrast the soft upstream probes: a
   * missing credential is a deployment that is wrong and will stay wrong, not a peer having a bad
   * minute.
   */
  readonly identityCredential: string | null

  /**
   * Whether the retired `WALLET_SERVICE_TOKEN` is still set.
   *
   * Read for exactly one purpose: to say so at boot. An operator who redeploys with the old
   * variable and not the new one would otherwise get a service that looks configured and is not,
   * which is a slower version of the defect the credential was introduced to fix.
   */
  readonly legacyServiceTokenPresent: boolean

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
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A NUMBER HERE IS MEANINGLESS WITHOUT THE ASSET IT IS DENOMINATED IN — #213.**
 *
 * This function used to ask four questions: is the JSON an object, is the value a string or a
 * number, does `BigInt()` accept it, and is it non-negative. All four are questions about a
 * NUMBER. None of them is a question about the ASSET, and a fee is not a number — it is a number
 * at a scale, and the scale is a property of the chain.
 *
 * The live table is `{"EMBER":"21000000000000"}`. The obvious way to add Litecoin is to copy that
 * line. At EMBER's 18 decimals it is 0.000021 EMBER; at Litecoin's 8 it is **210,000 LTC**, a
 * factor of 10¹⁰. The old parser accepted it without a word, because "21000000000000" is a
 * perfectly good non-negative integer.
 *
 * So the asset is now looked up rather than assumed, and `@cloudsforge/contracts-chain` — which
 * was already imported here, but as a TYPE ONLY, so its decimals table was not in scope — is the
 * authority for all three of the checks below. This follows `chainTokenAssetCode()` in
 * `micro-contracts@c272a33`: when the scale of a value cannot be established, throw rather than
 * guess. `micro-foresight`'s `stakeAssetDecimals` draws the same line one service over.
 *
 * Every failure here is a BOOT failure, which is the cheapest place in the system to catch it —
 * the alternative is discovering it when a user's withdrawal is priced.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
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
    // ── 1. The key must name an asset this estate has a chain spec for ────────────────────────
    //
    // Read off `CHAINS`, whose keys ARE the `AssetCode` union, so a chain added upstream is
    // quotable here without an edit and one removed upstream stops being quotable. A typo like
    // `LTCC` or a lower-case `ltc` used to install a quote for a coin that does not exist while
    // the real asset stayed absent and was refused — which does not lose money, because absence
    // is fail-closed, but presents as "Litecoin withdrawals are refused" beside a table that
    // visibly contains a Litecoin line.
    if (!Object.hasOwn(CHAINS, asset)) {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} is not an asset code this estate knows`)
    }
    const code = asset as AssetCode
    // A retired asset is nameable and un-withdrawable, and those are separate questions. SHARD
    // never settled on a chain; quoting it a network fee is a category error, and its `decimals:
    // 0` would make the bound below say something confusing rather than something true.
    if (isRetiredAsset(code)) {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} is retired and cannot be withdrawn`)
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} must be a decimal string`)
    }
    // ── 2. `BigInt('') === 0n`, so an empty value must be refused BEFORE the coercion ─────────
    //
    // `''` is a string, so the check above passes. `BigInt('')` does not throw, so the `try`
    // below passes. `0n < 0n` is false, so the sign check passes. The result was a fee of zero —
    // free withdrawals, paid out of the treasury, with no error raised anywhere. `BigInt` also
    // accepts a whitespace-only string, so the test is on the trimmed value.
    if (typeof value === 'string' && value.trim() === '') {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} is empty, which BigInt would read as zero`)
    }
    let fee: bigint
    try {
      fee = BigInt(value)
    } catch {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} is not an integer: ${String(value)}`)
    }
    if (fee < 0n) throw new EnvError(`WALLET_FEE_QUOTES.${asset} must not be negative`)
    // Waiving the network fee is a decision an operator makes on purpose. It must never be the
    // thing a malformed value degrades into, so zero is refused here and would have to be
    // introduced deliberately, with its own name, if it were ever wanted.
    if (fee === 0n) {
      throw new EnvError(`WALLET_FEE_QUOTES.${asset} is zero — a free withdrawal is not a default`)
    }

    // ── 3. The magnitude must be plausible AT THIS ASSET'S SCALE ─────────────────────────────
    //
    // One whole unit of the asset is the bound: `10 ** decimals`. A network fee of an entire coin
    // is not a network fee on any chain this estate speaks, and the figure is derived from the
    // chain spec rather than written down, so it is right for an 8-decimal chain and an
    // 18-decimal one without either being special-cased.
    //
    // It catches the exponent error in the direction it actually happens. Copying EMBER's
    // 21000000000000 onto LTC gives 21000000000000 ≥ 10⁸ and throws. It is deliberately a loose
    // bound and not a tight one — a tight bound would need a live fee estimate, which is exactly
    // the thing this table is an interim for, and would turn a fee spike into an outage.
    //
    // Note what this does NOT catch: a fee 10¹⁰ too SMALL still parses, because a small fee is
    // indistinguishable from a cheap chain. That direction is caught downstream by
    // `withdrawalMinFeeMultiple` and by the treasury reconciling short, not here.
    const oneWholeUnit = 10n ** BigInt(chainSpec(code).decimals)
    if (fee >= oneWholeUnit) {
      throw new EnvError(
        `WALLET_FEE_QUOTES.${asset} is ${fee}, which is at least one whole ${asset} at ` +
          `${chainSpec(code).decimals} decimals — that is an amount, not a network fee, and is ` +
          `usually a figure copied from an asset with a different number of decimals`,
      )
    }
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

  // Read before the literal below, because the accept list defaults to it. Note the order: the
  // signing secret is validated first, so a deployment with a bad one is told about THAT rather
  // than about a list it never set.
  const outboxSigningSecret = requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET')

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'WALLET_DATABASE_URL'),
    databaseUrlTestnet: optional(source, 'WALLET_DATABASE_URL_TESTNET', ''),
    singleNetwork: optional(source, 'CF_NETWORK_SINGLE', ''),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'WALLET_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret,
    // Absent means "accept exactly what we sign with", which is today's behaviour precisely.
    outboxAcceptSecrets: parseSecretList(
      optional(source, 'OUTBOX_ACCEPT_SECRETS', outboxSigningSecret),
      'OUTBOX_ACCEPT_SECRETS',
    ),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    network,
    ledgerUrl: required(source, 'LEDGER_URL'),
    custodyUrl: required(source, 'CUSTODY_URL'),
    indexerUrl: required(source, 'INDEXER_URL'),
    pricingUrl: required(source, 'PRICING_URL'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Not `requiredSecret`: see the field comment. The absence is caught by `/readyz`, which is a
    // check that can fail, rather than by a boot that CI cannot perform.
    identityCredential: optionalCredential(source, 'WALLET_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent: (source['WALLET_SERVICE_TOKEN']?.trim() ?? '').length > 0,
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
