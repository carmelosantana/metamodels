import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { expect, test, type Browser } from '@playwright/test'
import { adminCli } from './helpers/admin-cli.js'
import { ensureRole, watchForViolations } from './helpers/console.js'
import { OPERATOR_EMAIL, OPERATOR_PASSWORD, RUN_ID } from './helpers/env.js'

/**
 * M4 end to end (spec §7): a real browser and a real OP take an MCP client through CIMD → consent →
 * token → server/discover → tools/list → tools/call, on an Ollama paddock and on a ComfyUI paddock,
 * then a legacy (2025-11-25) client through initialize → notifications/initialized → tools/list →
 * tools/call on the same paddock and token, against a fake upstream this spec runs; then every negative case of the §7 table that a running
 * stack can show. One `[mcp]` line per case is the record.
 *
 * It creates flocks, paddocks and keys, revokes a key and demotes a user, so it runs only against a
 * stack named explicitly, started with `apps/e2e/compose.mcp.yml` (`E2E_MCP=1` says it was).
 */
const CONSOLE_URL = process.env.E2E_BASE_URL
const ISSUER = process.env.E2E_AUTH_URL
const DATA_PLANE = process.env.E2E_PROXY_URL
const UPSTREAM_HOST = process.env.E2E_UPSTREAM_HOST
const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD

const REQUIRED = {
  E2E_BASE_URL: CONSOLE_URL, E2E_AUTH_URL: ISSUER, E2E_PROXY_URL: DATA_PLANE, E2E_UPSTREAM_HOST: UPSTREAM_HOST,
  E2E_VIEWER_EMAIL: VIEWER_EMAIL, E2E_VIEWER_PASSWORD: VIEWER_PASSWORD, E2E_MCP: process.env.E2E_MCP,
}
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k)
const refusal = missing.length ? `mcp.spec.ts needs a throwaway stack started with compose.mcp.yml: set ${missing.join(', ')}` : null
if (refusal !== null && /^(true|1)$/i.test(process.env.CI ?? '')) throw new Error(`${refusal} (CI is true, so this is an error, not a skip)`)
test.skip(refusal !== null, refusal ?? '')
test.describe.configure({ mode: 'serial' })

const CLIENT = (JSON.parse(readFileSync(new URL('../fixtures/mcp-client.json', import.meta.url), 'utf8')) as Array<{ client_id: string; redirect_uris: string[] }>)[0]!
const REDIRECT = CLIENT.redirect_uris[0]!
const VERSION = '2026-07-28'
const OLLAMA_SLUG = `e2e-mcp-o-${RUN_ID}`
const COMFY_SLUG = `e2e-mcp-c-${RUN_ID}`
const API = `${CONSOLE_URL}/api/admin/v1`
const resourceOf = (slug: string) => `${DATA_PLANE}/p/${slug}/mcp`

const state = {
  homes: [] as string[],
  operator: '',
  flockIds: [] as string[],
  paddock: {} as Record<string, string>,
  tokens: {} as Record<string, { access: string; refresh?: string }>,
}
const { credential, deviceLogin } = adminCli({ consoleUrl: CONSOLE_URL ?? '', issuer: ISSUER ?? '', homes: state.homes })
const record = (what: string, outcome: string | number) => console.log(`[mcp] ${what} -> ${outcome}`)

// --- A fake upstream that is both an Ollama and a ComfyUI --------------------------------------
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const upstreamSeen: string[] = []
let upstream: Server
let upstreamBase = ''

// --- The client's loopback redirect listener (RFC 8252 §7.3), as a native MCP client runs one --------
// A real listener, not `page.route`: the OP reaches the redirect by a 303, and Playwright hands a
// route handler only the first request of a redirect chain, never the redirected one.
// A holder, not a `let`: assigned only inside the listener, a `let` would narrow to `never` at the reads.
const callback: { url?: URL } = {}
let callbackServer: Server

function loopbackRedirect(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', REDIRECT)
  // Only the redirect itself: the browser also asks this origin for /favicon.ico.
  if (url.pathname !== new URL(REDIRECT).pathname) return res.writeHead(404).end()
  callback.url = url
  res.writeHead(200, { 'content-type': 'text/plain' }).end('done')
}

