/**
 * Every scope this service DEMANDS of somebody else is one the registry actually has.
 *
 * ── THE DIRECTION NOTHING HAS EVER CHECKED ───────────────────────────────────────────────────
 *
 * `micro-org`'s `service-ci.yml` proves that every scope a repository's route GATES demand is
 * registered in `@cloudsforge/contracts-auth`. That is the inbound direction. The constants this
 * file checks are the other one: what this service presents to a peer, declared so
 * `micro-deploy`'s `derive-grants.mjs` can build `IDENTITY_SERVICE_TOKEN_GRANTS` from the source
 * instead of a hand-maintained list. Nothing had ever compared those against the registry, and it
 * showed in two different ways at once:
 *
 *   * `CUSTODY_SCOPES` had said `custody:address` — a scope that has never existed — for the life
 *     of the service. The consequence is not a 403 on one route: identity validates its grants
 *     against the registry at import and refuses to start on an unknown name
 *     (`identity/src/env.ts`), so an unregistered demand here is a dead identity container and
 *     therefore no tokens for anybody.
 *   * `settlement.ts` had declared NOTHING while building a token-bearing client, so
 *     `settlement:read` could not be derived at all. A missing scope is the quiet one — the token
 *     mints, the service starts, and a single route 403s. Both are covered below, by the same
 *     sweep, because both are "the declaration and the registry disagree".
 *
 * ── WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────────────────────
 *
 * It asserts a RELATIONSHIP — "every scope named here is in the registry" — not a spelling. A
 * test pinning `CUSTODY_SCOPES` to `['custody:address:create']` would pass just as happily if a
 * new client were added tomorrow naming `custody:sign` or `wallet:evaluate`; this one goes red. So the
 * constants are discovered by sweeping `src/`, never listed by hand:
 *
 *   * discovery is over comment-stripped source, because six guards in this estate have fired on
 *     their own prose and one passed because the words it was looking for were in a comment;
 *   * the VALUE is then read from the imported module at run time, not parsed out of the text, so
 *     the thing under test is what the program actually holds — a scope-registry parser elsewhere
 *     tonight read exactly one entry out of a valid file and reported a clean estate;
 *   * a floor fails the sweep if it finds fewer constants than exist, because a sweep that
 *     silently matched nothing asserts nothing while looking green.
 *
 * The registry side is floored for the same reason. If `@cloudsforge/contracts-auth` ever
 * resolved to something empty, "every demand is in the registry" would be vacuously true of an
 * empty registry, which is the shape of a check that cannot fail.
 *
 * The compile-time half of this lives in the client headers: each constant is annotated
 * `readonly LiveScope[]`, so an unregistered name — or a registered-but-deprecated one — is a
 * type error before it is ever a test failure. This file exists because that annotation is not
 * load-bearing on its own: the sweep is name-based and annotation-agnostic, so a FUTURE constant
 * written as `readonly string[]` compiles happily and is still caught here. The two halves cover
 * different failures — the annotation catches a bad scope in an annotated constant, this catches
 * an unannotated constant — and neither subsumes the other.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LIVE_SCOPE_NAMES,
  SCOPE_NAMES,
  isDeprecatedScope,
  isScope,
  scopeSpec,
} from '@cloudsforge/contracts-auth'

/** This repository, spelled as the registry spells the enforcing service of a scope. */
const SERVICE = 'wallet'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/**
 * Floors. Both are "at least", never "exactly": adding a client is normal and must not fail this
 * file, while losing one silently is the failure being guarded against.
 */
const AT_LEAST_THIS_MANY_CONSTANTS = 5
const THE_REGISTRY_IS_AT_LEAST_THIS_BIG = 40

/**
 * Comments out, string literals kept.
 *
 * A constant named only inside a comment is not a declaration, and treating it as one would make
 * this file fail on its own documentation.
 */
function stripComments(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') {
          out += text.slice(i, i + 2)
          i += 2
          continue
        }
        out += text[i]
        i++
      }
      out += text[i] ?? ''
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/** The names of the `*_SCOPES` constants a module exports. Names only; values come from import. */
export function declaredConstantNames(source: string): readonly string[] {
  return [...stripComments(source).matchAll(/export const ([A-Z][A-Z0-9_]*_SCOPES)\b/g)].flatMap(
    (m) => (m[1] === undefined ? [] : [m[1]]),
  )
}

interface OutboundConstant {
  readonly file: string
  readonly name: string
  readonly scopes: readonly string[]
}

/** Every outbound scope constant in `src/`, with the value the module really exports. */
async function sweep(): Promise<readonly OutboundConstant[]> {
  const found: OutboundConstant[] = []
  const files = readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
  for (const file of files) {
    const names = declaredConstantNames(readFileSync(join(SRC, file), 'utf8'))
    if (names.length === 0) continue
    const module = (await import(`./${file}`)) as Record<string, unknown>
    for (const name of names) {
      const value = module[name]
      assert.ok(
        Array.isArray(value),
        `${file} declares ${name} but the module exports no array by that name — the sweep cannot read it, so it cannot be trusted to have checked it`,
      )
      found.push({ file, name, scopes: value as readonly string[] })
    }
  }
  return found
}

