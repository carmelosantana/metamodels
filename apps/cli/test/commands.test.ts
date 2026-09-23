import { existsSync, mkdtempSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { adminApiResource, CLI_CLIENT_ID } from '@metamodels/schema'
import { COMMANDS, main, type MainIo } from '../src/commands.js'
import { credentialsPath, readCredentials, writeCredentials, type StoredCredential } from '../src/credentials.js'
import { serveDiscovery, startStub, type Reply, type Stub } from './helpers/stub.js'

let stubs: Stub[] = []
afterEach(async () => {
  await Promise.all(stubs.map((s) => s.close()))
  stubs = []
})

async function stub(): Promise<Stub> {
  const s = await startStub()
  stubs.push(s)
  return s
}

/** A world for `main`: a stub OP, a stub console, and a temp XDG config dir. */
async function world() {
  const op = await stub()
  serveDiscovery(op)
  const consoleStub = await stub()
  const env = {
    XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'mm-cli-')),
    METAMODELS_ISSUER: op.url,
    METAMODELS_CONSOLE_URL: consoleStub.url,
  }
  const path = credentialsPath(env)
  const resource = adminApiResource(consoleStub.url)
  const out: string[] = []
  const err: string[] = []
  const io: MainIo = {
    env,
    stdout: (s) => { out.push(s) },
    stderr: (s) => { err.push(s) },
    readStdin: async () => '',
    op: { sleep: async () => {} },
  }
  const signIn = (over: Partial<StoredCredential> = {}) => writeCredentials(path, {
    issuer: op.url, resource, scope: 'read resource.write', accessToken: 'at-1', accessExpiresAt: Date.now() + 3_600_000,
    refreshToken: 'rt-1', obtainedAt: Date.now(), ...over,
  })
  const run = (...argv: string[]) => main(argv, io)
  return { op, api: consoleStub, env, path, resource, io, out, err, signIn, run, stdout: () => out.join(''), stderr: () => err.join('') }
}

const ok = (json: unknown): Reply => ({ status: 200, json })

describe('the command table', () => {
  test('is exactly the plan\'s commands — and has no `keys delete`', () => {
    const byGroup: Record<string, string[]> = {}
    for (const c of COMMANDS) (byGroup[c.group] ??= []).push(c.action)
    expect(byGroup).toEqual({
      flocks: ['list', 'get', 'create', 'replace', 'delete'],
      paddocks: ['list', 'get', 'create', 'replace', 'delete', 'status'],
      fence: ['get', 'set'],
      templates: ['list', 'add', 'replace', 'remove'],
      keys: ['list', 'create', 'revoke'],
      usage: ['matrix', 'daily', 'top-keys'],
    })
  })
})

