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

test('a chain widening reaches EVERY table that constrains a chain, or it reaches none of them', () => {
  /*
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * The failure this catches is a HALF-APPLIED widening, and it is silent until money moves.
   *
   * Five tables carry a `chain` check constraint, and they are not exercised evenly: a new chain
   * touches `deposit_address_assignments` on the first deposit and `withdrawals` only when someone
   * withdraws, which may be weeks later. So a migration that widens four of the five leaves a
   * constraint that fires on a legitimate insert, long after the change looked complete, with a
   * 23514 naming a constraint rather than a chain — and by then custody has already minted and
   * published a key.
   *
   * Asserted as SET EQUALITY against the tables that declare such a constraint, rather than
   * against a list written here, so a sixth chain-scoped table added later is covered without this
   * test being edited. `create table` blocks and `alter table … add constraint` statements are both
   * read, because a table may acquire its constraint either way.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  const constrained = new Set<string>()
  for (const migration of MIGRATIONS) {
    for (const [, table] of migration.up.matchAll(/constraint (\w+)_chain_ck check \(chain in/g)) {
      constrained.add(table!)
    }
  }
  assert.ok(constrained.size >= 5, `only ${constrained.size} tables constrain their chain`)

  for (const migration of MIGRATIONS) {
    const widened = new Set(
      [...migration.up.matchAll(/add constraint (\w+)_chain_ck check \(chain in/g)].map(([, t]) => t!),
    )
    // A migration that widens nothing is not this migration's business; one that widens anything
    // must widen everything, because the constraints are one rule split across five tables.
    if (widened.size === 0) continue
    assert.deepEqual(
      [...widened].sort(),
      [...constrained].sort(),
      `migration ${migration.version} (${migration.name}) widens some chain constraints and not others`,
    )
  }
})

test('each chain constraint literal is used by exactly one migration, so none can be edited in place', () => {
  /*
   * The rule the header of `migrations.ts` states, asserted rather than left to a comment.
   *
   * `CHAIN_CK_V10`'s text is inside migration 10's checksum. Widening that constant to add a chain
   * — the obvious edit, and the one this test exists to make impossible to land quietly — would
   * change migration 10's text, and `@cloudsforge/db` would then refuse to run the migrator at all
   * against every database that has already applied it, which is all of them. The visible symptom
   * is not "the new chain does not work", it is "the service will not start".
   *
   * Two migrations sharing one WIDENING literal is the signature of that edit, because the shared
   * list is what the second migration would have widened. Distinct lists are the evidence that each
   * release added a constant instead.
   *
   * Only `alter table … add constraint` is read. The original list is legitimately shared by the
   * four migrations that CREATE these tables — those are one set of chains written once, not a
   * widening applied twice — and demanding four distinct literals there would be demanding four
   * copies of the same list.
   */
  const widenings = new Map<string, number[]>()
  const created = new Set<string>()
  for (const migration of MIGRATIONS) {
    for (const [, list] of migration.up.matchAll(
      /add constraint \w+_chain_ck check \(chain in \(([^)]*)\)\)/g,
    )) {
      const versions = widenings.get(list!) ?? []
      if (!versions.includes(migration.version)) versions.push(migration.version)
      widenings.set(list!, versions)
    }
    for (const [, list] of migration.up.matchAll(
      /\n\s+constraint \w+_chain_ck check \(chain in \(([^)]*)\)\)/g,
    )) {
      created.add(list!)
    }
  }
  assert.ok(widenings.size >= 2, 'fewer than two chains have ever been added; this proves nothing yet')
  for (const [list, versions] of widenings) {
    assert.equal(
      versions.length,
      1,
      `the chain list ${list} is added by migrations ${versions.join(' and ')} — a released ` +
        'migration was edited in place instead of a new constant being added',
    )
    // And a widening must never reuse the list the tables were created with, which is the same
    // edit seen from the other end: it would mean the create-table constant had been changed and
    // the alter left pointing at it.
    assert.equal(
      created.has(list),
      false,
      `the chain list ${list} is both a create-table constraint and a widening`,
    )
  }
})
