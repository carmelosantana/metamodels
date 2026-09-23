import { expect, test, type Browser } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { login, watchForViolations } from './helpers/console.js'
import { OPERATOR_EMAIL, OPERATOR_PASSWORD, RUN_ID } from './helpers/env.js'

/**
 * The admin API (M2), end to end: the real `mm` CLI signs in with the device grant, approved in a
 * real browser, then drives `/api/admin/v1` the way an operator would. The negative cases prove the
 * boundary: bearer-only, access tokens only (an ID token is refused), scope intersected with role,
 * keys revoked and never deleted. The audience check is not proven here: that needs a second control
 * plane with another `CONSOLE_URL`, which `scripts/aud-isolation.sh` starts (apps/e2e/README.md).
 *
 * It creates and deletes resources and changes a user's role, so it runs only against a stack named
 * explicitly. It never falls back to the `localhost` defaults the other specs use: those ports may
 * belong to a stack with real data in it, or to something else entirely.
 *
 * The CLI's credentials go to a fresh temporary `XDG_CONFIG_HOME` per sign-in, never to the
 * operator's own `~/.config/metamodels`.
 */

const CONSOLE_URL = process.env.E2E_BASE_URL
const ISSUER = process.env.E2E_AUTH_URL
/** A second user, seeded like the operator and demoted to `viewer` here. See apps/e2e/README.md. */
const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD

const REQUIRED = { E2E_BASE_URL: CONSOLE_URL, E2E_AUTH_URL: ISSUER, E2E_VIEWER_EMAIL: VIEWER_EMAIL, E2E_VIEWER_PASSWORD: VIEWER_PASSWORD }
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k)
const refusal = missing.length
  ? `admin-api.spec.ts mutates the stack it runs against, so it needs it named explicitly: set ${missing.join(', ')}`
  : null

test.skip(refusal !== null, refusal ?? '')
test.describe.configure({ mode: 'serial' })

const API = `${CONSOLE_URL}/api/admin/v1`
const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli')
/** RFC 2606 reserves `.invalid`: the flock's upstream resolves nowhere, on any network. */
const UNREACHABLE_UPSTREAM = 'http://ollama.invalid:11434'

const FLOCK_NAME = `e2e-admin-flock-${RUN_ID}`
const PADDOCK_NAME = `e2e-admin-paddock-${RUN_ID}`
const PADDOCK_SLUG = `e2e-admin-${RUN_ID}`
const KEY_NAME = `e2e-admin-key-${RUN_ID}`

interface Cli { code: number | null; stdout: string; stderr: string }
interface Credential { resource: string; scope: string; accessToken: string; refreshToken?: string }

/** Carried between the ordered steps below. */
const state = {
  homes: [] as string[],
  operator: '' as string,
  readOnly: '' as string,
  viewer: '' as string,
  flockId: '',
  paddockId: '',
  keyId: '',
}

function freshHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'mm-e2e-cli-'))
  state.homes.push(home)
  return home
}

function credentialsFile(home: string): string {
  return path.join(home, 'metamodels', 'credentials.json')
}

function credential(home: string): Credential {
  const store = JSON.parse(readFileSync(credentialsFile(home), 'utf8')) as Record<string, Credential>
  const cred = store[ISSUER!]
  if (!cred) throw new Error(`no credential for ${ISSUER} in ${credentialsFile(home)}`)
  return cred
}

/** A JWT's claims. Signature not checked: the admin API is what checks it; this only reads `jti`. */
function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
}

/** A JWT's protected header, likewise not verified. This spec reads `typ` from it. */
function joseHeader(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString('utf8'))
}

/** The CLI exactly as an operator runs it (`pnpm --filter @metamodels/cli start`), minus pnpm. */
function startCli(home: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', './src/ts-resolve.ts', 'src/index.ts', ...args,
    '--issuer', ISSUER!, ...(args[0] === 'logout' ? [] : ['--console', CONSOLE_URL!])], {
    cwd: CLI_DIR,
    env: { ...process.env, XDG_CONFIG_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', (b: Buffer) => { out.stdout += b.toString('utf8') })
  child.stderr.on('data', (b: Buffer) => { out.stderr += b.toString('utf8') })
  const done = new Promise<Cli>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, ...out }))
  })
  return { out, done }
}