describe('main: API commands', () => {
  test('flocks list prints the body as JSON on stdout, sent with the stored Bearer token', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/flocks', () => ok([{ id: 'f1', name: 'one' }]))
    expect(await w.run('flocks', 'list')).toBe(0)
    expect(JSON.parse(w.stdout())).toEqual([{ id: 'f1', name: 'one' }])
    expect(w.api.requests[0].headers.authorization).toBe('Bearer at-1')
    expect(w.api.requests[0].headers.cookie).toBeUndefined()
  })

  test('a 401 refreshes once through the OP, naming the resource, and stores the rotated token', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/flocks', (r) => r.headers.authorization === 'Bearer at-2' ? ok([]) : { status: 401, json: { title: 'Unauthorized', status: 401 } })
    w.op.on('POST /token', () => ok({ access_token: 'at-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2', scope: 'read' }))
    expect(await w.run('flocks', 'list')).toBe(0)
    const refreshes = w.op.requests.filter((r) => r.path === '/token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0].form).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: CLI_CLIENT_ID, resource: w.resource })
    expect(readCredentials(w.path, w.op.url)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' })
  })

  test('an expired stored token is refreshed once through the OP before the call, and the API never sees it', async () => {
    const w = await world()
    w.signIn({ accessExpiresAt: Date.now() - 60_000 })
    w.api.on('GET /api/admin/v1/flocks', (r) => r.headers.authorization === 'Bearer at-2' ? ok([]) : { status: 401, json: { title: 'Unauthorized', status: 401 } })
    w.op.on('POST /token', () => ok({ access_token: 'at-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2', scope: 'read' }))
    expect(await w.run('flocks', 'list')).toBe(0)
    expect(w.op.requests.filter((r) => r.path === '/token')).toHaveLength(1)
    expect(w.api.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-2'])
    expect(readCredentials(w.path, w.op.url)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' })
  })

  test('when the OP answers 503 to a pre-send refresh, a token with 10 seconds left is still sent, and kept', async () => {
    const w = await world()
    w.signIn({ accessExpiresAt: Date.now() + 10_000 })
    w.api.on('GET /api/admin/v1/flocks', () => ok([{ id: 'f1' }]))
    w.op.on('POST /token', () => ({ status: 503, json: { error: 'temporarily_unavailable' } }))
    expect(await w.run('flocks', 'list')).toBe(0)
    expect(JSON.parse(w.stdout())).toEqual([{ id: 'f1' }])
    expect(w.op.requests.filter((r) => r.path === '/token')).toHaveLength(1)
    expect(w.api.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-1'])
    expect(readCredentials(w.path, w.op.url)).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' })
  })

  test('when the OP answers 503 to a pre-send refresh of an expired token, the command fails with that error and sends nothing', async () => {
    const w = await world()
    w.signIn({ accessExpiresAt: Date.now() - 60_000 })
    w.api.on('GET /api/admin/v1/flocks', () => ({ status: 401, json: { title: 'Unauthorized', status: 401 } }))
    w.op.on('POST /token', () => ({ status: 503, json: { error: 'temporarily_unavailable' } }))
    expect(await w.run('flocks', 'list')).toBe(1)
    expect(w.stderr()).toMatch(/could not be renewed: the authorization server answered HTTP 503/)
    expect(w.stderr()).not.toMatch(/401/)
    expect(w.op.requests.filter((r) => r.path === '/token')).toHaveLength(1)
    expect(w.api.requests).toHaveLength(0)
    // Not refused, so not spent: the next command may retry with it.
    expect(readCredentials(w.path, w.op.url)).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' })
  })

  test('a fresh stored token is sent without a refresh', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/flocks', () => ok([]))
    expect(await w.run('flocks', 'list')).toBe(0)
    expect(w.op.requests.filter((r) => r.path === '/token')).toHaveLength(0)
    expect(w.api.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-1'])
  })

  test('an expired stored token with no refresh token still says to sign in again', async () => {
    const w = await world()
    w.signIn({ accessExpiresAt: Date.now() - 60_000, refreshToken: undefined })
    w.api.on('GET /api/admin/v1/flocks', () => ({ status: 401, json: { title: 'Unauthorized', status: 401 } }))
    expect(await w.run('flocks', 'list')).toBe(1)
    expect(w.stderr()).toMatch(/mm login/)
    expect(w.op.requests.filter((r) => r.path === '/token')).toHaveLength(0)
  })

  test('when the refresh is refused, it says to sign in again, exits non-zero, and prints no token', async () => {
    const w = await world()
    w.signIn({ accessToken: 'at-secret-1', refreshToken: 'rt-secret-1' })
    w.api.on('GET /api/admin/v1/flocks', () => ({ status: 401, json: { title: 'Unauthorized', status: 401, detail: 'the presented access token was rejected' } }))
    w.op.on('POST /token', () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'grant request is invalid' } }))
    expect(await w.run('flocks', 'list')).toBe(1)
    expect(w.stderr()).toMatch(/mm login/)
    expect(w.stdout()).toBe('')
    for (const secret of ['at-secret-1', 'rt-secret-1']) {
      expect(w.stderr()).not.toContain(secret)
    }
    // The spent refresh token is gone: the next run cannot present it again.
    expect(readCredentials(w.path, w.op.url)).toBeNull()
  })

  test('a problem+json error goes to stderr, readable, with the missing capability', async () => {
    const w = await world()
    w.signIn()
    w.api.on('POST /api/admin/v1/flocks', () => ({
      status: 403, headers: { 'content-type': 'application/problem+json' },
      json: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'missing capability resource.write', capability: 'resource.write' },
    }))
    expect(await w.run('flocks', 'create', '--data', '{"name":"x"}')).toBe(1)
    expect(w.stderr()).toContain('403 Forbidden: missing capability resource.write')
    expect(w.stderr()).toContain('capability: resource.write')
    expect(w.stdout()).toBe('')
  })

  test('fills path parameters from positionals, in order', async () => {
    const w = await world()
    w.signIn()
    w.api.on('PUT /api/admin/v1/paddocks/p1/templates/t9', () => ok({ id: 't9' }))
    expect(await w.run('templates', 'replace', 'p1', 't9', '--data', '{"graphText":"{}"}')).toBe(0)
    expect(w.api.requests[0].method).toBe('PUT')
    expect(JSON.parse(w.api.requests[0].body)).toEqual({ graphText: '{}' })
  })

  test('paddocks status sends {status} to the status sub-resource', async () => {
    const w = await world()
    w.signIn()
    w.api.on('PUT /api/admin/v1/paddocks/p1/status', () => ok({ id: 'p1', status: 'disabled' }))
    expect(await w.run('paddocks', 'status', 'p1', 'disabled')).toBe(0)
    expect(JSON.parse(w.api.requests[0].body)).toEqual({ status: 'disabled' })
  })

  test('reads a body from --file', async () => {
    const w = await world()
    w.signIn()
    const file = join(w.env.XDG_CONFIG_HOME, 'fence.json')
    writeFileSync(file, '{"constraintJson":{}}')
    w.api.on('PUT /api/admin/v1/paddocks/p1/fence', () => ok({}))
    expect(await w.run('fence', 'set', 'p1', '--file', file)).toBe(0)
    expect(JSON.parse(w.api.requests[0].body)).toEqual({ constraintJson: {} })
  })

  test('maps kebab-case flags onto the operation\'s query parameters', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/usage/daily', () => ok([]))
    expect(await w.run('usage', 'daily', '--dim', 'jobs', '--start-bucket', '2026-09-01T00', '--end-bucket', '2026-09-02T00')).toBe(0)
    const q = new URL(w.api.requests[0].path, 'http://x').searchParams
    expect(Object.fromEntries(q)).toEqual({ dim: 'jobs', startBucket: '2026-09-01T00', endBucket: '2026-09-02T00' })
  })

  test('a 204 prints nothing and exits 0', async () => {
    const w = await world()
    w.signIn()
    w.api.on('POST /api/admin/v1/keys/k1/revoke', () => ({ status: 204 }))
    expect(await w.run('keys', 'revoke', 'k1')).toBe(0)
    expect(w.stdout()).toBe('')
    expect(w.api.requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/admin/v1/keys/k1/revoke'])
  })

  test('says how to get the next page, on stderr so stdout stays JSON', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/keys', () => ({ status: 200, json: [{ id: 'k1' }], headers: { link: `<${w.api.url}/api/admin/v1/keys?limit=1&cursor=NEXT>; rel="next"` } }))
    expect(await w.run('keys', 'list', '--limit', '1')).toBe(0)
    expect(JSON.parse(w.stdout())).toEqual([{ id: 'k1' }])
    expect(w.stderr()).toContain('--cursor NEXT')
  })

  test('an unreachable console is exit 1 with the network cause, not a bare "fetch failed"', async () => {
    const w = await world()
    const gone = await startStub()
    await gone.close()
    w.signIn({ resource: adminApiResource(gone.url) })
    const io = { ...w.io, env: { ...w.env, METAMODELS_CONSOLE_URL: gone.url } }
    expect(await main(['flocks', 'list'], io)).toBe(1)
    expect(w.stderr()).toMatch(/could not send the request to .*: ECONNREFUSED/)
    expect(w.stderr()).not.toContain('at-1')
  })

  test('a stored token the Headers API rejects never reaches stderr', async () => {
    const w = await world()
    w.signIn({ accessToken: 'eyJSECRET\u0000tail' })
    w.api.on('GET /api/admin/v1/flocks', () => ok([]))
    expect(await w.run('flocks', 'list')).toBe(1)
    expect(w.stderr()).toContain(`mm: could not send the request to ${w.api.url}`)
    expect(w.stderr()).not.toMatch(/SECRET|tail|Bearer/)
    expect(w.api.requests).toHaveLength(0)
  })

  test('refuses to send a stored token to a console it was not issued for', async () => {
    const w = await world()
    w.signIn({ resource: 'http://other.test/api/admin' })
    expect(await w.run('flocks', 'list')).toBe(1)
    expect(w.stderr()).toContain('http://other.test/api/admin')
    expect(w.api.requests).toHaveLength(0)
    expect(w.op.requests).toHaveLength(0)
  })
})

