/**
 * Mutation testing for the retired-asset fix.
 *
 * The defect being fixed was invisible to a green suite: `spend` was hard-coded to SHARD, the fake
 * ledger did not model migration 13's guard, and every test passed while the live route 400'd. So
 * the first thing each mutation below has to establish is that the NEW tests can actually fail —
 * a suite that could not see the original defect is not evidence about its fix.
 *
 * Run: WALLET_TEST_DATABASE_URL=... node mutations.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MUTATIONS = [
  {
    name: 'spend goes back to being hard-coded to the retired asset',
    file: 'src/money.ts',
    from: `  const assetCode: IssuableAssetCode = input.assetCode ?? 'EMBER'`,
    to: `  const assetCode = (input.assetCode ?? 'SHARD') as IssuableAssetCode`,
    expect: 'a spend defaults to EMBER and no longer trips the retired-asset guard',
  },
  {
    name: 'the fake ledger stops modelling the retired-asset guard',
    file: 'src/testsupport.ts',
    from: `        if (ACQUISITION_KINDS.has(request.kind)) {`,
    to: `        if (false) {`,
    expect: 'the ledger would still refuse a purchase denominated in a retired asset',
  },
  {
    name: 'the guard is widened to every kind, stranding the holders',
    file: 'src/testsupport.ts',
    from: `        const ACQUISITION_KINDS = new Set(['purchase', 'subscription_charge', 'deposit_credited'])`,
    to: `        const ACQUISITION_KINDS = new Set(['purchase', 'subscription_charge', 'deposit_credited', 'conversion', 'transfer', 'withdrawal_requested'])`,
    expect: 'a SHARD holder can still convert out, because the guard permits conversion',
  },
  {
    name: 'the route stops narrowing a caller-supplied asset',
    file: 'src/server.ts',
    from: `  try {
    return { assetCode: assertIssuable(upper as AssetCode) }`,
    to: `  try {
    return { assetCode: upper as IssuableAssetCode }`,
    expect: 'a spend naming a retired asset is refused at the boundary, with a usable message',
  },
  {
    name: 'the route accepts an asset the estate does not know',
    file: 'src/server.ts',
    from: `  if (!Object.hasOwn(CHAINS, upper)) {`,
    to: `  if (false) {`,
    expect: 'a spend naming an asset the estate does not know is refused',
  },
  {
    name: 'the route ignores the asset the caller named',
    file: 'src/server.ts',
    from: `          ...issuableAsset(optionalString(body, 'assetCode')),`,
    to: ``,
    expect: 'a spend may name a live asset explicitly',
  },
  {
    name: 'the asset drops out of the idempotency fingerprint',
    file: 'src/money.ts',
    from: `    requestHash: requestFingerprint({ amount: input.amount, reason: input.reason, assetCode }),`,
    to: `    requestHash: requestFingerprint({ amount: input.amount, reason: input.reason }),`,
    expect: 'two spends of one amount in two assets are two requests, not a replay',
  },
  {
    name: 'the counter-posting is denominated separately from the debit',
    file: 'src/money.ts',
    from: `      account: { subject: 'platform', assetCode, purpose: 'fees', type: 'revenue' },`,
    to: `      account: { subject: 'platform', assetCode: 'SHARD' as never, purpose: 'fees', type: 'revenue' },`,
    expect: 'a spend debits the user and credits platform revenue',
  },
]

const originals = new Map()
process.on('exit', () => {
  for (const [file, text] of originals) writeFileSync(file, text)
})

function runSuite() {
  try {
    execFileSync(
      'node',
      ['--import', 'tsx', '--test', '--test-concurrency=1', 'src/money.test.ts', 'src/server.test.ts'],
      { encoding: 'utf8', stdio: 'pipe' },
    )
    return { failures: [] }
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    /*
     * `^\s*` AND NOT `^\s+`. A top-level `node:test` case is printed with NO indentation, while one
     * nested in a `describe` is indented. The first version of this required at least one space,
     * matched nothing, and reported all eight mutations as survivors — which reads as "these tests
     * are worthless" when the truth was "this harness is". It is worth the comment because the
     * failure mode of a mutation harness is silent and points at the wrong thing.
     */
    const names = [...out.matchAll(/^\s*✖ (.+?) \(/gm)].map((m) => m[1])
    return { failures: [...new Set(names)] }
  }
}

console.log('baseline …')
const baseline = runSuite()
if (baseline.failures.length > 0) {
  console.error('the suite is not green before mutating:', baseline.failures)
  process.exit(1)
}
console.log('baseline is green\n')

let killed = 0
const survivors = []
for (const mutation of MUTATIONS) {
  if (!originals.has(mutation.file)) originals.set(mutation.file, readFileSync(mutation.file, 'utf8'))
  const original = originals.get(mutation.file)
  if (!original.includes(mutation.from)) {
    console.log(`?  ${mutation.name}\n   — text not found; the mutation is stale`)
    continue
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to))
  const { failures } = runSuite()
  writeFileSync(mutation.file, original)

  if (failures.includes(mutation.expect)) {
    killed += 1
    console.log(`✓  ${mutation.name}\n   → killed by: "${mutation.expect}"`)
  } else if (failures.length > 0) {
    killed += 1
    console.log(`~  ${mutation.name}\n   → expected "${mutation.expect}"\n   → killed instead by: ${failures.join(', ')}`)
  } else {
    survivors.push(mutation.name)
    console.log(`✖  SURVIVOR: ${mutation.name}`)
  }
}

console.log(`\n${killed}/${MUTATIONS.length} mutations killed`)
if (survivors.length > 0) {
  for (const s of survivors) console.log(`  survivor: ${s}`)
  process.exit(1)
}
