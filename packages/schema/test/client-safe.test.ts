import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

// These leaf modules are imported by client components (Next browser bundle). They must
// stay pure: no node:crypto (would break the bundle), no re-entry into the server-only
// barrel/keys/schema, and no @metamodels/connectors (a runtime value there pulls node:crypto,
// and it would also be a package cycle). This makes the boundary structural, not comment-only.
const FORBIDDEN = [
  /from ['"]node:crypto['"]/,
  /from ['"]\.\/keys(\.js)?['"]/,
  /from ['"]\.\/index(\.js)?['"]/,
  /from ['"]\.\/schema(\.js)?['"]/,
  /from ['"]@metamodels\/connectors['"]/,
]

describe.each(['config.ts', 'graph.ts'])('%s is client-safe', (file) => {
  test('imports no forbidden module', () => {
    const src = readFileSync(resolve(srcDir, file), 'utf8')
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(src), `${file} must not match ${pattern}`).toBe(false)
    }
  })
})