describe('main: usage errors exit 2 and send nothing', () => {
  test('`keys delete` does not exist — deletion over the admin API is a revoke', async () => {
    const w = await world()
    w.signIn()
    w.api.on('POST /api/admin/v1/keys/k1/revoke', () => ({ status: 204 }))
    expect(await w.run('keys', 'delete', 'k1')).toBe(2)
    expect(w.stderr()).toMatch(/keys revoke/)
    expect(w.api.requests).toHaveLength(0)
    // The same shape with the real verb does reach the API.
    expect(await w.run('keys', 'revoke', 'k1')).toBe(0)
    expect(w.api.requests).toHaveLength(1)
  })

  test('an unknown command, a missing argument, an extra argument, bad JSON, a foreign flag', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/flocks/f1', () => ok({ id: 'f1' }))
    expect(await w.run('flocks', 'explode')).toBe(2)
    expect(await w.run('flocks', 'get')).toBe(2)
    expect(await w.run('flocks', 'get', 'f1', 'f2')).toBe(2)
    expect(await w.run('flocks', 'create', '--data', '{nope')).toBe(2)
    expect(await w.run('flocks', 'create')).toBe(2)
    expect(await w.run('flocks', 'get', 'f1', '--limit', '5')).toBe(2)
    expect(await w.run('flocks', 'get', 'f1', '--data', '{}')).toBe(2)
    expect(w.api.requests).toHaveLength(0)
    expect(await w.run('flocks', 'get', 'f1')).toBe(0)
    expect(w.api.requests).toHaveLength(1)
  })

  // encodeURIComponent leaves `.` and `..` as they are, and the URL parser then removes them as dot
  // segments: `mm flocks delete ..` would send DELETE /api/admin/v1/ and `mm templates delete p1 .`
  // would address the collection. An empty one leaves `//` for a server to normalise as it likes.
  test.each([
    ['flocks', 'delete', '..'],
    ['flocks', 'delete', '.'],
    ['flocks', 'delete', ''],
    ['flocks', 'get', '..'],
    ['templates', 'remove', 'p1', '..'],
    ['templates', 'remove', '..', 't1'],
    ['keys', 'revoke', '.'],
  ])('a path argument that is `.`, `..` or empty is a usage error: mm %s %s %j', async (...argv) => {
    const w = await world()
    w.signIn()
    expect(await w.run(...argv)).toBe(2)
    expect(w.stderr()).toMatch(/cannot be empty, `\.` or `\.\.`/)
    expect(w.api.requests).toHaveLength(0)
    expect(w.op.requests).toHaveLength(0)
  })

  test('a dot inside an id is still sent, encoded as part of the segment', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/flocks/a..b', () => ok({ id: 'a..b' }))
    expect(await w.run('flocks', 'get', 'a..b')).toBe(0)
    expect(w.api.requests.map((r) => r.path)).toEqual(['/api/admin/v1/flocks/a..b'])
  })

  test('a --file that cannot be read is a usage error, and nothing is sent', async () => {
    const w = await world()
    w.signIn()
    w.api.on('POST /api/admin/v1/flocks', () => ok({ id: 'f1' }))
    const missing = join(w.env.XDG_CONFIG_HOME, 'no-such-body.json')
    expect(await w.run('flocks', 'create', '--file', missing)).toBe(2)
    expect(w.stderr()).toContain(missing)
    expect(w.api.requests).toHaveLength(0)
    // The same command with a readable file does reach the API.
    writeFileSync(missing, '{"name":"x"}')
    expect(await w.run('flocks', 'create', '--file', missing)).toBe(0)
    expect(w.api.requests).toHaveLength(1)
  })

  test('with no console configured, it says what to set', async () => {
    const w = await world()
    w.signIn()
    const io = { ...w.io, env: { ...w.env, METAMODELS_CONSOLE_URL: undefined } }
    expect(await main(['flocks', 'list'], io)).toBe(2)
    expect(w.stderr()).toMatch(/METAMODELS_CONSOLE_URL/)
  })

  test('--help prints the commands on stdout and exits 0', async () => {
    const w = await world()
    expect(await w.run('--help')).toBe(0)
    expect(w.stdout()).toContain('mm keys revoke <id>')
    expect(w.stdout()).not.toContain('keys delete')
  })

  test('--help shows required flags without brackets, and optional ones in them', async () => {
    const w = await world()
    expect(await w.run('--help')).toBe(0)
    expect(w.stdout()).toContain(
      'mm usage daily --dim VALUE --start-bucket VALUE --end-bucket VALUE [--key-id VALUE] [--paddock-id VALUE]\n',
    )
    expect(w.stdout()).toContain('mm usage matrix --start-bucket VALUE --end-bucket VALUE [--key-id VALUE] [--paddock-id VALUE]\n')
    expect(w.stdout()).toContain('mm usage top-keys --dim VALUE --start-bucket VALUE --end-bucket VALUE [--limit VALUE]\n')
    expect(w.stdout()).toContain('mm flocks list [--limit VALUE] [--cursor VALUE]\n')
  })
})