function fakeUpstream(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://fake')
  upstreamSeen.push(`${req.method} ${url.pathname}`)
  const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (url.pathname === '/api/version') return json({ version: 'fake' })
  if (url.pathname === '/api/tags') return json({ models: [{ name: 'fake-model' }] })
  if (url.pathname === '/api/chat') {
    return json({ model: 'fake-model', message: { role: 'assistant', content: 'Hello from the fake upstream' }, done: true, prompt_eval_count: 3, eval_count: 4 })
  }
  if (url.pathname === '/system_stats') return json({})
  if (url.pathname === '/prompt') return json({ prompt_id: `job-${RUN_ID}` })
  if (url.pathname.startsWith('/history/')) {
    const id = decodeURIComponent(url.pathname.slice('/history/'.length))
    return json({
      [id]: {
        status: { completed: true, messages: [['execution_start', { timestamp: 1000 }], ['execution_success', { timestamp: 1250 }]] },
        outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
      },
    })
  }
  if (url.pathname === '/view') return res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) }).end(PNG)
  res.writeHead(404).end()
}

// --- Admin API, as the operator ---------------------------------------------------------------
async function api(method: string, route: string, body?: unknown, token = credential(state.operator).accessToken) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  expect(res.status, `${method} ${route}: ${text}`).toBeLessThan(300)
  return text ? JSON.parse(text) as Record<string, any> : null
}

async function makePaddock(breed: 'ollama' | 'comfyui', slug: string, constraintJson: unknown) {
  const flock = await api('POST', '/flocks', { name: `e2e-mcp-${breed}-${RUN_ID}`, breed, baseUrl: upstreamBase, tlsTrust: false })
  state.flockIds.push(flock!.id)
  const paddock = await api('POST', '/paddocks', { flockId: flock!.id, name: `MCP ${breed} ${RUN_ID}`, slug })
  await api('PUT', `/paddocks/${paddock!.id}/fence`, { constraintJson, rateLimit: { windowSec: 60, max: 100 } })
  state.paddock[slug] = paddock!.id
}

