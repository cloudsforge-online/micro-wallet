import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type postgres from 'postgres'
import { assignDepositAddress } from './deposits.ts'
import { createChallenge } from './links.ts'
import { readPortfolio } from './portfolio.ts'
import { withOutbox } from './outbox.ts'
import {
  WalletError,
  canTransition,
  findWallet,
  insertWallet,
  isPlatformAddress,
  listWallets,
  setPrimary,
  transitionWallet,
} from './wallets.ts'
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

/**
 * Every transition carries who and why.
 *
 * `StatusChange` is a required parameter rather than an optional one, so this helper is not a
 * convenience — there is no way to call `transitionWallet` without it, which is the property
 * micro-org#315 asked for: no wallet in this service changes lifecycle with nothing recorded.
 */
const by = (reason: string) => ({ actor: `user:${USER}`, reason })

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

const create = (overrides: Record<string, unknown> = {}) =>
  withOutbox(sql as never, 'wallet', async (tx) =>
    insertWallet(tx, 'wallet', {
      userId: USER,
      origin: 'watch',
      chain: 'ember',
      network: 'testnet',
      address: evmSigner().address,
      actor: `user:${USER}`,
      correlationId: 'req-1',
      status: 'active',
      ...overrides,
    } as never),
  )

/* ------------------------------------------------------------------ the registry */

test('the origin invariant is a constraint, not a convention', { skip }, async () => {
  // An external wallet carrying a custody key would claim the platform holds a key it does not; a
  // managed wallet without one is a wallet nothing can ever sign for.
  await assert.rejects(
    () => create({ origin: 'managed' }),
    (err: unknown) => err instanceof WalletError && err.code === 'custody_key_required',
  )
  await assert.rejects(
    () => create({ origin: 'external', custodyKeyUrn: 'cf:custody:key:1' }),
    (err: unknown) => err instanceof WalletError && err.code === 'custody_key_forbidden',
  )
  // And the database refuses it too, so a path that bypassed the store could not write it either.
  await assert.rejects(
    () => sql`
      insert into wallets (id, user_id, origin, chain, network, address, address_key)
      values (gen_random_uuid(), ${USER}, 'managed', 'ember', 'testnet', '0xaa', '0xaa')
    `,
    /wallets_custody_urn_ck/,
  )
})