describe('main: plain http to a host that is not loopback', () => {
  const LAN = 'http://console.lan.test'
  const WARNING = /^mm: warning: .*plain http/m

  /** The world, with its console reached as LAN (non-loopback, plain http) through the stub. */
  async function lanWorld() {
    const w = await world()
    w.signIn({ resource: adminApiResource(LAN) })
    w.api.on('GET /api/admin/v1/flocks', () => ok([]))
    const io: MainIo = {
      ...w.io,
      env: { ...w.env, METAMODELS_CONSOLE_URL: LAN },
      fetch: (input, init) => fetch(String(input).replace(LAN, w.api.url), init),
    }
    return { ...w, io }
  }

  test('is refused before anything is sent, naming the opt-in', async () => {
    const w = await lanWorld()
    expect(await main(['flocks', 'list'], w.io)).toBe(2)
    expect(w.stderr()).toMatch(/--allow-insecure-http/)
    expect(w.stderr()).toMatch(/METAMODELS_ALLOW_INSECURE_HTTP=1/)
    expect(w.api.requests).toHaveLength(0)
  })

  test.each([
    ['the flag', ['--allow-insecure-http'], {}],
    ['the environment', [], { METAMODELS_ALLOW_INSECURE_HTTP: '1' }],
  ])('is allowed with %s, with a one-line warning on stderr', async (_name, flags, env) => {
    const w = await lanWorld()
    expect(await main(['flocks', 'list', ...flags], { ...w.io, env: { ...w.io.env, ...env } })).toBe(0)
    expect(w.api.requests[0].headers.authorization).toBe('Bearer at-1')
    expect(w.stderr().match(new RegExp(WARNING, 'gm'))).toHaveLength(1)
  })

  test('loopback http needs no opt-in and prints no warning', async () => {
    const w = await world()
    w.signIn()
    w.api.on('GET /api/admin/v1/flocks', () => ok([]))
    expect(await w.run('flocks', 'list')).toBe(0)
    expect(w.stderr()).not.toMatch(WARNING)
  })
})