async function cli(home: string, ...args: string[]): Promise<Cli> {
  return startCli(home, args).done
}

/** Runs a CLI command that must succeed and print JSON (or nothing). */
async function cliJson(home: string, ...args: string[]): Promise<unknown> {
  const r = await cli(home, ...args)
  expect(r.code, `mm ${args.join(' ')} failed:\n${r.stderr}`).toBe(0)
  return r.stdout.trim() === '' ? null : JSON.parse(r.stdout)
}

/**
 * `mm login`, approved in a fresh browser context the way a person would: open the printed link,
 * check the code, check the requesting machine, Approve, then type the password (every device
 * approval asks for it). No CSP violation or page error is tolerated on any of those pages.
 */
async function deviceLogin(browser: Browser, scope: string, email: string, password: string): Promise<string> {
  const home = freshHome()
  const run = startCli(home, ['login', '--scope', scope])

  let link = ''
  let userCode = ''
  await expect.poll(() => {
    link = /^\s+(https?:\/\/\S+)\s*$/m.exec(run.out.stderr)?.[1] ?? ''
    userCode = /shows the code\s+(\S+)/.exec(run.out.stderr)?.[1] ?? ''
    return link !== '' && userCode !== ''
  }, { message: 'the CLI never printed a verification link' }).toBe(true)
  expect(new URL(link).origin).toBe(new URL(ISSUER!).origin)

  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = watchForViolations(page)
  try {
    await page.goto(link)
    await expect(page.getByRole('heading', { name: 'Connect the MetaModels CLI' })).toBeVisible()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.getByRole('heading', { name: 'Approve this sign-in?' })).toBeVisible()
    await expect(page.locator('p.code')).toHaveText(userCode)
    // Where the request came from: the CLI's own address and user agent, not the browser's.
    const device = page.locator('p.device')
    await expect(device).toContainText(/IP address: (?!unknown)\S+/)
    await expect(device).toContainText(/User agent: metamodels-cli \(/)
    await page.getByRole('button', { name: 'Approve' }).click()

    await expect(page).toHaveURL(new RegExp(`^${escapeRe(ISSUER!)}/interaction/`))
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible()
    expect(problems).toEqual([])
  } finally {
    await context.close()
  }

  const r = await run.done
  expect(r.code, `mm login failed:\n${r.stderr}`).toBe(0)
  expect(JSON.parse(r.stdout)).toMatchObject({ issuer: ISSUER, console: CONSOLE_URL })
  return home
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function api(method: string, route: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) as Record<string, unknown> : null }
}

const bearer = (home: string) => ({ authorization: `Bearer ${credential(home).accessToken}` })

/** One line per negative case, so the run's output is the record of what the API answered. */
function record(what: string, status: number) {
  console.log(`[admin-api] ${what} -> ${status}`)
}

test.afterAll(async () => {
  // Fixtures a failed run left behind. Deleting the flock cascades to its paddock.
  if (state.operator && state.flockId) {
    await api('DELETE', `/flocks/${state.flockId}`, bearer(state.operator)).catch(() => {})
  }
  for (const home of state.homes) rmSync(home, { recursive: true, force: true })
})

test('mm login: a device approval in the browser leaves a 0600 credential', async ({ browser }) => {
  state.operator = await deviceLogin(browser, 'read,resource.write', OPERATOR_EMAIL, OPERATOR_PASSWORD)

  expect(statSync(credentialsFile(state.operator)).mode & 0o777).toBe(0o600)
  expect(statSync(path.dirname(credentialsFile(state.operator))).mode & 0o777).toBe(0o700)

  const cred = credential(state.operator)
  expect(cred.scope.split(' ')).toEqual(expect.arrayContaining(['read', 'resource.write']))
  expect(cred.resource).toBe(`${CONSOLE_URL}/api/admin`)
  const at = claims(cred.accessToken)
  expect(at).toMatchObject({ aud: cred.resource, client_id: 'metamodels-cli' })
  console.log(`[admin-api] operator token jti=${String(at.jti)}`)
})

