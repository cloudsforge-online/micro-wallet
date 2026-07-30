import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { assignDepositAddress } from './deposits.ts'
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
  assert.equal(h.ledger.balanceOf('custody', 'EMBER', 'available'), -AMOUNT)
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
