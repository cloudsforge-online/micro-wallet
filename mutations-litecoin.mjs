/**
 * Mutation testing for the Litecoin address gate.
 *
 * The defect this change closes is invisible to a green suite by construction: a Litecoin address
 * validated with Bitcoin's parameters is well-formed, passes its checksum, and throws nothing. So
 * "the tests pass" is not evidence about it, and each mutation below restores one specific piece of
 * the wrong behaviour and requires a named test to notice.
 *
 * Two of them are worth reading even if the rest are routine:
 *
 *   * `the HRP check becomes a prefix comparison` — this is the mutation almost every naive
 *     implementation IS, and it must be killed by the BIP-173 relabelling vector rather than by a
 *     Litecoin vector, because a Litecoin vector passes under it.
 *   * `bitcoinFamilyParams falls back to Bitcoin` — the missing-default. It cannot be killed by any
 *     Litecoin or Bitcoin address, only by the chain that has no entry, which is why that test
 *     calls the function directly.
 *
 * Run: WALLET_TEST_DATABASE_URL=... node mutations-litecoin.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SUITE = ['src/addresses.test.ts', 'src/custodycontract.test.ts', 'src/withdrawals.test.ts']

const MUTATIONS = [
  {
    name: 'LTC drops back out of the asset→chain map, restoring the 422',
    file: 'src/addresses.ts',
    from: `  XRP: 'xrp',\n  LTC: 'ltc',\n})`,
    to: `  XRP: 'xrp',\n})`,
    expect: 'SHARD settles on no chain, and asking for its chain returns null rather than a default',
  },
  {
    name: 'LTC maps to the Bitcoin chain slug',
    file: 'src/addresses.ts',
    from: `  XRP: 'xrp',\n  LTC: 'ltc',\n})`,
    to: `  XRP: 'xrp',\n  LTC: 'btc',\n})`,
    expect: 'SHARD settles on no chain, and asking for its chain returns null rather than a default',
  },
  {
    name: "Litecoin's bech32 HRPs become Bitcoin's — the bc1 address published as a Litecoin one",
    file: 'src/addresses.ts',
    from: `    hrps: Object.freeze(['ltc', 'tltc', 'rltc']),`,
    to: `    hrps: Object.freeze(['bc', 'tb', 'bcrt']),`,
    expect: "LITECOIN: Core's own published address vectors are accepted, on both networks",
  },
  {
    name: "Litecoin's base58 version bytes become Bitcoin's",
    file: 'src/addresses.ts',
    from: `    versions: Object.freeze([0x30, 0x32, 0x6f, 0x3a]),`,
    to: `    versions: Object.freeze([0x00, 0x05, 0x6f, 0xc4]),`,
    expect: "LITECOIN: Core's own published address vectors are accepted, on both networks",
  },
  {
    name: 'the version-byte check is dropped, so any 21-byte payload passes on any chain',
    file: 'src/addresses.ts',
    from: `  if (!params.versions.includes(version)) {`,
    to: `  if (false) {`,
    expect: 'LITECOIN: a Bitcoin address is REFUSED on the Litecoin path — the defect that loses coins',
  },
  {
    name: "Litecoin also accepts SCRIPT_ADDRESS 5, the prefix it shares with Bitcoin",
    file: 'src/addresses.ts',
    from: `    versions: Object.freeze([0x30, 0x32, 0x6f, 0x3a]),`,
    to: `    versions: Object.freeze([0x30, 0x32, 0x05, 0x6f, 0x3a, 0xc4]),`,
    expect: 'LITECOIN: mainnet P2SH `3…` is refused, though Core would DECODE it',
  },
  {
    name: 'an unknown bitcoin-family chain falls back to Bitcoin instead of throwing',
    file: 'src/addresses.ts',
    from: `  const params = BITCOIN_FAMILY_PARAMS[chain]\n  if (!params) {`,
    to: `  const params = BITCOIN_FAMILY_PARAMS[chain] ?? BITCOIN_FAMILY_PARAMS['btc']\n  if (!params) {`,
    expect: 'LITECOIN: an unknown bitcoin-family chain throws rather than falling back to Bitcoin',
  },
  /*
   * ── THE MUTATION THAT WAS HERE FIRST WAS EQUIVALENT, AND IS RECORDED RATHER THAN DELETED ─────
   *
   * It rewrote `params.hrps.includes(hrp)` as `raw.startsWith(`${h}1`)`, on the theory that a
   * prefix comparison is the naive form of this check. It survived, and it survived because it
   * changes nothing: `'1'` is not in the bech32 data alphabet, so `lastIndexOf('1')` IS the
   * separator for every well-formed address and the two expressions agree on all of them. A
   * surviving equivalent mutant is a bad mutation rather than a missing test, and the fix is a
   * mutation that is a real defect — which is what the two below are. The note stays because
   * "survivor, therefore write another test" would have been the wrong conclusion here.
   */
  {
    name: 'THE BIG ONE: the checksum stops committing to the HRP and is computed against a constant',
    file: 'src/addresses.ts',
    from: `  const checksum = bech32Polymod([...bech32Expand(prefix), ...data])`,
    to: `  const checksum = bech32Polymod([...bech32Expand('bc'), ...data])`,
    expect: 'LITECOIN: the HRP is inside the checksum, so this is not a prefix comparison',
  },
  {
    name: 'the bech32 checksum is not verified at all, so the HRP is the only gate',
    file: 'src/addresses.ts',
    from: `    verifyBech32(raw)\n    assertPayableWitnessVersion(raw)`,
    to: `    assertPayableWitnessVersion(raw)`,
    expect: 'LITECOIN: the HRP is inside the checksum, so this is not a prefix comparison',
  },
  {
    name: 'the witness-version gate is removed, so a Taproot address is accepted and never payable',
    file: 'src/addresses.ts',
    from: `    assertPayableWitnessVersion(raw)\n`,
    to: ``,
    expect: 'BITCOIN FAMILY: a Taproot destination is refused, because the estate cannot pay one',
  },
  /* ── the custody chain-name defect, which was live for ETH, BTC and SOL before Litecoin ──── */
  {
    name: "custody is sent this service's slug again, so the funding path 400s for four chains",
    file: 'src/custodyclient.ts',
    from: `            chain: custodyChainOf(request.chain),`,
    to: `            chain: request.chain,`,
    expect: 'THE CHAIN ON THE WIRE IS CUSTODY NAME, NOT THIS SERVICE SLUG',
  },
  {
    name: 'the translation table maps litecoin back onto the slug',
    file: 'src/addresses.ts',
    from: `  ltc: 'litecoin',\n})`,
    to: `  ltc: 'ltc',\n})`,
    expect: 'THE CHAIN ON THE WIRE IS CUSTODY NAME, NOT THIS SERVICE SLUG',
  },
  {
    name: 'the reply check compares against the slug, turning custody 400 into a contract error',
    file: 'src/custodyclient.ts',
    from: `  const expectedChain = custodyChainOf(request.chain)`,
    to: `  const expectedChain = request.chain as string`,
    expect: 'THE CHAIN ON THE WIRE IS CUSTODY NAME, NOT THIS SERVICE SLUG',
  },
  {
    name: 'a Litecoin deposit address can no longer be assigned at all',
    file: 'src/addresses.ts',
    from: `  LTC: 'ltc',\n})`,
    to: `})`,
    expect: 'LITECOIN: a deposit address can be assigned, which is the other half of the gap',
  },
  {
    name: 'the wrong-chain refusal loses its name and becomes a generic checksum error',
    file: 'src/addresses.ts',
    from: `  const foreign = HRP_OWNER.get(hrp)\n  if (foreign) {`,
    to: `  const foreign = undefined\n  if (foreign) {`,
    expect: 'LITECOIN: the refusal names the chain, because "invalid address" would send a user hunting a typo',
  },
]

const originals = new Map()
process.on('exit', () => {
  for (const [file, text] of originals) writeFileSync(file, text)
})

function runSuite() {
  try {
    execFileSync('node', ['--import', 'tsx', '--test', '--test-concurrency=1', ...SUITE], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { failures: [] }
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    // `^\s*` and not `^\s+`: a top-level node:test case is printed with NO indentation.
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
    survivors.push(`${mutation.name} (stale)`)
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
