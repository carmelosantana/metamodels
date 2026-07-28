import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

// These leaf modules are imported by client components (Next browser bundle). They must
// stay pure: no node:crypto (would break the bundle), no re-entry into the server-only
// barrel/keys/schema, and no @metamodels/connectors (a runtime value there pulls node:crypto,
// and it would also be a package cycle). We enforce this STRUCTURALLY as an allowlist —
// every import specifier must be one the leaf is allowed to reach. A denylist would pass
// incidentally the moment someone added `from './period.js'` (or any same-package module that
// later pulls node:crypto transitively); an allowlist rejects any new specifier outright.
const ALLOWED: Record<string, string[]> = {
  'config.ts': ['zod', './enums.js'],
  'graph.ts': ['zod'],
}

// Matches both `import ... from '<spec>'` and bare `import '<spec>'`, including `import type`,
// across multi-line import statements (the `from` keyword is what we anchor on for the
// `from` form; bare imports have the specifier directly after `import`).
const SPEC_RE = /(?:from|import)\s+['"]([^'"]+)['"]/g

function specifiers(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(SPEC_RE)) out.push(m[1])
  return out
}

describe.each(Object.keys(ALLOWED))('%s is client-safe', (file) => {
  test('imports only allowlisted specifiers', () => {
    const src = readFileSync(resolve(srcDir, file), 'utf8')
    const allowed = ALLOWED[file]
    for (const spec of specifiers(src)) {
      expect(
        allowed.includes(spec),
        `${file} imports '${spec}', which is not in its client-safe allowlist [${allowed.join(', ')}]`,
      ).toBe(true)
    }
  })
})
