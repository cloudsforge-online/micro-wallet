import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { AddressError } from './addresses.ts'
import { assignDepositAddress } from './deposits.ts'
import { LedgerRefusedError } from './ledgerclient.ts'
import { readPortfolio } from './portfolio.ts'
import { createChallenge, grantAuthorisation, verifyChallenge } from './links.ts'
import { SETTLEMENT_CONFIRMED, SETTLEMENT_FAILED } from './settlement.ts'
import {
  WithdrawalError,
  failWithdrawal,
  findWithdrawal,
  listWithdrawals,
  requestWithdrawal,
  settleWithdrawal,
  sweepStuck,
} from './withdrawals.ts'
import {
  enabled,
  evmSigner,
  harness,
  migrateTestDb,
  openDb,
  resetWallet,
  skip,
  testUser,
  type Harness,
} from './testsupport.ts'

let sql: postgres.Sql
let h: Harness

const USER = testUser(1)
const OTHER = testUser(2)
const DOMAIN = 'hub.cloudsforge.online'
const URI = 'https://hub.cloudsforge.online/wallets/verify'
/** Three times the fee, which is the configured minimum. */
const FEE = 21_000_000_000_000n
const AMOUNT = 1_000_000_000_000_000_000n
const ONE_EMBER = 1_000_000_000_000_000_000n

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetWallet(sql)
  h = harness(sql)
})

const request = (overrides: Record<string, unknown> = {}) =>
  requestWithdrawal(h.withdrawals, {
    userId: USER,
    assetCode: 'EMBER',
    destination: '0x1111111111111111111111111111111111111111',
    amount: AMOUNT,
    clientKey: 'client-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
    ...overrides,
  } as never)

/** Register an address, verify it, and grant it the withdrawal authority. */
async function verifiedDestination(): Promise<string> {
  const signer = evmSigner()
  const { wallet, challenge } = await createChallenge(sql as never, 'wallet', {
    userId: USER,
    chain: 'ember',
    network: 'testnet',
    address: signer.address,
    origin: 'external',
    domain: DOMAIN,
    uri: URI,
    ttlSeconds: 600,
    correlationId: 'req-0',
  })
  await verifyChallenge(sql as never, 'wallet', {
    userId: USER,
    nonce: challenge!.nonce,
    signature: signer.sign(challenge!.message),
    expectedDomain: DOMAIN,
    expectedUri: URI,
    correlationId: 'req-0',
  })
  await grantAuthorisation(sql as never, wallet.id, 'withdrawal_destination', `user:${USER}`)
  return signer.address
}

/** Register an address as watch-only, which is what the invariant is about. */
async function watchDestination(userId = USER): Promise<string> {
  const signer = evmSigner()
  await createChallenge(sql as never, 'wallet', {
    userId,
    chain: 'ember',
    network: 'testnet',
    address: signer.address,
    origin: 'watch',
    domain: DOMAIN,
    uri: URI,
    ttlSeconds: 600,
    correlationId: 'req-0',
  })
  return signer.address
}

/* ------------------------------------------------------------------ the happy path */

