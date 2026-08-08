import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { canonicaliseAddress } from './addresses.ts'
import {
  activeAssignment,
  assignDepositAddress,
  depositCreditKey,
  handleDepositConfirmed,
  listCredits,
  pendingCredits,
  postCredit,
  unwatchedAssignments,
} from './deposits.ts'
import { INDEXER_DEPOSIT_CONFIRMED } from './outbox.ts'
import {
  depositPayload,
  enabled,
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

/** Deliver an event, as the indexer's relay would. */
const deliver = (eventId: string, overrides: Record<string, unknown> = {}) =>
  handleDepositConfirmed(h.deposits, {
    eventId,
    topic: INDEXER_DEPOSIT_CONFIRMED,
    payload: depositPayload(overrides) as never,
    correlationId: 'req-1',
  })

/** Assign an address and return the payload overrides that will credit it. */
async function assigned(userId = USER): Promise<{ address: string; assignmentId: string }> {
  const assignment = await assignDepositAddress(h.deposits, {
    userId,
    assetCode: 'EMBER',
    correlationId: 'req-0',
  })
  return { address: assignment.address, assignmentId: assignment.id }
}

/* ------------------------------------------------------------------ assignment */

test('an assignment mints one address, registers it, and is idempotent', { skip }, async () => {
  const first = await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'req-1',
  })
  const second = await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'req-2',
  })

  // A user who taps "deposit" twice must get one address. A second would be an address nobody
  // told them about and nobody is watching.
  assert.equal(second.id, first.id)
  assert.equal(second.address, first.address)
  assert.equal(h.custody.minted.length, 1, 'custody must not be asked twice')
  assert.equal(h.indexer.watched.length, 1)
  assert.equal(h.indexer.watched[0]?.address, first.address)
  assert.notEqual(first.watchedAt, null)
  // Registered WITH the claim: this call minted the key, so "nothing can have paid it before now"
  // is a fact here. It is what makes the address's balance derivable on a UTXO chain the indexer
  // did not walk from genesis. micro-org#252.
  assert.equal(h.indexer.watched[0]?.freshlyDerived, true)

  // A managed wallet was created for it, and it carries the custody key.
  const wallets = await sql<{ origin: string; custody_key_urn: string | null }[]>`
    select origin, custody_key_urn from wallets
  `
  assert.equal(wallets.length, 1)
  assert.equal(wallets[0]?.origin, 'managed')
  assert.equal(wallets[0]?.custody_key_urn, first.custodyKeyUrn)
})