test('THERE IS NO BALANCE COLUMN, and that is the point', { skip }, async () => {
  // 04-domain-model §11: "No 'user balance' column anywhere outside the ledger's projection… A
  // cached balance in a product database is the bug that made Crucible's bot state diverge from
  // Pay's." A column added here would be a second, unreconcilable source of truth for money.
  const columns = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns where table_name = 'wallets'
  `
  const names = columns.map((c) => c.column_name)
  for (const forbidden of ['balance', 'amount', 'shards', 'available', 'last_seen', 'swept']) {
    assert.equal(names.includes(forbidden), false, `wallets must not have a ${forbidden} column`)
  }
})

test('at most one primary wallet per (user, chain, network)', { skip }, async () => {
  const first = await create({ isPrimary: true })
  const second = await create({ address: evmSigner().address })

  await assert.rejects(
    () => sql`update wallets set is_primary = true where id = ${second.wallet.id}`,
    /wallets_primary_uniq/,
  )
  // The store does both statements in one transaction, so no window exists in which the user has
  // no primary wallet at all.
  const promoted = await setPrimary(sql as never, second.wallet.id)
  assert.equal(promoted.isPrimary, true)
  assert.equal((await findWallet(sql as never, first.wallet.id))?.isPrimary, false)
})

test('the same address twice is one row, not two lifecycles', { skip }, async () => {
  const address = evmSigner().address
  const first = await create({ address })
  const second = await create({ address: address.toLowerCase() })
  assert.equal(second.created, false)
  assert.equal(second.wallet.id, first.wallet.id)
  // Two users may each watch the same address, though: it is their wallet list, not the address's.
  const theirs = await create({ address, userId: OTHER })
  assert.equal(theirs.created, true)
  assert.notEqual(theirs.wallet.id, first.wallet.id)
})

test('the lifecycle table is what §3.1 says, and export is irreversible', { skip }, async () => {
  assert.equal(canTransition('provisioning', 'active'), true)
  assert.equal(canTransition('active', 'frozen'), true)
  assert.equal(canTransition('frozen', 'active'), true, 'a freeze is reversible')
  // There is no operation that can un-know a key, so there is no transition out of `exported`.
  assert.equal(canTransition('exported', 'active'), false)
  assert.equal(canTransition('exported', 'retired'), false)
  assert.equal(canTransition('retired', 'active'), false)
  assert.equal(canTransition('active', 'retired'), false, 'retirement goes through retiring')
})

test('a transition is checked in the row’s own UPDATE, not by a read then a write', { skip }, async () => {
  const { wallet } = await create()
  await transitionWallet(sql as never, wallet.id, 'exported', by('the owner took the key'))
  await assert.rejects(
    () => transitionWallet(sql as never, wallet.id, 'active', by('undo')),
    (err: unknown) => err instanceof WalletError && err.code === 'illegal_transition',
  )
  // A wallet leaving service must not remain the primary one, or the next deposit assignment would
  // target a wallet the user told us to stop using.
  const primary = await create({ address: evmSigner().address, isPrimary: true })
  const exported = await transitionWallet(sql as never, primary.wallet.id, 'exported', by('the owner took the key'))
  assert.equal(exported.isPrimary, false)
})

test('the platform-address lookup spans every user', { skip }, async () => {
  // forge-pay's isPlatformAddress: "paying a stranger's deposit address would credit THEM."
  const theirs = await assignDepositAddress(h.deposits, {
    userId: OTHER,
    assetCode: 'EMBER',
    correlationId: 'req-1',
  })
  assert.equal(
    await isPlatformAddress(sql as never, 'ember', 'testnet', theirs.address.toLowerCase()),
    true,
  )
  assert.equal(
    await isPlatformAddress(sql as never, 'ember', 'testnet', '0x00000000000000000000000000000000000000ff'),
    false,
  )
  // A rotated address is still ours.
  await assignDepositAddress(h.deposits, {
    userId: OTHER,
    assetCode: 'EMBER',
    correlationId: 'req-2',
    rotate: true,
  })
  assert.equal(
    await isPlatformAddress(sql as never, 'ember', 'testnet', theirs.address.toLowerCase()),
    true,
  )
})

/* ------------------------------------------------------------------ pagination */

test('THE RULE: the wallet list is paged, and the pages do not overlap or skip', { skip }, async () => {
  // The current wallet returns the entire unpaginated ledger on every call: unbounded memory,
  // unbounded transfer, and slower for every user every day for ever.
  for (let i = 0; i < 7; i++) await create({ address: evmSigner().address })

  const seen: string[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await listWallets(sql as never, {
      userId: USER,
      limit: 3,
      ...(cursor ? { cursor } : {}),
    })
    pages += 1
    seen.push(...page.wallets.map((w) => w.id))
    cursor = page.nextCursor
    assert.ok(pages < 10, 'pagination did not terminate')
  } while (cursor !== null)

  assert.equal(seen.length, 7)
  assert.equal(new Set(seen).size, 7, 'a page boundary must not repeat a row')
  // Keyset on a UUIDv7 id, so the order is reverse chronological and total.
  assert.deepEqual([...seen].sort().reverse(), seen)
})

test('a retired wallet is hidden unless asked for', { skip }, async () => {
  const { wallet } = await create()
  await transitionWallet(sql as never, wallet.id, 'retiring', by('the owner ended our use of it'))
  await transitionWallet(sql as never, wallet.id, 'retired', by('retirement completed'))
  assert.equal((await listWallets(sql as never, { userId: USER, limit: 10 })).wallets.length, 0)
  assert.equal(
    (await listWallets(sql as never, { userId: USER, limit: 10, includeRetired: true })).wallets.length,
    1,
  )
})

/* ------------------------------------------------------------------ portfolio */

test('the portfolio composes ledger balances with a pricing timestamp on each', { skip }, async () => {
  h.ledger.credit(`user:${USER}`, 'EMBER', 2_000_000_000_000_000_000n)
  h.ledger.credit(`user:${USER}`, 'SHARD', 500n)

  const portfolio = await readPortfolio(h.portfolio, { userId: USER })
  const ember = portfolio.balances.find((b) => b.assetCode === 'EMBER')!
  assert.equal(ember.amountFormatted, '2')
  // 2 EMBER at $2.50 scaled = 5_000_000 scaled USD.
  assert.equal(ember.valuation?.usdScaled, '5000000')
  // A number with no timestamp cannot be shown honestly: "your portfolio is worth £X" with no
  // time attached is a claim about now that is actually a claim about the cache.
  assert.equal(ember.valuation?.quotedAt, '2026-01-01T00:00:00.000Z')

  // SHARD has no market price and is shown without a valuation rather than valued at zero.
  const shard = portfolio.balances.find((b) => b.assetCode === 'SHARD')!
  assert.equal(shard.valuation, null)
  assert.equal(shard.amountFormatted, '500')
})

test('an external wallet reports observed activity and NOT a balance', { skip }, async () => {
  // The indexer's HTTP surface exposes no balance read, so there is no balance to fetch. Summing
  // an activity page would give a number that changes with the page size and, on an account-model
  // chain, ignores every fee the address has ever paid.
  const signer = evmSigner()
  await createChallenge(sql as never, 'wallet', {
    userId: USER,
    chain: 'ember',
    network: 'testnet',
    address: signer.address,
    origin: 'watch',
    domain: 'd',
    uri: 'u',
    ttlSeconds: 600,
    correlationId: 'req-1',
  })
  h.indexer.setActivity(signer.address, [
    {
      id: 'a-1',
      address: signer.address.toLowerCase(),
      direction: 'in',
      assetCode: 'EMBER',
      assetKind: 'native',
      tokenAddress: null,
      amount: 3n,
      txHash: '0xaa',
      explorerUrl: null,
      logIndex: null,
      blockHeight: 1,
      status: 'included',
      confirmations: 100,
      confirmed: true,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'a-2',
      address: signer.address.toLowerCase(),
      direction: 'out',
      assetCode: 'EMBER',
      assetKind: 'native',
      tokenAddress: null,
      amount: 1n,
      txHash: '0xbb',
      explorerUrl: null,
      logIndex: null,
      blockHeight: 2,
      status: 'included',
      confirmations: 100,
      confirmed: true,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      // Orphaned: a history the chain has abandoned. It must not count.
      id: 'a-3',
      address: signer.address.toLowerCase(),
      direction: 'in',
      assetCode: 'EMBER',
      assetKind: 'native',
      tokenAddress: null,
      amount: 99n,
      txHash: '0xcc',
      explorerUrl: null,
      logIndex: null,
      blockHeight: 3,
      status: 'orphaned',
      confirmations: null,
      confirmed: false,
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      confirmedAt: null,
    },
  ])

  const portfolio = await readPortfolio(h.portfolio, { userId: USER })
  const observed = portfolio.wallets[0]!
  // A field named `balance` holding something that is not the balance would be rendered as one by
  // the first frontend that found it.
  assert.equal(observed.balance, null)
  assert.equal(observed.balanceUnavailable, 'indexer_exposes_no_balance_read')
  assert.equal(observed.netObserved, '2', 'three in, one out, the orphan ignored')
  assert.equal(observed.complete, true)
  assert.equal(observed.movements, 2)
})

test('a managed wallet is not double-counted on the chain side', { skip }, async () => {
  // Its contents are already in the ledger as a custody asset; showing them again would let a user
  // add the two and double-count their own money.
  await assignDepositAddress(h.deposits, {
    userId: USER,
    assetCode: 'EMBER',
    correlationId: 'req-1',
  })
  const portfolio = await readPortfolio(h.portfolio, { userId: USER })
  assert.equal(portfolio.wallets.length, 0)
})

test('an unreachable indexer degrades the portfolio rather than emptying it', { skip }, async () => {
  const signer = evmSigner()
  await createChallenge(sql as never, 'wallet', {
    userId: USER,
    chain: 'ember',
    network: 'testnet',
    address: signer.address,
    origin: 'watch',
    domain: 'd',
    uri: 'u',
    ttlSeconds: 600,
    correlationId: 'req-1',
  })
  h.ledger.credit(`user:${USER}`, 'SHARD', 10n)
  const broken = {
    ...h.portfolio,
    indexer: {
      ...h.indexer,
      activity: async () => {
        throw new Error('indexer down')
      },
    },
  }
  const portfolio = await readPortfolio(broken as never, { userId: USER })
  // The balances are the important half and they came from the ledger.
  assert.equal(portfolio.balances.length, 1)
  assert.equal(portfolio.wallets.length, 1)
  assert.equal(portfolio.wallets[0]?.complete, false)
  assert.deepEqual(portfolio.degraded, ['indexer'])
})

test('an unreachable ledger fails the portfolio rather than showing an empty one', { skip }, async () => {
  // An empty portfolio looks exactly like a user who owns nothing, which is the one wrong answer
  // this endpoint must never give.
  const broken = {
    ...h.portfolio,
    ledger: {
      ...h.ledger,
      balances: async () => {
        throw new Error('ledger down')
      },
    },
  }
  await assert.rejects(() => readPortfolio(broken as never, { userId: USER }), /ledger down/)
})