describe('main: login', () => {
  const token = { access_token: 'at-new-secret', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-new-secret', scope: 'read resource.write' }

  async function loginWorld() {
    const w = await world()
    w.op.on('POST /device/auth', () => ok({
      device_code: 'dc', user_code: 'BCDF-GHJK', verification_uri: `${w.op.url}/device`,
      verification_uri_complete: `${w.op.url}/device?user_code=BCDF-GHJK`, expires_in: 600, interval: 1,
    }))
    w.op.on('POST /token', () => ok(token))
    return w
  }

  test('runs the device flow for the requested scopes, stores 0600, and prints no token', async () => {
    const w = await loginWorld()
    expect(await w.run('login', '--scope', 'read,resource.write')).toBe(0)
    const auth = w.op.requests.find((r) => r.path === '/device/auth')!
    expect(auth.form.scope).toBe('openid offline_access read resource.write')
    expect(auth.form.resource).toBe(w.resource)
    expect(readCredentials(w.path, w.op.url)).toMatchObject({ accessToken: 'at-new-secret', refreshToken: 'rt-new-secret', resource: w.resource })
    expect(statSync(w.path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(w.stdout())).toEqual({ issuer: w.op.url, console: w.api.url, scope: 'read resource.write' })
    expect(w.stderr()).toContain('user_code=BCDF-GHJK')
    for (const s of [w.stdout(), w.stderr()]) {
      expect(s).not.toContain('at-new-secret')
      expect(s).not.toContain('rt-new-secret')
    }
  })

  test('defaults to read only', async () => {
    const w = await loginWorld()
    expect(await w.run('login')).toBe(0)
    expect(w.op.requests.find((r) => r.path === '/device/auth')!.form.scope).toBe('openid offline_access read')
  })

  test('revokes the refresh token it replaces, after storing the new one, still holding the credentials lock', async () => {
    const w = await loginWorld()
    w.signIn()
    let storedAtRevocation: string | undefined
    let lockedAtRevocation: boolean | undefined
    w.op.on('POST /token/revocation', () => {
      storedAtRevocation = readCredentials(w.path, w.op.url)?.refreshToken
      lockedAtRevocation = existsSync(`${w.path}.lock`)
      return { status: 200, text: '' }
    })
    expect(await w.run('login')).toBe(0)
    const revoke = w.op.requests.filter((r) => r.path === '/token/revocation')
    expect(revoke.map((r) => r.form)).toEqual([{ token: 'rt-1', token_type_hint: 'refresh_token', client_id: CLI_CLIENT_ID }])
    expect(storedAtRevocation).toBe('rt-new-secret')
    // A refresh in another process waits on this lock: it cannot rotate the replaced token before it is revoked.
    expect(lockedAtRevocation).toBe(true)
    expect(existsSync(`${w.path}.lock`)).toBe(false)
    expect(readCredentials(w.path, w.op.url)?.refreshToken).toBe('rt-new-secret')
    expect(w.stderr()).not.toContain('rt-1')
  })

  test('revokes nothing when it replaces no sign-in', async () => {
    const w = await loginWorld()
    w.op.on('POST /token/revocation', () => ({ status: 200, text: '' }))
    expect(await w.run('login')).toBe(0)
    expect(w.op.requests.some((r) => r.path === '/token/revocation')).toBe(false)
  })

  test('keeps the new sign-in when the OP cannot revoke the old one, and says so', async () => {
    const w = await loginWorld()
    w.signIn()
    w.op.on('POST /token/revocation', () => ({ status: 503, text: '' }))
    expect(await w.run('login')).toBe(0)
    expect(w.op.requests.some((r) => r.path === '/token/revocation')).toBe(true)
    expect(readCredentials(w.path, w.op.url)?.refreshToken).toBe('rt-new-secret')
    expect(w.stderr()).toMatch(/could not revoke the previous sign-in/)
    expect(w.stderr()).not.toContain('rt-1')
  })

  test('refuses a scope that is not a capability, before contacting the OP', async () => {
    const w = await loginWorld()
    expect(await w.run('login', '--scope', 'read,admin')).toBe(2)
    expect(w.stderr()).toMatch(/admin/)
    expect(w.op.requests).toHaveLength(0)
  })
})

describe('main: logout', () => {
  test('revokes the refresh token at the OP, then forgets the sign-in', async () => {
    const w = await world()
    w.signIn()
    w.op.on('POST /token/revocation', () => ({ status: 200, text: '' }))
    expect(await w.run('logout')).toBe(0)
    const revoke = w.op.requests.find((r) => r.path === '/token/revocation')!
    expect(revoke.form).toEqual({ token: 'rt-1', token_type_hint: 'refresh_token', client_id: CLI_CLIENT_ID })
    expect(readCredentials(w.path, w.op.url)).toBeNull()
    expect(w.stderr()).not.toContain('rt-1')
  })

  test('forgets the sign-in even when the OP cannot revoke, and says so', async () => {
    const w = await world()
    w.signIn()
    w.op.on('POST /token/revocation', () => ({ status: 503, text: '' }))
    expect(await w.run('logout')).toBe(1)
    expect(w.op.requests.some((r) => r.path === '/token/revocation')).toBe(true)
    expect(readCredentials(w.path, w.op.url)).toBeNull()
    expect(w.stderr()).toMatch(/could not revoke/)
  })

  test('says on stderr that it is waiting for the credentials lock', async () => {
    const w = await world()
    w.signIn()
    w.op.on('POST /token/revocation', () => ({ status: 200, text: '' }))
    writeFileSync(`${w.path}.lock`, `${process.pid}\n`)
    const done = w.run('logout')
    await new Promise((r) => setTimeout(r, 150))
    expect(w.op.requests).toHaveLength(0)
    unlinkSync(`${w.path}.lock`)
    expect(await done).toBe(0)
    expect(w.stderr()).toContain('waiting for the credentials lock…')
    expect(readCredentials(w.path, w.op.url)).toBeNull()
  })

  test('needs no console, and is a no-op when not signed in', async () => {
    const w = await world()
    const io = { ...w.io, env: { ...w.env, METAMODELS_CONSOLE_URL: undefined } }
    expect(await main(['logout'], io)).toBe(0)
    expect(w.stderr()).toMatch(/not signed in/i)
    expect(w.op.requests).toHaveLength(0)
  })
})