test('SHARD has no chain, so a deposit address for it is refused rather than invented', { skip }, async () => {
  await assert.rejects(
    () => assignDepositAddress(h.deposits, { userId: USER, assetCode: 'SHARD', correlationId: 'r' }),
    /does not settle on a chain/,
  )
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ADDRESS NOTHING WATCHES IS WORSE THAN NO ADDRESS AT ALL.**
 *
 * `custody/src/hd.ts` derives a genuine BIP-84 Bitcoin address, and `micro-indexer` follows one
 * chain per estate (`INDEXER_CHAINS=ember:mainnet`, measured on the running container). So a user
 * could be shown a real address, send real BTC to it, and nothing would observe, credit or display
 * it — the key is in custody so the coins are recoverable by a human, but from their side the money
 * vanishes with no error and from the estate's side there is no record it arrived.
 *
 * The refusal is derived from what the indexer reports, never from a list here: a second hardcoded
 * list of supported chains is precisely how the estate came to offer that address, because
 * `explorer-web` had one and the indexer disagreed with it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('refuses a deposit address for a chain this estate cannot observe', { skip }, async () => {
  h.indexer.setProviders('btc', 'testnet', 0)
  await assert.rejects(
    () => assignDepositAddress(h.deposits, { userId: USER, assetCode: 'BTC', correlationId: 'r' }),
    (err: unknown) =>
      err instanceof Error &&
      /not available on this deployment yet/.test(err.message) &&
      /nothing would be watching it/.test(err.message),
  )
  // Nothing was minted and nothing was filed. A refusal that still burned a custody key would leave
  // an address nobody was told about and a row this service would have to reconcile later.
  assert.equal(h.custody.minted.length, 0)
  const rows = await sql`select count(*)::int as n from deposit_address_assignments`
  assert.equal(rows[0]!.n, 0)
})

test('opens the moment the indexer reports a provider, with no code change', { skip }, async () => {
  h.indexer.setProviders('btc', 'testnet', 0)
  await assert.rejects(() => assignDepositAddress(h.deposits, { userId: USER, assetCode: 'BTC', correlationId: 'r' }))
  // What an operator configuring a provider looks like from here. No redeploy, no allowlist edit.
  h.indexer.setProviders('btc', 'testnet', 1)
  const assignment = await assignDepositAddress(h.deposits, { userId: USER, assetCode: 'BTC', correlationId: 'r' })
  assert.equal(assignment.chain, 'btc')
})

/**
 * The gate runs BEFORE the find-or-create, and that ordering is the substance rather than a detail.
 * An address issued yesterday is exactly as unwatched today as one minted now, so a chain that
 * stops being observable has to stop being HANDED OUT and not merely stop being minted.
 */
test('stops handing out an address that already exists once the chain stops being watched', { skip }, async () => {
  const issued = await assignDepositAddress(h.deposits, { userId: USER, assetCode: 'BTC', correlationId: 'r' })
  assert.ok(issued.address)
  h.indexer.setProviders('btc', 'testnet', 0)
  await assert.rejects(
    () => assignDepositAddress(h.deposits, { userId: USER, assetCode: 'BTC', correlationId: 'r' }),
    /not available on this deployment yet/,
  )
})

test('THE RULE: a rotation is a NEW assignment, and the old address still credits', { skip }, async () => {
  // forge-pay mutates the address on the existing row, and because the same row carries the
  // observed high-water mark, the new address starts below it: every probe afterwards reports a
  // regression and crediting stops permanently for that user and coin.
  const first = await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'req-1',
  })
  const second = await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'req-2',
    rotate: true,
  })

  assert.notEqual(second.id, first.id)
  assert.notEqual(second.address, first.address)
  assert.equal(second.supersedesId, first.id)

  const rows = await sql<{ id: string; status: string; address: string }[]>`
    select id, status, address from deposit_address_assignments order by assigned_at
  `
  assert.equal(rows.length, 2, 'the old assignment must still exist')
  assert.equal(rows[0]?.status, 'rotated')
  assert.equal(rows[0]?.address, first.address, 'the old address row must not be mutated')
  assert.equal(rows[1]?.status, 'active')

  // The whole point: money arriving at the retired address is still the user's.
  const decision = await deliver('11111111-1111-4111-8111-111111111111', {
    address: first.address,
  })
  assert.equal(decision.kind, 'credited')
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 1_000_000_000_000_000_000n)
})

test('an unwatched assignment is found by the retry job and repaired on the next read', { skip }, async () => {
  // An unwatched deposit address produces no deposit events, so this is not cosmetic.
  h.indexer.failNext(new Error('indexer down'))
  const assignment = await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'req-1',
  })
  assert.equal(assignment.watchedAt, null)
  assert.deepEqual((await unwatchedAssignments(sql as never, 10)).map((a) => a.id), [assignment.id])

  const reread = await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'req-2',
  })
  assert.notEqual(reread.watchedAt, null)
  assert.equal((await unwatchedAssignments(sql as never, 10)).length, 0)

  // AND THE REPAIR MAKES NO CLAIM ABOUT THE ADDRESS'S PAST.
  //
  // `freshlyDerived` says "nothing can have paid this before now", which the mint path can state
  // as a fact and this path cannot: the address was handed to the user on `req-1`, whether or not
  // the registration succeeded. On a UTXO chain the indexer uses that claim to decide its own
  // walked record reaches far enough back to derive a balance — so a false one lets it answer with
  // a real deposit missing, which is positive drift at the ledger and a freeze on a solvent asset.
  // The honest answer here is silence, and a `history_unknown` refusal downstream. micro-org#252.
  assert.deepEqual(h.indexer.watched.map((w) => w.freshlyDerived), [false])
})

/* ------------------------------------------------------------------ crediting */

test('THE RULE: a redelivered deposit event credits exactly once', { skip }, async () => {
  const { address } = await assigned()

  const first = await deliver('aaaaaaaa-0000-4000-8000-000000000001', { address })
  const redelivery = await deliver('aaaaaaaa-0000-4000-8000-000000000001', { address })

  assert.equal(first.kind, 'credited')
  assert.equal(redelivery.kind, 'duplicate')

  // One local row, one ledger entry, one balance.
  const credits = await sql`select 1 from deposit_credits`
  assert.equal(credits.length, 1)
  assert.equal(h.ledger.entries.length, 1)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 1_000_000_000_000_000_000n)
  // And the custody asset side moved by the same amount, so the entry balanced.
  assert.equal(h.ledger.balanceOf('custody', 'EMBER', 'available'), 1_000_000_000_000_000_000n)
})

