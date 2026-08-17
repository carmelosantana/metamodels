import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, sep } from 'node:path'

// packages/schema/test/ -> repo root is three levels up.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

// Env keys that are intentionally NOT in .env.example: test-only or framework-provided.
// .env.example documents how to *deploy* MetaModels; knobs that only a test harness reads
// would be noise there. The e2e walkthrough documents its own in apps/e2e/README.md.
const EXCLUDED = new Set([
  'REDIS_TEST_URL',
  'PG_TEST_URL',
  'NODE_ENV',
  'CI',
  'OLLAMA_TEST_URL',
  'OLLAMA_TEST_MODEL',
  'E2E_BASE_URL',
  'E2E_PROXY_URL',
  'E2E_SCREENSHOT_DIR',
])

// Dependency and build-output dirs are not "the code": skip them. This also
// matters because Node >=26's recursive readdirSync follows symlinks, so a
// pnpm-symlinked node_modules would otherwise pull in framework internals
// (e.g. Next.js type defs reference their own build-time env vars).
const SKIP_SEGMENTS = ['node_modules', '.next', 'dist']

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if (!/\.tsx?$/.test(entry.name)) continue
    // Dirent.parentPath is available on Node >=20.12 (we require >=24).
    const path = join(entry.parentPath, entry.name)
    if (SKIP_SEGMENTS.some((seg) => path.split(sep).includes(seg))) continue
    out.push(path)
  }
  return out
}

function envKeysUsedInSource(): Set<string> {
  const keys = new Set<string>()
  for (const root of ['apps', 'packages']) {
    for (const file of tsFilesUnder(join(ROOT, root))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (!EXCLUDED.has(m[1])) keys.add(m[1])
      }
    }
  }
  return keys
}

describe('.env.example completeness', () => {
  test('every process.env key the code reads is documented in .env.example', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
    const documented = new Set(
      example
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('=')[0]),
    )
    const used = envKeysUsedInSource()
    const missing = [...used].filter((k) => !documented.has(k)).sort()
    expect(missing, `.env.example is missing keys: ${missing.join(', ')}`).toEqual([])
  })
})
