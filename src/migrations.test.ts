import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'

test('versions are dense, ascending and start at one', () => {
  // A gap means a database that has applied 1..3 and 5 believes it is at 5 while missing 4, and
  // `assertSchemaAtLeast` would let it serve.
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, Array.from({ length: versions.length }, (_v, i) => i + 1))
  assert.equal(SCHEMA_VERSION, versions.length)
})

test('names are unique, so a log line names one migration', () => {
  const names = MIGRATIONS.map((m) => m.name)
  assert.equal(new Set(names).size, names.length)
})

test('the checksum of a released migration is stable', () => {
  // `@cloudsforge/db` refuses a run where the text changed after it was applied, because two
  // databases would then disagree about what "version 5" means. This asserts the checksum is a
  // function of the migration alone, so that refusal is meaningful.
  for (const migration of MIGRATIONS) {
    assert.equal(checksumOf(migration), checksumOf({ ...migration }))
    // Reformatting at the edges is deliberately tolerated; changing a statement is not.
    assert.equal(checksumOf(migration), checksumOf({ ...migration, up: `  ${migration.up}\n` }))
    assert.notEqual(
      checksumOf(migration),
      checksumOf({ ...migration, up: `${migration.up}\nalter table wallets add column x int;` }),
    )
  }
})

test('every table is created with IF NOT EXISTS, so a re-run is not a failure', () => {
  for (const migration of MIGRATIONS) {
    const creates = migration.up.match(/create table (if not exists )?/g) ?? []
    for (const create of creates) {
      assert.match(create, /if not exists/, `${migration.name} creates a table unconditionally`)
    }
  }
})

test('nothing drops or renames — expand and contract only', () => {
  // A rolling deploy always runs two versions of this service against one schema, so a migration
  // that renames or drops in one step takes the previous replica down with it.
  for (const migration of MIGRATIONS) {
    assert.equal(/\bdrop (table|column)\b/i.test(migration.up), false, `${migration.name} drops`)
    assert.equal(/\brename\b/i.test(migration.up), false, `${migration.name} renames`)
  }
})

test('the baseline is zero, because this service adopts no existing database', () => {
  // 10-migration-strategy moves forge-pay's data through the API, not through a schema handover:
  // the tables are a different shape and in a different account.
  assert.equal(BASELINE_VERSION, 0)
})

test('every declared table is actually created by a migration', () => {
  // `TABLES` is what the test harness truncates. A table missing from it survives a reset and
  // leaks rows between test files, which is the kind of failure that looks like a race.
  const ddl = MIGRATIONS.map((m) => m.up).join('\n')
  for (const table of TABLES) {
    if (table === 'jobs') continue
    assert.match(ddl, new RegExp(`create table if not exists ${table}\\b`), `${table} is not created`)
  }
})

test('THE RULE: no table has a balance column', () => {
  // 04-domain-model §11. Every amount stored is the amount of a specific movement — a credit that
  // happened, a withdrawal that was asked for — and never a running total. A total here would make
  // this service a second, unreconcilable source of truth for money.
  const ddl = MIGRATIONS.map((m) => m.up).join('\n')
  for (const forbidden of [/^\s*balance\s+/m, /^\s*shards\s+/m, /^\s*last_seen\s+/m]) {
    assert.equal(forbidden.test(ddl), false, `a running-total column matching ${forbidden} exists`)
  }
})

test('every chain-scoped table constrains its network', () => {
  // 04-domain-model §4.1: every record carries chain and network and no query may span networks.
  // On XRP the same address is valid on both, so this is a constraint rather than a convention.
  for (const migration of MIGRATIONS) {
    const chainTables = migration.up.match(/create table if not exists (\w+)[\s\S]*?\n    \)/g) ?? []
    for (const block of chainTables) {
      if (!/\n\s+chain\s+text/.test(block)) continue
      assert.match(block, /network\s+text\s+not null/, 'a chain-scoped table with no network')
      assert.match(block, /network in \('mainnet','testnet'\)/, 'a network with no check constraint')
    }
  }
})