test('THE RULE: a DIFFERENT event for the same movement also credits only once', { skip }, async () => {
  // The inbox cannot catch this one: two event ids, one on-chain movement. It is what the indexer
  // produces when a reorg drops a transaction and it later returns to depth, and it is why
  // `credit_key` exists as a second belt rather than as belt-and-braces decoration.
  const { address } = await assigned()

  const first = await deliver('aaaaaaaa-0000-4000-8000-000000000001', { address })
  const second = await deliver('bbbbbbbb-0000-4000-8000-000000000002', { address })

  assert.equal(first.kind, 'credited')
  assert.equal(second.kind, 'duplicate')
  assert.equal((await sql`select 1 from deposit_credits`).length, 1)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 1_000_000_000_000_000_000n)
})

test('the credit key is derived from the movement, not from the event', { skip }, async () => {
  const key = depositCreditKey('ember', 'testnet', `0x${'AB'.repeat(32)}`, 3)
  // Lower-cased, so a hash spelled either way is one movement.
  assert.equal(key, `wallet:deposit:ember:testnet:0x${'ab'.repeat(32)}:3`)
  // A native transfer has no log, and `native` is spelled rather than left to make an empty
  // segment — two movements in one transaction differ here and are two credits, correctly.
  assert.match(depositCreditKey('ember', 'testnet', '0xff', null), /:native$/)
})

test('two movements in one transaction are two credits', { skip }, async () => {
  const { address } = await assigned()
  const txHash = `0x${'cd'.repeat(32)}`
  await deliver('aaaaaaaa-0000-4000-8000-000000000001', { address, txHash, logIndex: 0 })
  await deliver('aaaaaaaa-0000-4000-8000-000000000002', { address, txHash, logIndex: 1 })
  assert.equal((await sql`select 1 from deposit_credits`).length, 2)
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 2_000_000_000_000_000_000n)
})

test('the ledger idempotency key is the credit key, so the two cannot disagree', { skip }, async () => {
  const { address } = await assigned()
  await deliver('aaaaaaaa-0000-4000-8000-000000000001', { address })
  const expected = depositCreditKey('ember', 'testnet', depositPayload().txHash as string, null)
  assert.deepEqual(h.ledger.keys, [expected])
})

test('a deposit to an address we do not know is consumed, not retried for ever', { skip }, async () => {
  // Ignored rather than thrown: throwing would roll back the inbox row and the event would be
  // redelivered for ever. A decision not to act must be a decision, not a crash.
  const decision = await deliver('aaaaaaaa-0000-4000-8000-000000000001', {
    address: '0x000000000000000000000000000000000000dead',
  })
  assert.deepEqual(decision, { kind: 'ignored', reason: 'unknown_address' })
  assert.equal((await sql`select 1 from inbox`).length, 1, 'the event was consumed')
  assert.equal(h.ledger.entries.length, 0)
})

test('every refusal is a stated reason rather than a silent drop', { skip }, async () => {
  const { address } = await assigned()
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ direction: 'out' }, 'outbound_movement'],
    [{ network: 'mainnet' }, 'wrong_network'],
    [{ assetKind: 'token', tokenAddress: '0xabc' }, 'token_deposit_unsupported'],
    // Below EMBER's published depth of 60. **Re-checked here against contracts-chain rather than
    // trusted from the payload** — this is the one input that could credit money too early.
    [{ confirmations: 59 }, 'below_confirmation_depth'],
    [{ amount: '0' }, 'non_positive_amount'],
    [{ amount: 'not-a-number' }, 'unparseable_amount'],
    [{ assetCode: 'ETH' }, 'asset_chain_mismatch'],
  ]
  let n = 0
  for (const [overrides, reason] of cases) {
    n += 1
    const decision = await deliver(`cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`, {
      address,
      ...overrides,
    })
    assert.deepEqual(decision, { kind: 'ignored', reason }, `wrong reason for ${JSON.stringify(overrides)}`)
  }
  assert.equal(h.ledger.entries.length, 0)
})

test('a deposit at exactly the published depth is credited', { skip }, async () => {
  // The boundary. `confirmationsAt` in the indexer counts the containing block as the first
  // confirmation, and forge-pay's sweep maturity carries a long comment about settling for
  // `>= depth` versus `>= depth + 1`; one block either way is the same bug as sixty.
  const { address } = await assigned()
  const decision = await deliver('dddddddd-0000-4000-8000-000000000001', {
    address,
    confirmations: 60,
  })
  assert.equal(decision.kind, 'credited')
})

test('an address is matched case-insensitively on EVM families', { skip }, async () => {
  // A deposit invisible because of letter case is indistinguishable from one that never arrived.
  const { address } = await assigned()
  const decision = await deliver('eeeeeeee-0000-4000-8000-000000000001', {
    address: address.toUpperCase().replace('0X', '0x'),
  })
  assert.equal(decision.kind, 'credited')
})

