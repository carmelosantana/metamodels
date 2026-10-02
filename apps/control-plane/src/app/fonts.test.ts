import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// The console's font preloads, read from the build's own manifest (Kanboard #4721). CI builds the console
// before this lane runs; a local run without a build skips rather than judging a stale or missing `.next`.
const app = join(import.meta.dirname, '..', '..')
const manifestPath = join(app, '.next', 'server', 'next-font-manifest.json')

describe.skipIf(!existsSync(manifestPath))('console font preloads (Kanboard #4721)', () => {
  test('only the body face is preloaded; the vendored Mono TTFs load on use', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { app: Record<string, string[]> }
    const preloaded = Object.values(manifest.app).flat()
    const sans = readFileSync(join(import.meta.dirname, 'fonts', 'IBMPlexSans[wdth,wght].ttf'))
    expect(preloaded).toHaveLength(1)
    expect(readFileSync(join(app, '.next', preloaded[0]!)).equals(sans)).toBe(true)
  })
})