test('the CLI creates, reads, replaces and deletes; a key is revoked, and every change is the token\'s', async () => {
  const home = state.operator

  const flock = await cliJson(home, 'flocks', 'create', '--data',
    JSON.stringify({ name: FLOCK_NAME, breed: 'ollama', baseUrl: UNREACHABLE_UPSTREAM, tlsTrust: false })) as Record<string, string>
  expect(flock).toMatchObject({ name: FLOCK_NAME, breed: 'ollama', baseUrl: UNREACHABLE_UPSTREAM, tlsTrust: false })
  state.flockId = flock.id

  const flocks = await cliJson(home, 'flocks', 'list') as Array<Record<string, string>>
  expect(flocks.map((f) => f.id)).toContain(state.flockId)
  expect(await cliJson(home, 'flocks', 'get', state.flockId)).toMatchObject({ id: state.flockId, name: FLOCK_NAME })
  expect(await cliJson(home, 'flocks', 'replace', state.flockId, '--data',
    JSON.stringify({ name: `${FLOCK_NAME}-renamed`, breed: 'ollama', baseUrl: UNREACHABLE_UPSTREAM, tlsTrust: false })))
    .toMatchObject({ id: state.flockId, name: `${FLOCK_NAME}-renamed` })

  const paddock = await cliJson(home, 'paddocks', 'create', '--data',
    JSON.stringify({ flockId: state.flockId, name: PADDOCK_NAME, slug: PADDOCK_SLUG })) as Record<string, string>
  expect(paddock).toMatchObject({ flockId: state.flockId, slug: PADDOCK_SLUG })
  state.paddockId = paddock.id

  // The plaintext key is in this output exactly once; it is never logged.
  const key = await cliJson(home, 'keys', 'create', '--data',
    JSON.stringify({ name: KEY_NAME, paddockIds: [state.paddockId] })) as Record<string, string>
  state.keyId = key.id
  expect(state.keyId).toBeTruthy()

  expect(await cliJson(home, 'keys', 'revoke', state.keyId)).toBeNull()
  const keys = await cliJson(home, 'keys', 'list') as Array<Record<string, string>>
  expect(keys.find((k) => k.id === state.keyId)).toMatchObject({ status: 'revoked' })

  // There is no `mm keys delete`: the CLI refuses it before sending anything.
  const del = await cli(home, 'keys', 'delete', state.keyId)
  expect(del.code).toBe(2)
  expect(del.stderr).toContain('a key is revoked, never deleted')

  expect(await cliJson(home, 'paddocks', 'delete', state.paddockId)).toBeNull()
  expect(await cliJson(home, 'flocks', 'delete', state.flockId)).toBeNull()
  state.flockId = ''

  // The audit rows are checked against the database outside this spec (apps/e2e/README.md): they
  // are keyed by these targets, and each must carry changed_by = token:metamodels-cli:<jti>.
  const jti = String(claims(credential(home).accessToken).jti)
  console.log(`[admin-api] audit targets flock:${flock.id} paddock:${paddock.id} key:${key.id}; expect changed_by=token:metamodels-cli:${jti}`)
})

test('a read-only token is refused a write, naming the capability it lacks', async ({ browser }) => {
  state.readOnly = await deviceLogin(browser, 'read', OPERATOR_EMAIL, OPERATOR_PASSWORD)
  expect(credential(state.readOnly).scope.split(' ')).not.toContain('resource.write')

  const read = await api('GET', '/flocks', bearer(state.readOnly))
  expect(read.status).toBe(200)

  const write = await api('POST', '/flocks', bearer(state.readOnly),
    { name: `${FLOCK_NAME}-denied`, breed: 'ollama', baseUrl: UNREACHABLE_UPSTREAM, tlsTrust: false })
  record('read-only token, POST /flocks', write.status)
  expect(write.status).toBe(403)
  expect(write.headers.get('content-type')).toBe('application/problem+json')
  expect(write.body).toMatchObject({ status: 403, capability: 'resource.write' })

  // And the CLI renders that problem as the operator's next step.
  const r = await cli(state.readOnly, 'flocks', 'create', '--data',
    JSON.stringify({ name: `${FLOCK_NAME}-denied`, breed: 'ollama', baseUrl: UNREACHABLE_UPSTREAM, tlsTrust: false }))
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('capability: resource.write')
})