test('the registry this file checks against actually loaded', () => {
  // Without this, "every demand is registered" is vacuously true of an empty registry — a check
  // that passes precisely when it has lost the ability to fail.
  assert.ok(
    SCOPE_NAMES.length >= THE_REGISTRY_IS_AT_LEAST_THIS_BIG,
    `@cloudsforge/contracts-auth resolved to ${SCOPE_NAMES.length} scopes; the assertions below mean nothing against a registry that small`,
  )
  assert.ok(LIVE_SCOPE_NAMES.length > 0)
})

test('the sweep finds the outbound constants it is supposed to be checking', async () => {
  const found = await sweep()
  assert.ok(
    found.length >= AT_LEAST_THIS_MANY_CONSTANTS,
    `swept ${found.length} outbound scope constant(s), expected at least ${AT_LEAST_THIS_MANY_CONSTANTS} — a sweep that matches nothing asserts nothing`,
  )
  // Named so that deleting a client's declaration to make this file green fails instead. The
  // sweep is what catches a NEW constant; this is what catches a removed one.
  const names = new Set(found.map((c) => c.name))
  for (const expected of [
    'CUSTODY_SCOPES',
    'INDEXER_SCOPES',
    'LEDGER_SCOPES',
    'PRICING_SCOPES',
    // The one that was absent rather than misspelled. Pinned by name because a deletion here does
    // not look like a defect — it looks like tidying an unused constant, and the 403 arrives later.
    'SETTLEMENT_SCOPES',
  ]) {
    assert.ok(names.has(expected), `${expected} is gone — the deploy can no longer derive it`)
  }
  for (const constant of found) {
    assert.ok(
      constant.scopes.length > 0,
      `${constant.file}: ${constant.name} is empty; derive-grants reads that as an undeclared gap`,
    )
  }
})

test('THE RULE: every scope this service demands is one the registry has', async () => {
  const unregistered: string[] = []
  for (const { file, name, scopes } of await sweep()) {
    for (const scope of scopes) {
      if (!isScope(scope)) unregistered.push(`${file}: ${name} names '${scope}'`)
    }
  }
  assert.deepEqual(
    unregistered,
    [],
    `identity validates IDENTITY_SERVICE_TOKEN_GRANTS against @cloudsforge/contracts-auth at import and refuses to boot on an unknown name, so each of these is a dead identity container rather than one failed call:\n  ${unregistered.join('\n  ')}`,
  )
})

test('…and one identity would actually mint: no demand is a deprecated scope', async () => {
  const dead: string[] = []
  for (const { file, name, scopes } of await sweep()) {
    for (const scope of scopes) {
      if (!isScope(scope)) continue
      if (isDeprecatedScope(scope)) {
        dead.push(`${file}: ${name} names '${scope}' — ${scopeSpec(scope).deprecated ?? ''}`)
      }
    }
  }
  // `Scope` cannot express this: it is `keyof typeof SCOPES` and every deprecated key is still a
  // key, deliberately, because removing one narrows the type and breaks twenty-two consumers
  // (AD-02). `LiveScope` can, and the outbound constants in this repository now carry it — so for
  // an ANNOTATED constant this test is a second opinion rather than the only one. It stays because
  // it also judges constants that are not annotated, which is the case the annotation cannot see.
  assert.deepEqual(dead, [], `a deprecated scope is one identity will not grant:\n  ${dead.join('\n  ')}`)
})

test('no outbound demand is a scope this service itself enforces', async () => {
  const selfGrants: string[] = []
  for (const { file, name, scopes } of await sweep()) {
    for (const scope of scopes) {
      if (!isScope(scope)) continue
      if (scopeSpec(scope).service === SERVICE) selfGrants.push(`${file}: ${name} names '${scope}'`)
    }
  }
  // A service does not present a credential to itself. This is what stops an INBOUND vocabulary
  // constant from being read as an outbound demand — the mistake that would grant a service
  // authority over its own routes and hide the upstream grant it actually needs.
  assert.deepEqual(selfGrants, [], selfGrants.join('\n  '))
})

test('the sweep can fail: it reads declarations, not prose, and values, not text', () => {
  // A positive control on the discovery half. Without it, a stripComments bug that swallowed
  // every declaration would leave the assertions above iterating an empty list and passing.
  assert.deepEqual(
    declaredConstantNames("export const WIDGET_SCOPES: readonly Scope[] = Object.freeze(['a:b'])"),
    ['WIDGET_SCOPES'],
  )
  assert.deepEqual(declaredConstantNames('/* export const GHOST_SCOPES = [] */'), [])
  assert.deepEqual(declaredConstantNames('// export const GHOST_SCOPES = []'), [])
  // And on the judgement half: the registry really does refuse a name that is not in it.
  assert.equal(isScope('custody:address:create'), true)
  assert.equal(isScope('custody:address'), false)
})