// --- The MCP client ---------------------------------------------------------------------------
async function discover(slug: string) {
  const res = await fetch(resourceOf(slug), { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': VERSION }, body: '{}' })
  const challenge = res.headers.get('www-authenticate') ?? ''
  record(`no token on ${slug}`, `${res.status} ${challenge}`)
  expect(res.status).toBe(401)
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
  expect(metadataUrl).toBe(`${DATA_PLANE}/.well-known/oauth-protected-resource/p/${slug}/mcp`)
  const metadata = await (await fetch(metadataUrl!)).json() as { resource: string; authorization_servers: string[] }
  expect(metadata).toMatchObject({ resource: resourceOf(slug), authorization_servers: [ISSUER] })
  return await (await fetch(`${metadata.authorization_servers[0]}/.well-known/openid-configuration`)).json() as {
    authorization_endpoint: string; token_endpoint: string
  }
}

/** Authorize in a real browser; returns the redirect the OP sent back (never loaded: it is caught). */
async function authorizeInBrowser(browser: Browser, authorizationEndpoint: string, slug: string, who: { email: string; password: string }, decide: 'approve' | 'refused') {
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(authorizationEndpoint)
  url.search = new URLSearchParams({
    // As real MCP clients ask: no offline_access, no prompt=consent (ruling R4).
    client_id: CLIENT.client_id, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid mcp',
    resource: resourceOf(slug), state: RUN_ID,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString()

  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = watchForViolations(page)
  delete callback.url
  try {
    await page.goto(url.href)
    await page.getByLabel('Email').fill(who.email)
    await page.getByLabel('Password').fill(who.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    if (decide === 'approve') {
      await expect(page.getByRole('heading', { name: 'Connect an app to MetaModels?' })).toBeVisible()
      await expect(page.locator('strong', { hasText: new URL(CLIENT.client_id).host }).first()).toBeVisible()
      await expect(page.getByText(who.email)).toBeVisible()
      await page.getByRole('button', { name: 'Approve' }).click()
    } else {
      await expect(page.getByRole('heading', { name: 'You cannot approve this app' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Close' }).click()
    }
    await expect.poll(() => callback.url !== undefined, { message: 'the OP never redirected back to the client' }).toBe(true)
    // D5: the widened form-action let every form post reach the client's loopback redirect.
    expect(problems).toEqual([])
  } finally {
    await context.close()
  }
  return { back: callback.url!, verifier }
}

async function token(tokenEndpoint: string, fields: Record<string, string>) {
  const res = await fetch(tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT.client_id, ...fields }).toString(),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

const LEGACY_VERSION = '2025-11-25'
const CLIENT_INFO = { name: 'metamodels-e2e', version: '0.0.0' }
type RpcBody = { result?: any; error?: { code: number } } | null

async function post(slug: string, headers: Record<string, string>, body: unknown, bearer: string | null) {
  const res = await fetch(resourceOf(slug), {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...headers, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body: (text ? JSON.parse(text) : null) as RpcBody }
}

let rpcId = 1
/** A modern (2026-07-28) request: `_meta` in the body, and the headers the transport mirrors from it. */
async function mcp(slug: string, method: string, params: Record<string, unknown>, bearer: string | null) {
  return post(slug, {
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    ...(method === 'tools/call' && typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
  }, {
    jsonrpc: '2.0', id: rpcId++, method,
    params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientInfo': CLIENT_INFO, 'io.modelcontextprotocol/clientCapabilities': {} } },
  }, bearer)
}

/** A legacy (2025-11-25) message: no `_meta`; `MCP-Protocol-Version` on everything after `initialize`. */
async function legacyMcp(slug: string, message: { method: string; params?: Record<string, unknown>; notification?: boolean }, bearer: string) {
  const headers: Record<string, string> = message.method === 'initialize' ? {} : { 'mcp-protocol-version': LEGACY_VERSION }
  const body = { jsonrpc: '2.0', ...(message.notification ? {} : { id: rpcId++ }), method: message.method, ...(message.params ? { params: message.params } : {}) }
  return post(slug, headers, body, bearer)
}

async function connect(browser: Browser, slug: string) {
  const as = await discover(slug)
  const { back, verifier } = await authorizeInBrowser(browser, as.authorization_endpoint, slug, { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }, 'approve')
  const code = back.searchParams.get('code')
  expect(code, back.href).toBeTruthy()
  const t = await token(as.token_endpoint, { grant_type: 'authorization_code', code: code!, redirect_uri: REDIRECT, code_verifier: verifier, resource: resourceOf(slug) })
  expect(t.status, JSON.stringify(t.json)).toBe(200)
  // Ruling R4: a refresh token although the request asked for neither offline_access nor prompt=consent.
  expect(typeof t.json.refresh_token, 'an MCP client gets a refresh token').toBe('string')
  state.tokens[slug] = { access: t.json.access_token, refresh: t.json.refresh_token }
  record(`consent + token for ${slug}`, `${t.status} refresh_token=${typeof t.json.refresh_token === 'string'}`)
}

// --- Lifecycle --------------------------------------------------------------------------------
test.beforeAll(async ({ browser }) => {
  upstream = createServer(fakeUpstream)
  callbackServer = createServer(loopbackRedirect)
  const redirect = new URL(REDIRECT)
  await new Promise<void>((resolve) => callbackServer.listen(Number(redirect.port), redirect.hostname, resolve))
  await new Promise<void>((resolve) => upstream.listen(0, '0.0.0.0', resolve))
  upstreamBase = `http://${UPSTREAM_HOST}:${(upstream.address() as AddressInfo).port}`
  state.operator = await deviceLogin(browser, 'read,resource.write', OPERATOR_EMAIL, OPERATOR_PASSWORD)
  await makePaddock('ollama', OLLAMA_SLUG, { allowedRoutes: ['chat', 'read'], allowedModels: ['fake-model'] })
  await makePaddock('comfyui', COMFY_SLUG, {
    templates: [{
      id: 'txt2img',
      graph: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } }, '9': { class_type: 'SaveImage', inputs: {} } },
      params: [{ name: 'prompt', type: 'text', target: { node: '6', input: 'text' } }],
      cost: 1,
    }],
  })
})

test.afterAll(async () => {
  upstream?.close()
  callbackServer?.close()
  try {
    // Deleting a flock cascades to its paddocks, and so to their key scopes. Keys are revoked, never deleted.
    for (const id of state.flockIds) await fetch(`${API}/flocks/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${credential(state.operator).accessToken}` } })
  } catch {
    // Best effort: a cleanup failure must not hide the test failure that left the fixture.
  }
  for (const home of state.homes) rmSync(home, { recursive: true, force: true })
})

// --- The real flow ------------------------------------------------------------------------------
test('Ollama: CIMD discovery, consent, token, then discover, list and a metered chat', async ({ browser }) => {
  await connect(browser, OLLAMA_SLUG)
  const at = state.tokens[OLLAMA_SLUG]!.access

  const discovered = await mcp(OLLAMA_SLUG, 'server/discover', {}, at)
  expect(discovered.body?.result).toMatchObject({
    resultType: 'complete',
    supportedVersions: expect.arrayContaining([VERSION, LEGACY_VERSION]),
    capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'metamodels' } },
    cacheScope: 'private',
  })
  record('modern server/discover', discovered.status)
  const listed = await mcp(OLLAMA_SLUG, 'tools/list', {}, at)
  const names = (listed.body?.result?.tools as Array<{ name: string }>).map((t) => t.name)
  expect(names).toEqual(['chat', 'list_models'])
  record('tools/list (mutate never listed)', names.join(','))

  const chat = await mcp(OLLAMA_SLUG, 'tools/call', { name: 'chat', arguments: { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] } }, at)
  expect(chat.body?.result?.content).toEqual([{ type: 'text', text: 'Hello from the fake upstream' }])
  expect(upstreamSeen).toContain('POST /api/chat')

  // The metered usage_rollup row, under the oauth key (the worker aggregates asynchronously).
  const keys = await api('GET', '/keys?limit=200') as unknown as Array<{ id: string; kind: string; paddockSlugs: string[] }>
  const oauthKey = keys.find((k) => k.kind === 'oauth' && k.paddockSlugs.includes(OLLAMA_SLUG))
  expect(oauthKey, 'the consent minted an oauth key').toBeTruthy()
  const hour = (d: Date) => d.toISOString().slice(0, 13)
  const range = new URLSearchParams({ startBucket: hour(new Date(Date.now() - 3600_000)), endBucket: hour(new Date(Date.now() + 3600_000)), paddockId: state.paddock[OLLAMA_SLUG]! })
  await expect.poll(async () => {
    // One row per key × paddock, its meters pivoted into `dims` (usage-service.ts, UsageMatrixRow).
    const rows = await api('GET', `/usage/matrix?${range}`) as unknown as Array<{ keyId: string; dims: Record<string, number> }>
    return rows.filter((r) => r.keyId === oauthKey!.id)
      .flatMap((r) => Object.entries(r.dims).filter(([, v]) => Number(v) !== 0).map(([dim, v]) => `${dim}=${Number(v)}`))
      .sort().join(' ')
  }, { timeout: 60_000, message: 'no usage_rollup row under the oauth key' }).toBe('tokens_in=3 tokens_out=4')
  record('usage_rollup under the oauth key', 'tokens_in=3 tokens_out=4')
})

test('legacy 2025-11-25 on the same paddock and token: initialize, initialized, tools/list, tools/call', async () => {
  const at = state.tokens[OLLAMA_SLUG]!.access
  const init = await legacyMcp(OLLAMA_SLUG, { method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, at)
  expect(init.body?.result).toMatchObject({
    protocolVersion: LEGACY_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'metamodels', title: `MCP ollama ${RUN_ID}` },
  })
  expect(init.sessionId, 'stateless: no session is minted').toBeNull()
  const initialized = await legacyMcp(OLLAMA_SLUG, { method: 'notifications/initialized', notification: true }, at)
  expect(initialized.status).toBe(202)
  const listed = await legacyMcp(OLLAMA_SLUG, { method: 'tools/list' }, at)
  expect((listed.body?.result?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['chat', 'list_models'])
  expect(listed.body?.result).not.toHaveProperty('resultType')
  const chat = await legacyMcp(OLLAMA_SLUG, { method: 'tools/call', params: { name: 'chat', arguments: { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] } } }, at)
  expect(chat.body?.result?.content).toEqual([{ type: 'text', text: 'Hello from the fake upstream' }])
  record('legacy initialize → initialized → tools/list → tools/call', `${init.status} ${initialized.status} ${listed.status} ${chat.status}`)
})

test('ComfyUI: run a template, then get_job_result returns the image as base64', async ({ browser }) => {
  await connect(browser, COMFY_SLUG)
  const at = state.tokens[COMFY_SLUG]!.access
  const run = await mcp(COMFY_SLUG, 'tools/call', { name: 'run_txt2img', arguments: { prompt: 'a cat' } }, at)
  expect(run.body?.result?.structuredContent).toEqual({ job_id: `job-${RUN_ID}` })
  const result = await mcp(COMFY_SLUG, 'tools/call', { name: 'get_job_result', arguments: { job_id: `job-${RUN_ID}` } }, at)
  expect(result.body?.result?.content).toEqual([
    { type: 'text', text: 'Job finished with 1 image.' },
    { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
  ])
  record('ComfyUI run + get_job_result', 'image/png')
})

// --- The §7 negative cases ----------------------------------------------------------------------
test('refused credentials: another paddock\'s token, an admin-API token, an mm_live_ key, an oauth token on the proxy', async () => {
  const ollamaAt = state.tokens[OLLAMA_SLUG]!.access
  const cases: Array<[string, string, string]> = [
    ['token for another paddock', COMFY_SLUG, ollamaAt],
    ['admin-API token', OLLAMA_SLUG, credential(state.operator).accessToken],
  ]
  const live = await api('POST', '/keys', { name: `e2e-mcp-live-${RUN_ID}`, paddockIds: [state.paddock[OLLAMA_SLUG]] })
  cases.push(['mm_live_ key on /mcp', OLLAMA_SLUG, live!.plaintext as string])
  for (const [what, slug, bearer] of cases) {
    const r = await mcp(slug, 'tools/list', {}, bearer)
    record(what, r.status)
    expect(r.status).toBe(401)
  }
  const proxy = await fetch(`${DATA_PLANE}/p/${OLLAMA_SLUG}/api/chat`, {
    method: 'POST', headers: { authorization: `Bearer ${ollamaAt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  record('oauth token on the proxy', proxy.status)
  expect(proxy.status).toBe(401)
  await api('POST', `/keys/${live!.id}/revoke`)
})

test('the fence still decides: a disallowed model is isError; a mutate route cannot be called', async () => {
  const at = state.tokens[OLLAMA_SLUG]!.access
  const denied = await mcp(OLLAMA_SLUG, 'tools/call', { name: 'chat', arguments: { model: 'other-model', messages: [{ role: 'user', content: 'hi' }] } }, at)
  record('disallowed model via tools/call', JSON.stringify(denied.body?.result))
  // toMatchObject: a modern result also carries resultType and _meta.
  expect(denied.body?.result).toMatchObject({ content: [{ type: 'text', text: 'model not allowed: other-model' }], isError: true })
  const pull = await mcp(OLLAMA_SLUG, 'tools/call', { name: 'pull', arguments: { name: 'x' } }, at)
  record('tools/call pull', pull.body?.error?.code ?? 'none')
  expect(pull.body?.error?.code).toBe(-32602)
})

test('a viewer sees the refusal and only Close, and the client gets access_denied', async ({ browser }) => {
  await ensureRole(browser, VIEWER_EMAIL!, 'viewer')
  const as = await discover(OLLAMA_SLUG)
  const { back } = await authorizeInBrowser(browser, as.authorization_endpoint, OLLAMA_SLUG, { email: VIEWER_EMAIL!, password: VIEWER_PASSWORD! }, 'refused')
  record('viewer consent', back.searchParams.get('error') ?? 'none')
  expect(back.searchParams.get('error')).toBe('access_denied')
})

test('a loopback or RFC 1918 client_id: the metadata document fetch fails, so there is no client', async () => {
  const as = await discover(OLLAMA_SLUG)
  for (const clientId of ['https://127.0.0.1/client.json', 'https://localhost/client.json', 'https://10.0.0.1/client.json', 'https://172.16.0.1/client.json']) {
    const url = new URL(as.authorization_endpoint)
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid mcp', resource: resourceOf(OLLAMA_SLUG), code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' }).toString()
    const res = await fetch(url, { redirect: 'manual' })
    // The OP's error page names why. From inside the auth container nothing answers on these hosts,
    // so this shows no document was served; that the SSRF guard itself cuts a connection that DOES
    // reach a special-use address is apps/auth/test/cimd.test.ts ('a fetch to 127.0.0.1 is refused
    // on connect'), and the RFC 1918 name case its isSpecialUseIP table (spec M4 §10).
    const page = await res.text()
    record(`CIMD client_id ${clientId}`, `${res.status} ${/client_id metadata document fetch failed/.exec(page)?.[0] ?? 'no reason shown'}`)
    expect(res.status).toBe(400)
    expect(page).toContain('client_id metadata document fetch failed')
  }
})

test('a revoked key: 401 at the data plane at once, and invalid_grant on refresh', async () => {
  const as = await discover(OLLAMA_SLUG)
  const keys = await api('GET', '/keys?limit=200') as unknown as Array<{ id: string; kind: string; status: string; paddockSlugs: string[] }>
  const oauthKey = keys.find((k) => k.kind === 'oauth' && k.status === 'active' && k.paddockSlugs.includes(OLLAMA_SLUG))!
  await api('POST', `/keys/${oauthKey.id}/revoke`)
  await expect.poll(async () => (await mcp(OLLAMA_SLUG, 'tools/list', {}, state.tokens[OLLAMA_SLUG]!.access)).status).toBe(401)
  record('revoked key at the data plane', 401)
  const refreshed = await token(as.token_endpoint, { grant_type: 'refresh_token', refresh_token: state.tokens[OLLAMA_SLUG]!.refresh!, resource: resourceOf(OLLAMA_SLUG) })
  record('revoked key, refresh', `${refreshed.status} ${refreshed.json.error}`)
  expect(refreshed.json.error).toBe('invalid_grant')
})