test('a withdrawal reserves through the ledger and queues for settlement', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request()

  assert.equal(withdrawal.state, 'queued')
  assert.equal(withdrawal.amount, AMOUNT.toString())
  assert.equal(withdrawal.fee, FEE.toString())
  // The fee comes out of the amount, never on top, so a user can always withdraw their whole
  // balance — forge-pay gets this right and the split preserves it.
  assert.equal(withdrawal.net, (AMOUNT - FEE).toString())

  // **The reservation is a posting pair, not a column.** The money is out of `available` and in
  // `reserved`: not spendable, not lost, and visible in a trial balance.
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 9n * ONE_EMBER)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), AMOUNT)
  assert.notEqual(withdrawal.reservationEntryId, null)

  const events = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from outbox where topic = 'wallet.withdrawal.requested'
  `
  assert.equal(events.length, 1)
  // Everything micro-settlement needs to build one payment, and nothing else.
  assert.equal(events[0]?.payload['net'], (AMOUNT - FEE).toString())
  assert.equal(events[0]?.payload['reservationEntryId'], withdrawal.reservationEntryId)
  assert.equal(events[0]?.payload['idempotencyKey'], `${USER}:POST /v1/withdrawals:client-key-1`)
})

test('a retry with the same key replays rather than reserving twice', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const first = await request()
  const second = await request()

  assert.equal(second.replayed, true)
  assert.equal(second.withdrawal.id, first.withdrawal.id)
  assert.equal((await sql`select 1 from withdrawals`).length, 1)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), AMOUNT)
})

/* ------------------------------------------------------------------ the two rules */

test('THE RULE: an unverified watch address is refused as a withdrawal destination', { skip }, async () => {
  // 04-domain-model §3.2: "An unverified (`watch`) address may only contribute to portfolio
  // display. It can never be a withdrawal destination or an ownership proof."
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const destination = await watchDestination()

  await assert.rejects(
    () => request({ destination }),
    (err: unknown) =>
      err instanceof WithdrawalError && err.code === 'destination_not_authorised' && err.status === 403,
  )
  // Nothing was written and nothing was reserved.
  assert.equal((await sql`select 1 from withdrawals`).length, 0)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), 0n)
})

test('a verified link without the withdrawal authority is still refused', { skip }, async () => {
  // Verification proves ownership. It does not, on its own, authorise a payout — each
  // authorisation is granted explicitly.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const signer = evmSigner()
  const { challenge } = await createChallenge(sql as never, 'wallet', {
    userId: USER,
    chain: 'ember',
    network: 'testnet',
    address: signer.address,
    origin: 'external',
    domain: DOMAIN,
    uri: URI,
    ttlSeconds: 600,
    correlationId: 'req-0',
  })
  await verifyChallenge(sql as never, 'wallet', {
    userId: USER,
    nonce: challenge!.nonce,
    signature: signer.sign(challenge!.message),
    expectedDomain: DOMAIN,
    expectedUri: URI,
    correlationId: 'req-0',
    authorisations: ['token_owner'],
  })

  await assert.rejects(
    () => request({ destination: signer.address }),
    (err: unknown) => err instanceof WithdrawalError && err.code === 'destination_not_authorised',
  )
})

test('a verified, authorised destination is accepted', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const destination = await verifiedDestination()
  const { withdrawal } = await request({ destination })
  assert.equal(withdrawal.state, 'queued')
  assert.notEqual(withdrawal.destinationWalletId, null)
})

test('THE RULE: concurrent requests cannot over-reserve a balance', { skip }, async () => {
  // One EMBER of balance and two requests for one EMBER each. The ledger serialises them against
  // the real account, so exactly one wins. A read-then-write in this service would let both read
  // "one EMBER available" and both succeed.
  h.ledger.credit(`user:${USER}`, 'EMBER', AMOUNT)

  const results = await Promise.allSettled([
    request({ clientKey: 'client-key-a' }),
    request({ clientKey: 'client-key-b' }),
  ])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1, 'exactly one request may reserve')
  assert.equal(rejected.length, 1)
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'insufficient_funds')

  // The balance never went negative and never over-reserved.
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 0n)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), AMOUNT)

  // The loser is a durable `failed` row with a reason, not a silent absence: a client that
  // retries with the same key replays the failure rather than reserving again.
  const page = await listWithdrawals(sql as never, USER, 10, null)
  assert.equal(page.withdrawals.length, 2)
  assert.deepEqual(page.withdrawals.map((w) => w.state).sort(), ['failed', 'queued'])
  const failed = page.withdrawals.find((w) => w.state === 'failed')!
  assert.match(failed.failureReason ?? '', /insufficient_funds/)
})

test('twenty concurrent requests reserve at most what the balance allows', { skip }, async () => {
  // The same property at a size where an interleaving bug is certain to show rather than lucky.
  h.ledger.credit(`user:${USER}`, 'EMBER', 5n * AMOUNT)
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_v, i) => request({ clientKey: `client-key-${i}` })),
  )
  const won = results.filter((r) => r.status === 'fulfilled').length
  assert.equal(won, 5)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 0n)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), 5n * AMOUNT)
})

/* ------------------------------------------------------------------ destination policy */

test('the platform’s own addresses are refused, across every user', { skip }, async () => {
  // forge-pay's isPlatformAddress spans every user for the same reason: paying a stranger's
  // deposit address would credit THEM, through a real transaction that cost a real fee.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const theirs = await assignDepositAddress(h.deposits, {
    userId: OTHER,
    assetCode: 'EMBER',
    correlationId: 'req-0',
  })
  await assert.rejects(
    () => request({ destination: theirs.address }),
    (err: unknown) => err instanceof WithdrawalError && err.code === 'invalid_destination',
  )
  // And the same address in a different spelling, which is the case forge-pay's withdrawal route
  // carries a paragraph about.
  await assert.rejects(
    () => request({ destination: theirs.address.toLowerCase() }),
    (err: unknown) => err instanceof WithdrawalError && err.code === 'invalid_destination',
  )
})

test('an explicitly listed treasury address is refused', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const treasury = '0x2222222222222222222222222222222222222222'
  await sql`
    insert into platform_addresses (chain, network, address_key, purpose)
    values ('ember', 'testnet', ${treasury}, 'treasury')
  `
  await assert.rejects(
    () => request({ destination: treasury }),
    (err: unknown) => err instanceof WithdrawalError && err.code === 'invalid_destination',
  )
})

test('an address the user has never registered is a permitted one-off', { skip }, async () => {
  // The rule is about what a *link* authorises. An address the user has explicitly registered as
  // watch-only is one they have told us they do not control, and honouring that statement is the
  // point; an unregistered address carries no such statement.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request({
    destination: '0x3333333333333333333333333333333333333333',
  })
  assert.equal(withdrawal.state, 'queued')
  assert.equal(withdrawal.destinationWalletId, null)
})

test('an invalid destination is refused before anything is quoted or reserved', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  await assert.rejects(() => request({ destination: 'not-an-address' }), /0x/)
  assert.equal(h.ledger.entries.length, 0)
})

/* ------------------------------------------------------------------ refusals */

test('a withdrawal below the fee multiple is refused with the number that would work', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  await assert.rejects(
    () => request({ amount: FEE }),
    (err: unknown) =>
      err instanceof WithdrawalError &&
      err.code === 'amount_too_small' &&
      /the smallest EMBER withdrawal is/.test((err as Error).message),
  )
})

test('an asset with no configured fee is refused rather than priced by guessing', { skip }, async () => {
  const noFees = harness(sql, { fees: {} })
  noFees.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  await assert.rejects(
    () =>
      requestWithdrawal(noFees.withdrawals, {
        userId: USER,
        assetCode: 'EMBER',
        destination: '0x1111111111111111111111111111111111111111',
        amount: AMOUNT,
        clientKey: 'client-key-1',
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    (err: unknown) =>
      err instanceof WithdrawalError && err.code === 'fee_unavailable' && err.status === 503,
  )
})

test('SHARD cannot be withdrawn, because it settles on no chain', { skip }, async () => {
  await assert.rejects(
    () => request({ assetCode: 'SHARD' }),
    (err: unknown) => err instanceof WithdrawalError && err.code === 'not_withdrawable',
  )
})

test('a paused deployment refuses with 503 rather than queueing silently', { skip }, async () => {
  const paused = harness(sql)
  const deps = { ...paused.withdrawals, withdrawalsEnabled: false }
  await assert.rejects(
    () =>
      requestWithdrawal(deps, {
        userId: USER,
        assetCode: 'EMBER',
        destination: '0x1111111111111111111111111111111111111111',
        amount: AMOUNT,
        clientKey: 'client-key-1',
        correlationId: 'req-1',
        actor: `user:${USER}`,
      }),
    (err: unknown) => err instanceof WithdrawalError && err.status === 503,
  )
})

/* ------------------------------------------------------------------ what a refusal says */

/**
 * The operator diagnostic `ledger/src/reconcile.ts` writes into `asset_freezes.reason`.
 *
 * Copied in its real shape rather than paraphrased, because the test below is about which parts of
 * it survive the trip to a user, and a paraphrase would let a partial filter pass. Every number in
 * it is invented; the STRUCTURE — custody total, observed total, drift, per-bucket address counts —
 * is the one the reconciler builds.
 */
const OPERATOR_FREEZE_REASON =
  'reconciliation drifted: drift 3 (custody 41000000, observed 40999997 = ' +
  'deposit: 41000000 over 12 addresses, treasury: 0 over 1)'

/** The words that are the estate's business and never the account holder's. */
const TREASURY_WORDS = [/custody/i, /observed/i, /drift/i, /\d+ addresses/i, /41000000/, /40999997/]

test('a reconciliation freeze does not tell the user the estate’s custody position', { skip }, async () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * micro-org#314. The freeze is right; what was said about it was not.
   *
   * `AssetFrozenError.message` is `withdrawals in <ASSET> are frozen: <asset_freezes.reason>`, and
   * that reason is the reconciler's arithmetic for an operator. This service rethrew it verbatim
   * AND wrote it to `withdrawals.failure_reason`, which `GET /v1/withdrawals/:id` returns to the
   * owner for ever after — so a freeze window could be sampled for a time series of the platform's
   * holdings and address topology in the asset, by anyone with an account.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  h.ledger.freezeWithdrawals('EMBER', OPERATOR_FREEZE_REASON)

  const err = await request().then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof WithdrawalError, 'a frozen asset must refuse the withdrawal')
  // The code still classifies it, so a client can branch and an operator can join the logs.
  assert.equal(err.code, 'asset_frozen')
  assert.equal(err.status, 409)
  for (const word of TREASURY_WORDS) {
    assert.equal(word.test(err.message), false, `the refusal returned ${word}: ${err.message}`)
  }
  // And it says something true and usable in its place, rather than merely saying nothing.
  assert.match(err.message, /paused while the platform reconciles/)
  assert.match(err.message, /not a decision about your account/)

  // The durable half. This is the one that outlives the request.
  const page = await listWithdrawals(sql as never, USER, 10, null)
  const failed = page.withdrawals.find((w) => w.state === 'failed')
  assert.ok(failed, 'the refusal is a durable row, so a retry replays it rather than reserving')
  const stored = failed.failureReason ?? ''
  assert.match(stored, /^asset_frozen: /, 'the code is kept — it is what ties the row to the log')
  for (const word of TREASURY_WORDS) {
    assert.equal(word.test(stored), false, `failure_reason stored ${word}: ${stored}`)
  }

  // Nothing moved. A freeze is a refusal, not a partial withdrawal.
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 10n * ONE_EMBER)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), 0n)
})

test('an unrecognised ledger refusal says nothing the ledger wrote', { skip }, async () => {
  // The mapping is closed and its DEFAULT is safe, so a refusal code the ledger adds tomorrow
  // cannot leak by being unlisted here. This is the property that stops #314 coming back through
  // a change made in another repository.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const deps = {
    ...h.withdrawals,
    ledger: {
      ...h.ledger,
      reserve: async () => {
        throw new LedgerRefusedError(409, 'some_future_rule', OPERATOR_FREEZE_REASON)
      },
    },
  }
  const err = await requestWithdrawal(deps, {
    userId: USER,
    assetCode: 'EMBER',
    destination: '0x1111111111111111111111111111111111111111',
    amount: AMOUNT,
    clientKey: 'client-key-1',
    correlationId: 'req-1',
    actor: `user:${USER}`,
  }).then(
    () => null,
    (e: unknown) => e,
  )
  assert.ok(err instanceof WithdrawalError)
  assert.equal(err.code, 'some_future_rule', 'the classification is still carried')
  for (const word of TREASURY_WORDS) {
    assert.equal(word.test(err.message), false, `an unmapped refusal returned ${word}`)
  }
})

/* ------------------------------------------------------------------ settlement */

test('settlement consumes the reservation rather than releasing it', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request()

  const settled = await settleWithdrawal(h.withdrawals, {
    withdrawalId: withdrawal.id,
    txHash: `0x${'ab'.repeat(32)}`,
    correlationId: 'req-2',
    actor: 'service:settlement',
  })
  assert.equal(settled.state, 'settled')
  assert.equal(settled.txHash, `0x${'ab'.repeat(32)}`)

  // The whole amount left the books: `net` went to the user and `fee` went to the miners, but both
  // left custody, so both must leave.
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), 0n)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 9n * ONE_EMBER)
  // Custody held the 10 EMBER that backed the user's balance; the whole withdrawal has now left it.
  // This used to assert `-AMOUNT`, which is a state the ledger's overdraft trigger will not hold —
  // an `asset` account reaches the same check a liability does, and only the fake was lenient.
  assert.equal(h.ledger.balanceOf('custody', 'EMBER', 'available'), 10n * ONE_EMBER - AMOUNT)
  assert.equal(SETTLEMENT_CONFIRMED, 'settlement.outbound.confirmed')
})

test('a refundable failure releases the reservation and gives the money back', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request()

  const refunded = await failWithdrawal(h.withdrawals, {
    withdrawalId: withdrawal.id,
    reason: 'the transaction was never broadcast',
    refundable: true,
    correlationId: 'req-2',
    actor: 'service:settlement',
  })
  assert.equal(refunded.state, 'refunded')
  // A release, not a compensating credit: the pair nets to nothing in the journal, so an auditor
  // reads "held, then not held" rather than two unrelated movements.
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 10n * ONE_EMBER)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), 0n)
  const events = await sql`select 1 from outbox where topic = 'wallet.withdrawal.refunded'`
  assert.equal(events.length, 1)
})

test('THE RULE: an unrefundable failure goes stuck and does NOT return the money', { skip }, async () => {
  // "We do not know" must never refund. Refunding a payment that actually landed pays the user
  // twice, and that error cannot be undone: the coin is already at an address we do not control.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request()

  const stuck = await failWithdrawal(h.withdrawals, {
    withdrawalId: withdrawal.id,
    reason: 'broadcast, fate unknown',
    refundable: false,
    correlationId: 'req-2',
    actor: 'service:settlement',
  })
  assert.equal(stuck.state, 'stuck')
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), AMOUNT)
  assert.equal(SETTLEMENT_FAILED, 'settlement.outbound.failed')
})

test('a stuck withdrawal can still settle or fail — it is not a terminal', { skip }, async () => {
  // forge-pay had no way out of `stuck` at all until CF-07: no route and no worker could move a
  // row out of it, only a hand-written UPDATE, and a reservation sat against a debited user.
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request()
  await failWithdrawal(h.withdrawals, {
    withdrawalId: withdrawal.id,
    reason: 'unknown',
    refundable: false,
    correlationId: 'req-2',
    actor: 'service:settlement',
  })
  const settled = await settleWithdrawal(h.withdrawals, {
    withdrawalId: withdrawal.id,
    txHash: `0x${'cd'.repeat(32)}`,
    correlationId: 'req-3',
    actor: 'service:settlement',
  })
  assert.equal(settled.state, 'settled')
})

test('the stuck sweep moves an overdue withdrawal once and tells somebody', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request()
  await sql`update withdrawals set updated_at = now() - interval '2 hours' where id = ${withdrawal.id}`

  assert.equal(await sweepStuck(h.withdrawals), 1)
  assert.equal((await findWithdrawal(sql as never, withdrawal.id))?.state, 'stuck')
  // A second pass must not emit a second page.
  assert.equal(await sweepStuck(h.withdrawals), 0)
  const events = await sql`select 1 from outbox where topic = 'wallet.withdrawal.stuck'`
  assert.equal(events.length, 1)
  // The money is still held, because the payment may have landed.
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'reserved'), AMOUNT)
})

/**
 * #221, from the balance's end: the held amount must READ as held.
 *
 * The notification half of that defect told a user "Nothing has left your balance" while a stuck
 * withdrawal was holding it. The sentence was only believable because a reader who then checked
 * their balance had to be shown the truth — so this pins the property the corrected wording now
 * points at: `available` and `reserved` are two numbers, they differ by exactly the amount in
 * flight, and nothing sums them into one figure that would make held money look spendable.
 *
 * The split is two ACCOUNTS, not two columns (04-domain-model §2.1), which is why this is a
 * property of the portfolio read and not of a formatting helper.
 */
test('a stuck withdrawal shows as reserved, and never as available', { skip }, async () => {
  const funded = 10n * ONE_EMBER
  h.ledger.credit(`user:${USER}`, 'EMBER', funded)
  const { withdrawal } = await request()
  await sql`update withdrawals set updated_at = now() - interval '2 hours' where id = ${withdrawal.id}`
  assert.equal(await sweepStuck(h.withdrawals), 1)
  assert.equal((await findWithdrawal(sql as never, withdrawal.id))?.state, 'stuck')

  const portfolio = await readPortfolio(h.portfolio, { userId: USER })
  const rows = portfolio.balances.filter((b) => b.assetCode === 'EMBER')
  const available = rows.find((b) => b.purpose === 'available')
  const reserved = rows.find((b) => b.purpose === 'reserved')

  // Two rows, each naming what it is. A single collapsed figure is the shape that lets held money
  // be read as spendable, and it is what the mail's old wording assumed.
  assert.ok(available, 'no available row')
  assert.ok(reserved, 'the held amount is invisible in the portfolio')
  assert.notEqual(available.purpose, reserved.purpose)

  // The reserved figure is the requested amount. The fee comes OUT of it rather than on top, so a
  // user can always withdraw their whole balance — the reservation is exactly what was asked for.
  const held = AMOUNT
  assert.equal(reserved.amount, held.toString())
  assert.notEqual(reserved.amount, '0')
  // And available EXCLUDES it. This is the assertion the false sentence contradicted: the money
  // did leave the available balance, at request time, and going stuck did not give it back.
  assert.equal(available.amount, (funded - held).toString())
  assert.notEqual(available.amount, funded.toString(), 'available still shows the held amount as spendable')
  assert.notEqual(available.amount, reserved.amount, 'available and reserved must read as different numbers')

  // Smallest units and the decimal rendering are separate fields, and the formatted one is scaled
  // rather than being the integer restated — #199 is the defect where those two get confused.
  assert.equal(reserved.amount, '1000000000000000000')
  assert.equal(reserved.amountFormatted, '1')
  assert.notEqual(reserved.amountFormatted, reserved.amount)
})

test('an illegal transition is refused rather than applied', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 10n * ONE_EMBER)
  const { withdrawal } = await request()
  await settleWithdrawal(h.withdrawals, {
    withdrawalId: withdrawal.id,
    txHash: `0x${'ab'.repeat(32)}`,
    correlationId: 'req-2',
    actor: 'service:settlement',
  })
  await assert.rejects(
    () =>
      failWithdrawal(h.withdrawals, {
        withdrawalId: withdrawal.id,
        reason: 'too late',
        refundable: true,
        correlationId: 'req-3',
        actor: 'service:settlement',
      }),
    (err: unknown) => err instanceof WithdrawalError && err.code === 'illegal_transition',
  )
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 9n * ONE_EMBER)
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * LITECOIN, THROUGH THE WHOLE REQUEST PATH.
 *
 * `addresses.test.ts` proves the validator against published vectors. This proves the SERVICE uses
 * it: the asset gate, the address gate and the database constraint are three separate places that
 * each had to learn about `ltc`, and a unit test of the validator passes while any of them still
 * refuses. Migration 10 in particular is invisible to every other test here — `chain = 'ltc'`
 * violates the check constraint migrations 5 to 9 shipped with, and the row insert is the only
 * thing that finds out.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Litecoin Core's own published vector, `src/test/data/key_io_valid.json`, chain `test`. */
const LTC_DESTINATION = 'tltc1qpftpsvdn6mjp8celrkj0qxqy4jlapl959rlwg9'
/** Bitcoin Core's, same file. A valid address — on the wrong chain. */
const BTC_DESTINATION = 'tb1qcrh3yqn4nlleplcez2yndq2ry8h9ncg3qh7n54'

test('LITECOIN: a withdrawal is accepted and the row carries chain ltc', { skip }, async () => {
  // The fee table is per asset, and LTC was absent from it as well as from the chain map — an
  // asset with no quote refuses 503 `fee_unavailable` rather than being priced by guessing.
  const ltc = harness(sql, { fees: { LTC: 200n } })
  ltc.ledger.credit(`user:${USER}`, 'LTC', 1_000_000n)
  const { withdrawal } = await requestWithdrawal(ltc.withdrawals, {
    userId: USER,
    assetCode: 'LTC',
    destination: LTC_DESTINATION,
    amount: 100_000n,
    clientKey: 'ltc-1',
    correlationId: 'req-ltc',
    actor: `user:${USER}`,
  })

  assert.equal(withdrawal.chain, 'ltc')
  assert.equal(withdrawal.assetCode, 'LTC')
  assert.equal(withdrawal.destination, LTC_DESTINATION)

  // The row is really in the table, which is the only proof migration 10 widened the constraint:
  // before it, this insert failed with `withdrawals_chain_ck`.
  const rows = await sql<{ chain: string }[]>`select chain from withdrawals where id = ${withdrawal.id}`
  assert.equal(rows[0]?.chain, 'ltc')
})

test('LITECOIN: a Bitcoin address is refused as a Litecoin destination', { skip }, async () => {
  // The defect that loses coins, refused at the point a user could still fix it — before the
  // balance is reserved and before anything is queued.
  const ltc = harness(sql, { fees: { LTC: 200n } })
  await assert.rejects(
    () =>
      requestWithdrawal(ltc.withdrawals, {
        userId: USER,
        assetCode: 'LTC',
        destination: BTC_DESTINATION,
        amount: 100_000n,
        clientKey: 'ltc-2',
        correlationId: 'req-ltc',
        actor: `user:${USER}`,
      }),
    AddressError,
  )
  // Nothing was written, so the refusal is genuinely before the row rather than a rollback.
  const rows = await sql<{ id: string }[]>`select id from withdrawals`
  assert.equal(rows.length, 0)
})

test('LITECOIN: a deposit address can be assigned, which is the other half of the gap', { skip }, async () => {
  // `assignDepositAddress` refused LTC with 400 `not_depositable` for exactly the same reason the
  // withdrawal refused it with 422: `chainForAsset('LTC')` was null.
  const ltc = harness(sql)
  const assignment = await assignDepositAddress(ltc.deposits, {
    userId: USER,
    assetCode: 'LTC',
    correlationId: 'req-ltc',
  })
  assert.equal(assignment.chain, 'ltc')
  assert.equal(assignment.assetCode, 'LTC')
})

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 * DOGECOIN AND ETHEREUM CLASSIC, THROUGH THE WHOLE REQUEST PATH.
 *
 * The same argument the Litecoin block above makes, and it is worth repeating rather than pointing
 * at, because the thing being proved is not the validator: `addresses.test.ts` does that against
 * Core's published vectors. What these prove is that the SERVICE uses it — the asset gate
 * (`chainForAsset`), the address gate (`canonicaliseAddress`) and MIGRATION 12 are three separate
 * places that each had to learn these two chains, and a green unit suite says nothing about any of
 * them.
 *
 * **Migration 12 is invisible to every other test in this file.** `chain = 'doge'` violates the
 * check constraint migration 10 shipped with, and the insert below is the only thing that finds
 * out. That is exactly how migration 10 was proved, and it is why these are database tests rather
 * than more assertions in `addresses.test.ts`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** Dogecoin Core's own published vector, `src/test/data/base58_keys_valid.json`, `isTestnet: true`. */
const DOGE_DESTINATION = 'nhRsrUaxZou6sewjqaS37cJrMRJRgwVXdk'

test('DOGECOIN: a withdrawal is accepted and the row carries chain doge', { skip }, async () => {
  // The fee table is per asset and DOGE is absent from every deployed one, which is a fail-closed
  // 503 `fee_unavailable` rather than a guess — so the quote has to be supplied here to reach the
  // part of the path this test is about.
  const doge = harness(sql, { fees: { DOGE: 200n } })
  doge.ledger.credit(`user:${USER}`, 'DOGE', 1_000_000n)
  const { withdrawal } = await requestWithdrawal(doge.withdrawals, {
    userId: USER,
    assetCode: 'DOGE',
    destination: DOGE_DESTINATION,
    amount: 100_000n,
    clientKey: 'doge-1',
    correlationId: 'req-doge',
    actor: `user:${USER}`,
  })

  assert.equal(withdrawal.chain, 'doge')
  assert.equal(withdrawal.assetCode, 'DOGE')
  // Base58, and stored byte-for-byte. Unlike a bech32 destination it is NOT lower-cased, because
  // case is significant in base58check — lower-casing this address would change the payload and
  // fail the checksum, which is why `canonicaliseBitcoinFamily` only folds case on the bech32 path.
  assert.equal(withdrawal.destination, DOGE_DESTINATION)

  const rows = await sql<{ chain: string }[]>`select chain from withdrawals where id = ${withdrawal.id}`
  assert.equal(rows[0]?.chain, 'doge', 'migration 12 did not widen withdrawals_chain_ck')
})

test('DOGECOIN: a segwit destination is refused, because Dogecoin has no segwit at all', { skip }, async () => {
  /*
   * The Litecoin case one section up refuses a Bitcoin address for a Litecoin withdrawal. This is
   * the stronger version of it: `tltc1…` is not merely the wrong chain's address, it is a FORM
   * Dogecoin does not have. `src/chainparams.cpp` declares no bech32 HRP on any network, so there
   * is no Dogecoin string of this shape for a user to have meant, and accepting one would reserve
   * their balance against an output that cannot exist.
   */
  const doge = harness(sql, { fees: { DOGE: 200n } })
  for (const destination of [LTC_DESTINATION, BTC_DESTINATION]) {
    await assert.rejects(
      () =>
        requestWithdrawal(doge.withdrawals, {
          userId: USER,
          assetCode: 'DOGE',
          destination,
          amount: 100_000n,
          clientKey: `doge-${destination}`,
          correlationId: 'req-doge',
          actor: `user:${USER}`,
        }),
      AddressError,
      `${destination} was accepted as a Dogecoin destination`,
    )
  }
  // Nothing was written, so the refusal is genuinely before the row and before the reservation.
  const rows = await sql<{ id: string }[]>`select id from withdrawals`
  assert.equal(rows.length, 0)
})

test('DOGECOIN: a deposit address can be assigned, which is the other half of the gap', { skip }, async () => {
  const doge = harness(sql)
  const assignment = await assignDepositAddress(doge.deposits, {
    userId: USER,
    assetCode: 'DOGE',
    correlationId: 'req-doge',
  })
  assert.equal(assignment.chain, 'doge')
  assert.equal(assignment.assetCode, 'DOGE')
  // The fake custody answers from a pool of Dogecoin Core's published testnet vectors, so this
  // address survived `canonicaliseAddress` on the Dogecoin path rather than on a permissive one.
  assert.equal(assignment.address.startsWith('n'), true)
})

test('ETHEREUM CLASSIC: a withdrawal carries chain etc and never eth', { skip }, async () => {
  /*
   * ETC's address IS Ethereum's, so nothing in the destination distinguishes the two and the
   * `chain` column is the only thing that routes this payment to the right network. Reserving a
   * user's ETC and then settling it on Ethereum is a payment to an address they may not control on
   * that chain, from a balance they will not get back — so the column is asserted from the
   * database rather than from the returned record.
   */
  const etc = harness(sql, { fees: { ETC: 21_000_000_000_000n } })
  etc.ledger.credit(`user:${USER}`, 'ETC', 10n * ONE_EMBER)
  const destination = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
  const { withdrawal } = await requestWithdrawal(etc.withdrawals, {
    userId: USER,
    assetCode: 'ETC',
    destination,
    amount: AMOUNT,
    clientKey: 'etc-1',
    correlationId: 'req-etc',
    actor: `user:${USER}`,
  })

  assert.equal(withdrawal.chain, 'etc')
  assert.equal(withdrawal.assetCode, 'ETC')
  // Display form is EIP-55 and the comparison form is lower-cased, the same as every other EVM
  // chain — the whole of this file's two-forms rule applies unchanged.
  assert.equal(withdrawal.destination, destination)

  const rows = await sql<{ chain: string; destination_key: string }[]>`
    select chain, destination_key from withdrawals where id = ${withdrawal.id}
  `
  assert.equal(rows[0]?.chain, 'etc', 'migration 12 did not widen withdrawals_chain_ck')
  assert.equal(rows[0]?.destination_key, destination.toLowerCase())
})

test('ETHEREUM CLASSIC: a deposit address can be assigned', { skip }, async () => {
  const etc = harness(sql)
  const assignment = await assignDepositAddress(etc.deposits, {
    userId: USER,
    assetCode: 'ETC',
    correlationId: 'req-etc',
  })
  assert.equal(assignment.chain, 'etc')
  assert.equal(assignment.assetCode, 'ETC')
})