test('a deposit credits the owner of the address, not the sender of the event', { skip }, async () => {
  const mine = await assigned(USER)
  await assigned(OTHER)
  await deliver('ffffffff-0000-4000-8000-000000000001', { address: mine.address })
  assert.equal(h.ledger.balanceOf(`user:${USER}`, 'EMBER', 'available'), 1_000_000_000_000_000_000n)
  assert.equal(h.ledger.balanceOf(`user:${OTHER}`, 'EMBER', 'available'), 0n)
})

/* ------------------------------------------------------------------ the pending path */

test('a credit whose ledger posting failed is visible, retriable, and posts once', { skip }, async () => {
  const { address } = await assigned()
  // The ledger is unreachable at the moment the event arrives.
  const broken = harness(sql)
  const deps = {
    ...broken.deposits,
    ledger: {
      ...broken.ledger,
      postEntry: async () => {
        throw new Error('ledger unreachable')
      },
    },
  }
  await assert.rejects(
    () =>
      handleDepositConfirmed(deps as never, {
        eventId: '99999999-0000-4000-8000-000000000001',
        topic: INDEXER_DEPOSIT_CONFIRMED,
        payload: depositPayload({ address }) as never,
        correlationId: 'req-1',
      }),
    /ledger unreachable/,
  )

  // The claim committed and the posting did not. That is a visible, queryable, retriable state —
  // and it is the ordering chosen deliberately, because the reverse would be a ledger entry this
  // service does not know it made, which the next redelivery would double.
  const pending = await pendingCredits(sql as never, 10)
  assert.equal(pending.length, 1)
  const page = await listCredits(sql as never, USER, 10, null)
  assert.equal(page.credits[0]?.credited, false, 'shown as not yet credited, never hidden')

  await postCredit(broken.deposits, pending[0]!, 'retry-1')
  assert.equal((await pendingCredits(sql as never, 10)).length, 0)
  assert.equal(broken.ledger.entries.length, 1)

  // Posting again is a no-op rather than a second entry.
  await postCredit(broken.deposits, pending[0]!, 'retry-2')
  assert.equal(broken.ledger.entries.length, 1)
})

test('a credited deposit emits exactly one event, with a transaction reference', { skip }, async () => {
  const { address } = await assigned()
  await deliver('aaaaaaaa-0000-4000-8000-000000000001', { address })
  const events = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
    select topic, payload from outbox where topic = 'wallet.deposit.confirmed'
  `
  assert.equal(events.length, 1)
  // The first deposit event in the estate to carry a real transaction hash and an explorer link.
  assert.match(String(events[0]?.payload['txUrn']), /^cf:chain:ember:testnet:0x/)
  assert.match(String(events[0]?.payload['explorerUrl']), /^https:\/\//)
  assert.equal(events[0]?.payload['amountFormatted'], '1')
})

test('the assignment lookup is scoped to the deployment network', { skip }, async () => {
  const { address } = await assigned()
  const mainnet = harness(sql, { network: 'mainnet' })
  const decision = await handleDepositConfirmed(mainnet.deposits, {
    eventId: 'aaaaaaaa-0000-4000-8000-000000000009',
    topic: INDEXER_DEPOSIT_CONFIRMED,
    payload: depositPayload({ address }) as never,
    correlationId: 'req-1',
  })
  // 00-current-state §3.5: on XRP the same address is valid on both networks, so a record without
  // a network binding describes two different pots of money.
  assert.deepEqual(decision, { kind: 'ignored', reason: 'wrong_network' })
})

test('the stored address key is the comparison form, not the display form', { skip }, async () => {
  const assignment = await assigned()
  const row = await sql<{ address: string; address_key: string }[]>`
    select address, address_key from deposit_address_assignments
  `
  const canonical = canonicaliseAddress('ember', assignment.address)
  assert.equal(row[0]?.address, canonical.address)
  assert.equal(row[0]?.address_key, canonical.key)
  assert.equal(row[0]?.address_key, row[0]?.address.toLowerCase())
})

test('the active-assignment index permits exactly one per (user, asset, network)', { skip }, async () => {
  await assigned()
  await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'r',
    rotate: true,
  })
  const active = await activeAssignment(sql as never, USER, 'EMBER', 'testnet')
  assert.notEqual(active, null)
  const count = await sql<{ n: number }[]>`
    select count(*)::int as n from deposit_address_assignments where status = 'active'
  `
  assert.equal(count[0]?.n, 1)
})
