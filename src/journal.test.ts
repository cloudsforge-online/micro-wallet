/**
 * **Nothing in this service writes to the journal except a real movement of a user's money.**
 *
 * ── THE INCIDENT THIS EXISTS FOR ─────────────────────────────────────────────────────────────
 *
 * On 2026-08-04 at 04:50:02.650868+00 the estate's ledger accepted a `deposit_credited` entry for
 * 5000000000000000000 wei of EMBER — a debit to `custody` and a credit to a user's liability —
 * with no on-chain deposit behind it. The next reconciliation, at 04:51:58, recorded
 * `drift_exceeded` (ledger 36000000000000000000 against chain 31000000000000000000, a gap equal
 * to the entry to the wei), froze EMBER, and withdrawals stopped. The mechanism worked exactly as
 * designed; the entry should never have existed.
 *
 * The row read `originating_service = 'wallet'`, `actor = 'service:wallet'`, `description =
 * 'probe ember'`, and the investigation therefore began here, looking for a health or smoke probe
 * in this service that credited a deposit and did not reverse it. **There was none, and there is
 * none.** The entry was posted out of band, straight at `POST /entries`, by something holding a
 * service token minted for `wallet`; the ledger never compared the body's `originatingService`
 * with the token's subject, so the journal's attribution was a string the caller chose. That half
 * is fixed in `micro-ledger` (`server.ts`, `attribute`), which is where it belongs — this service
 * cannot police what other holders of its name do.
 *
 * What this service CAN guarantee is its own half, and this file is that guarantee: no code path
 * in `micro-wallet` posts to the journal for any reason other than moving a user's money.
 *
 * ── WHY "MUST NOT POST AT ALL", AND NOT "MUST REVERSE ITSELF" ────────────────────────────────
 *
 * A probe that posts and reverses in the same transaction leaves the books correct, and it is
 * still the wrong answer. Three reasons, in the order they bite:
 *
 *   1. **In the books it is indistinguishable from a real deposit.** `journal_entries` has no
 *      "this was not real" column and must not grow one, because that column would immediately
 *      become the thing a defect hides behind. A reversed probe is two rows that a `deposit_credited`
 *      report, a revenue query and `ledger_postings_total{service,kind}` all count.
 *   2. **"In the same transaction" is not available across an HTTP boundary.** This service posts
 *      to the ledger over the network. A probe that posts and then reverses is two requests, and
 *      the window between them is exactly the window in which a crash leaves a permanent unbacked
 *      liability — which is the state the estate spent tonight in.
 *   3. **There is nothing to prove.** The ledger's own suite proves the ledger posts. A probe here
 *      would be this service testing somebody else's service in production, using real money as
 *      the test fixture.
 *
 * The rule is therefore absolute and this file enforces it as a relationship rather than a
 * spelling: every journal-writing call site in `src/` must be one of the five money paths declared
 * below. A sixth — a probe, a warm-up, a smoke check, a "just to be sure the ledger is up" — goes
 * red the moment it is written, before it ever reaches an estate.
 *
 * ── HOW IT SWEEPS, AND THE TWO WAYS A SWEEP LIES ─────────────────────────────────────────────
 *
 * Both failure modes are ones this repository has already been bitten by, and `scopes.test.ts`
 * names them:
 *
 *   * **Prose.** Six guards in this estate have fired on their own comments, and one passed
 *     because the words it hunted for were in a comment. The source is comment-stripped before
 *     anything is matched — including this header, which says `postEntry` several times.
 *   * **Matching nothing.** A sweep that finds zero call sites asserts nothing while looking
 *     green. There is a floor on the files read and a floor on the call sites found, and the
 *     declared set is compared both ways: an undeclared call site fails, and a declared path that
 *     has VANISHED fails too, because a stale allowlist is an allowlist that has stopped reading
 *     the code.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))

/**
 * The methods that write to the journal. `LedgerClient` has exactly four members and `balances` is
 * the one that does not move money, so this is "the client, minus the read".
 *
 * Named by method rather than by "any call on `deps.ledger`" because the receiver is spelled
 * differently at different call sites, and a sweep keyed on the receiver would miss a rename.
 */
const WRITES = ['postEntry', 'reserve', 'release'] as const

/**
 * The five money paths, and what makes each one a movement of a user's money rather than a probe.
 *
 * The reason is data, not a comment, so that the failure message below can quote it: somebody
 * adding a sixth entry has to write the sentence that justifies it, and "a probe" is not a
 * sentence that survives being written down next to these.
 */
const MONEY_PATHS: ReadonlyArray<{ file: string; fn: string; why: string }> = [
  {
    file: 'deposits.ts',
    fn: 'postCredit',
    why: 'a confirmed on-chain deposit, keyed on the credit key so the chain movement and the entry cannot disagree',
  },
  {
    file: 'money.ts',
    fn: 'run',
    why: 'the shared path behind /v1/spend, /v1/transfers, /v1/conversions and the exchange desk’s funding route — each an act carrying an idempotency key',
  },
  {
    file: 'withdrawals.ts',
    fn: 'reserveAndQueue',
    why: 'a user asked to withdraw; the reservation is what stops the same balance being spent twice',
  },
  {
    file: 'withdrawals.ts',
    fn: 'settleWithdrawal',
    why: 'the withdrawal left the platform on chain, so the reserved liability is discharged',
  },
  {
    file: 'withdrawals.ts',
    fn: 'refundWithdrawal',
    why: 'the withdrawal failed, so the reservation is released and the user gets their money back',
  },
]