test('a viewer holding resource.write is still refused: the token never exceeds its user\'s role', async ({ browser }) => {
  // The viewer is seeded like the operator (an admin), then demoted through the console's Team page.
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await login(page)
    await page.goto('/team')
    const role = page.getByRole('row').filter({ hasText: VIEWER_EMAIL! }).getByRole('combobox')
    if (await role.inputValue() !== 'viewer') {
      await role.selectOption('viewer')
      await expect.poll(async () => {
        await page.reload()
        return page.getByRole('row').filter({ hasText: VIEWER_EMAIL! }).getByRole('combobox').inputValue()
      }).toBe('viewer')
    }
  } finally {
    await context.close()
  }

  state.viewer = await deviceLogin(browser, 'read,resource.write', VIEWER_EMAIL!, VIEWER_PASSWORD!)
  expect(credential(state.viewer).scope.split(' ')).toContain('resource.write')

  expect((await api('GET', '/flocks', bearer(state.viewer))).status).toBe(200)
  const write = await api('POST', '/flocks', bearer(state.viewer),
    { name: `${FLOCK_NAME}-viewer`, breed: 'ollama', baseUrl: UNREACHABLE_UPSTREAM, tlsTrust: false })
  record('viewer role, token scoped resource.write, POST /flocks', write.status)
  expect(write.status).toBe(403)
  expect(write.body).toMatchObject({ status: 403, capability: 'resource.write' })
})

test('the boundary: bearer only, access tokens only, keys never deleted, the contract public', async () => {
  const noAuth = await api('GET', '/flocks')
  record('no Authorization header', noAuth.status)
  expect(noAuth.status).toBe(401)
  expect(noAuth.headers.get('www-authenticate')).toBe('Bearer')
  expect(noAuth.body).toMatchObject({ type: 'about:blank', status: 401 })

  const both = await api('GET', '/flocks', { ...bearer(state.operator), cookie: 'mm_session=x' })
  record('Authorization + Cookie: mm_session=x', both.status)
  expect(both.status).toBe(400)

  const cookieOnly = await api('GET', '/flocks', { cookie: 'mm_session=x' })
  record('Cookie: mm_session=x alone', cookieOnly.status)
  expect(cookieOnly.status).toBe(401)

  // An ID token replayed as an access token: a real token from the same OP, signed with the same key.
  // The CLI never stores one, so it comes from a refresh of the read-only sign-in's refresh token
  // (that sign-in is not used again). The API refuses it on `typ` (it must be `at+jwt`), before it
  // looks at `aud`, so this case proves the `typ` check and NOT the audience check. The audience
  // check needs a second control plane: `scripts/aud-isolation.sh`.
  const ro = credential(state.readOnly)
  const discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json() as { token_endpoint: string }
  const refreshed = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: ro.refreshToken!, client_id: 'metamodels-cli', resource: ro.resource,
    }),
  })
  expect(refreshed.status).toBe(200)
  const idToken = (await refreshed.json() as { id_token?: string }).id_token
  expect(idToken, 'the OP returned no id_token on refresh').toBeTruthy()
  // The anchor: this really is the CLI's ID token, not an access token.
  expect(claims(idToken!).aud).toBe('metamodels-cli')
  expect(joseHeader(idToken!).typ).not.toBe('at+jwt')
  const idAsAccess = await api('GET', '/flocks', { authorization: `Bearer ${idToken}` })
  record('an ID token replayed as an access token (wrong typ), GET /flocks', idAsAccess.status)
  expect(idAsAccess.status).toBe(401)

  const del = await api('DELETE', `/keys/${state.keyId}`, bearer(state.operator))
  record('DELETE /keys/{id}', del.status)
  expect(del.status).toBe(405)
  expect(del.headers.get('allow')).toBe('')

  const doc = await api('GET', '/openapi.json')
  record('GET /openapi.json, no token', doc.status)
  expect(doc.status).toBe(200)
  expect(doc.body).toMatchObject({ openapi: expect.any(String), servers: [{ url: '/api/admin/v1' }] })
})
