import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { adminApiResource } from '@metamodels/schema'
import { credentialsPath, readCredentials, writeCredentials } from '../src/credentials.js'
import { serveDiscovery, startStub, type Stub } from './helpers/stub.js'

/**
 * The CLI as operators run it: a real `node` process started with this package's `start` script,
 * with no test transform in between — so these tests also prove the TypeScript sources (this app's
 * and `@metamodels/schema`'s) load under Node's own type stripping.
 */

const T = 30_000
const APP = fileURLToPath(new URL('..', import.meta.url))
const START = (JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { scripts: { start: string } }).scripts.start

let stubs: Stub[] = []
afterEach(async () => {
  await Promise.all(stubs.map((s) => s.close()))
  stubs = []
})

function mm(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [cmd, ...base] = START.split(' ')
  expect(cmd).toBe('node')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...base, ...args], {
      cwd: APP,
      // Only what the test gives it: never the operator's real HOME, so never their real
      // credentials. (No PATH either: node is spawned by absolute path.)
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('the mm process', () => {
  test('--help runs under plain node and lists the commands', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mm-cli-'))
    const out = await mm(['--help'], { HOME: home })
    expect(out.stderr).toBe('')
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('mm keys revoke <id>')
    expect(out.stdout).toContain('mm login [--scope read,resource.write]')
  }, T)

  test('two processes hitting a 401 at once refresh exactly once between them', async () => {
    const op = await startStub()
    const api = await startStub()
    stubs.push(op, api)
    serveDiscovery(op)
    const resource = adminApiResource(api.url)
    const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'mm-cli-')), METAMODELS_ISSUER: op.url, METAMODELS_CONSOLE_URL: api.url }
    const path = credentialsPath(env)
    writeCredentials(path, {
      issuer: op.url, resource, scope: 'read', accessToken: 'at-1', accessExpiresAt: 0, refreshToken: 'rt-1', obtainedAt: 0,
    })

    // Both processes must be past their first 401 before the OP answers the first refresh, so the
    // second really does arrive while the first is refreshing. The first 401 each gets is counted;
    // the refresh is held until there are two.
    let firstTries = 0
    let bothRefused!: () => void
    const refusedTwice = new Promise<void>((r) => { bothRefused = r })
    api.on('GET /api/admin/v1/flocks', (req) => {
      if (req.headers.authorization === 'Bearer at-2') return { status: 200, json: [{ id: 'f1' }] }
      if (++firstTries === 2) bothRefused()
      return { status: 401, json: { title: 'Unauthorized', status: 401 } }
    })
    const spent = new Set<string>()
    op.on('POST /token', async (req) => {
      const presented = req.form.refresh_token
      // A rotating OP: a second presentation of rt-1 is a reuse, and refused.
      if (spent.has(presented) || presented !== 'rt-1') return { status: 400, json: { error: 'invalid_grant' } }
      spent.add(presented)
      await refusedTwice
      return { status: 200, json: { access_token: 'at-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2', scope: 'read' } }
    })

    const [a, b] = await Promise.all([mm(['flocks', 'list'], env), mm(['flocks', 'list'], env)])
    expect(firstTries).toBe(2)
    expect(op.requests.filter((r) => r.path === '/token')).toHaveLength(1)
    for (const run of [a, b]) {
      expect(run.stderr).toBe('')
      expect(run.code).toBe(0)
      expect(JSON.parse(run.stdout)).toEqual([{ id: 'f1' }])
    }
    expect(readCredentials(path, op.url)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' })
  }, T)
})