/** Strip comments so no assertion below can be satisfied — or defeated — by prose. */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    if (quote) {
      if (ch === '\\') {
        out += ch + (next ?? '')
        i += 2
        continue
      }
      if (ch === quote) quote = null
      out += ch
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * The files that may contain a journal write.
 *
 * `ledgerclient.ts` is excluded because it IS the client: every method there is a definition, not
 * a call site, and including it would put five permanent false positives in the sweep. Test files
 * and `testsupport.ts` are excluded because a stub ledger in a test moves no money.
 */
function sourceFiles(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts'))
    .filter((name) => name !== 'ledgerclient.ts' && name !== 'testsupport.ts')
    .sort()
}

/** Every journal write in `src/`, as `file:function`, discovered rather than listed. */
function callSites(): { sites: { file: string; fn: string; line: number }[]; filesRead: number } {
  const call = new RegExp(`\\.(${WRITES.join('|')})\\s*\\(`)
  const declaration = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/
  const sites: { file: string; fn: string; line: number }[] = []
  const files = sourceFiles()

  for (const file of files) {
    const lines = stripComments(readFileSync(join(SRC, file), 'utf8')).split('\n')
    for (const [index, line] of lines.entries()) {
      if (!call.test(line)) continue
      // The nearest `function` declaration above the call. A call at top level — module
      // initialisation posting money — resolves to `(module scope)` and can never match a declared
      // path, which is the correct verdict for it.
      let fn = '(module scope)'
      for (let back = index; back >= 0; back -= 1) {
        const match = declaration.exec(lines[back]!)
        if (match) {
          fn = match[1]!
          break
        }
      }
      sites.push({ file, fn, line: index + 1 })
    }
  }
  return { sites, filesRead: files.length }
}

test('the sweep actually reads this service, so nothing below can pass vacuously', () => {
  const { sites, filesRead } = callSites()
  // Floors, not equalities: the point is that a sweep matching nothing cannot report green. The
  // exact figures today are 22 source files and 5 call sites, and both may legitimately grow.
  assert.ok(filesRead >= 15, `the sweep read ${filesRead} source files; it has stopped finding src/`)
  assert.ok(
    sites.length >= MONEY_PATHS.length,
    `the sweep found ${sites.length} journal writes but ${MONEY_PATHS.length} money paths are declared — ` +
      'the matcher has stopped matching, so every assertion below is vacuous',
  )
})

test('NO PATH IN THIS SERVICE POSTS TO THE JOURNAL EXCEPT A REAL MOVEMENT OF MONEY', () => {
  const declared = new Set(MONEY_PATHS.map((path) => `${path.file}:${path.fn}`))
  const undeclared = callSites()
    .sites.filter((site) => !declared.has(`${site.file}:${site.fn}`))
    .map((site) => `${site.file}:${site.line} (in ${site.fn})`)

  assert.deepEqual(
    undeclared,
    [],
    'A journal write was added on a path this service has not declared as a movement of money.\n\n' +
      'If it is a probe, a warm-up, a smoke check or a readiness check: DELETE IT. A probe that\n' +
      'writes to the journal is indistinguishable in the books from a real deposit, and on\n' +
      '2026-08-04 one exactly like it minted 5000000000000000000 wei of EMBER against nothing and\n' +
      "froze the asset. Reversing it afterwards is not good enough either: the reversal is a\n" +
      'SECOND network call, and the gap between the two is where the unbacked liability lives.\n\n' +
      'If it really is money moving, add it to MONEY_PATHS with the sentence that says whose\n' +
      'money, moving why. The declared paths are:\n' +
      MONEY_PATHS.map((path) => `  - ${path.file}:${path.fn} — ${path.why}`).join('\n') +
      '\n\nUndeclared: ',
  )
})

test('every declared money path still exists — a stale allowlist has stopped reading the code', () => {
  const found = new Set(callSites().sites.map((site) => `${site.file}:${site.fn}`))
  const vanished = MONEY_PATHS.map((path) => `${path.file}:${path.fn}`).filter(
    (path) => !found.has(path),
  )
  assert.deepEqual(
    vanished,
    [],
    'These paths are declared as journal writes and no longer make one. Either they were renamed — ' +
      'in which case the allowlist must follow, or it is silently permitting a name nothing uses — ' +
      'or the money path itself has gone, which is a much bigger question. Vanished: ',
  )
})

test('the health surface is not on any money path', () => {
  // The specific shape the incident was blamed on: a readiness or liveness probe that credits a
  // deposit to prove the ledger is reachable. `index.ts` builds the probes and `server.ts` serves
  // /livez and /readyz, so a journal write in either of those files is that defect by construction
  // — and it would be caught by the test above too, since neither file declares a money path. This
  // asserts it separately because it is the one that must never become a judgement call.
  const health = callSites().sites.filter(
    (site) => site.file === 'index.ts' || site.file === 'server.ts' || site.file === 'jobs.ts',
  )
  assert.deepEqual(
    health.map((site) => `${site.file}:${site.line}`),
    [],
    'A journal write appeared in the wiring, the HTTP surface or the job registrations. Money moves ' +
      'in deposits.ts, money.ts and withdrawals.ts; those three files are where a reader looks for it, ' +
      'and a posting anywhere else is either a probe or a movement nobody will find again. Found: ',
  )
})
