import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { mcpResource } from '@metamodels/schema'
import { ollamaConstraint, ollamaToMcp } from '@metamodels/connectors'
import { createApp, type AppDeps } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { mcpChallenge } from '../src/mcp/auth.js'
import { MCP_SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/jsonrpc.js'
import { createFakeComfyui, FAKE_PNG, type FakeComfyui } from './helpers/fake-comfyui.js'
import { createFakeOllama } from './helpers/fake-ollama.js'
import { startTestIssuer, type TestIssuer } from './helpers/oauth.js'
import { makeDb, seedFixture, seedOauthKey, TEST_RING, type Fixture, type TestDb } from './helpers/seed.js'

const DP = 'http://dp.test'
const VERSION = '2026-07-28'
const LEGACY = '2025-11-25'
const META = { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} }
const SERVER_INFO = { 'io.modelcontextprotocol/serverInfo': { name: 'metamodels', version: MCP_SERVER_VERSION } }
let op: TestIssuer
let db: TestDb
let fx: Fixture
let oauth: Awaited<ReturnType<typeof seedOauthKey>>
let sink: InMemoryMeterSink
let comfy: FakeComfyui
let upstreamCalls: string[]
let app: ReturnType<typeof createApp>['app']
let drainMeters: () => Promise<void>
let warn: ReturnType<typeof vi.spyOn>

beforeAll(async () => { op = await startTestIssuer() })
afterAll(async () => { await op.close() })
afterEach(() => { warn.mockRestore() })

function build(over: Partial<AppDeps> = {}) {
  const ollama = createFakeOllama()
  const built = createApp({
    configStore: new DrizzleConfigStore(db, TEST_RING),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: sink,
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    fetchImpl: (url, init) => {
      upstreamCalls.push(url)
      return url.startsWith('http://fake.comfyui') ? comfy.request(url, init) : ollama.request(url, init)
    },
    mcp: { dataPlaneUrl: DP, oidcIssuer: op.issuer, verify: op.verifier },
    ...over,
  })
  app = built.app
  drainMeters = built.drainMeters
}

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = await makeDb()
  fx = await seedFixture(db)
  oauth = await seedOauthKey(db, fx)
  sink = new InMemoryMeterSink()
  comfy = createFakeComfyui()
  upstreamCalls = []
  build()
})

const tokenFor = (key: { keyId: string; clientId: string }, slug = 'small') =>
  op.mint({ aud: mcpResource(DP, slug), scope: 'mcp', client_id: key.clientId, mm_kid: key.keyId })

/**
 * One POST to the endpoint. Unless overridden, it carries the modern request headers derived from
 * the body — `MCP-Protocol-Version` from `_meta`, `Mcp-Method`, and `Mcp-Name` for `tools/call` — as a
 * conforming 2026-07-28 client sends them. An override of `null` removes a header.
 */
function post(slug: string, body: unknown, o: { token?: string | null; headers?: Record<string, string | null> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const token = o.token === undefined ? tokenFor(oauth, slug) : o.token
  if (token) headers.authorization = `Bearer ${token}`
  const b = body as { method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } } | null
  const version = b?.params?._meta?.['io.modelcontextprotocol/protocolVersion']
  if (typeof version === 'string') headers['mcp-protocol-version'] = version
  if (typeof b?.method === 'string' && typeof version === 'string') headers['mcp-method'] = b.method
  if (b?.method === 'tools/call' && typeof b.params?.name === 'string') headers['mcp-name'] = b.params.name
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete headers[k]
    else headers[k] = v
  }
  return app.request(`${DP}/p/${slug}/mcp`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

let nextId = 1
type Rpc = { status: number; headers: Headers; body: { result?: any; error?: { code: number; message: string; data?: any } } }
async function send(res: Response): Promise<Rpc> {
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : {} }
}
/** A modern request: `_meta` in the body, the derived headers on the POST. */
async function rpc(method: string, params: Record<string, unknown> = {}, slug = 'small', o: { token?: string | null; headers?: Record<string, string | null> } = {}) {
  return send(await post(slug, { jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META } }, o))
}
/** A legacy request: no `_meta`; the negotiated version in `MCP-Protocol-Version` (none on `initialize`). */
async function legacy(method: string, params?: Record<string, unknown>, slug = 'small', o: { token?: string | null; version?: string | null } = {}) {
  const version = o.version === undefined ? (method === 'initialize' ? null : LEGACY) : o.version
  return send(await post(slug, { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, {
    token: o.token, headers: version === null ? {} : { 'mcp-protocol-version': version },
  }))
}
const call = (name: string, args: unknown, slug = 'small', o: { token?: string | null } = {}) => rpc('tools/call', { name, arguments: args }, slug, o)
const messages = [{ role: 'user', content: 'hi' }]
const fence = ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: ['llama3.2:1b'] })

describe('modern (2026-07-28): results', () => {
  test('server/discover is exactly the DiscoverResult the schema asks for', async () => {
    const { status, body } = await rpc('server/discover')
    expect(status).toBe(200)
    expect(body.result).toEqual({
      resultType: 'complete',
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      _meta: SERVER_INFO,
      ttlMs: 0,
      cacheScope: 'private',
    })
  })

  test('tools/list is the fence\'s toMcp as a cacheable, private ListToolsResult; a cursor is ignored', async () => {
    const { body } = await rpc('tools/list', { cursor: 'x' })
    expect(body.result).toEqual({ resultType: 'complete', tools: ollamaToMcp(fence), ttlMs: 0, cacheScope: 'private', _meta: SERVER_INFO })
  })

  test('tools/call is a CallToolResult with resultType and serverInfo', async () => {
    const { body } = await call('list_models', {})
    expect(body.result).toEqual({
      resultType: 'complete', content: [{ type: 'text', text: 'llama3.2:1b' }], structuredContent: { models: ['llama3.2:1b'] }, _meta: SERVER_INFO,
    })
  })
})

describe('modern (2026-07-28): transport rules', () => {
  test('an unknown method is HTTP 404 + -32601; ping and resources/list are not modern methods here', async () => {
    for (const method of ['resources/list', 'ping']) {
      const r = await rpc(method)
      expect(r.status, method).toBe(404)
      expect(r.body.error?.code, method).toBe(-32601)
    }
  })

  test('a batch is 400 + -32600; an unparseable body 400 + -32700; a notification 202 with no body', async () => {
    const batch = await send(await post('small', [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }]))
    expect([batch.status, batch.body.error?.code]).toEqual([400, -32600])
    const bad = await send(await post('small', '{not json'))
    expect([bad.status, bad.body.error?.code]).toEqual([400, -32700])
    const note = await post('small', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
  })

  test('Origin: absent or our own is served; any other is 403 and never reaches the token check', async () => {
    expect((await rpc('tools/list')).status).toBe(200)
    expect((await rpc('tools/list', {}, 'small', { headers: { origin: DP } })).status).toBe(200)
    const foreign = await rpc('tools/list', {}, 'small', { token: null, headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
    expect(foreign.body.error?.code).toBe(-32600)
    expect(foreign.body).not.toHaveProperty('id')
  })

  test('missing or mismatched MCP-Protocol-Version, Mcp-Method or Mcp-Name is 400 + -32020', async () => {
    const cases: Array<[string, Record<string, string | null>]> = [
      ['no MCP-Protocol-Version', { 'mcp-protocol-version': null }],
      ['MCP-Protocol-Version differs from _meta', { 'mcp-protocol-version': '2025-11-25' }],
      ['no Mcp-Method', { 'mcp-method': null }],
      ['Mcp-Method differs from the body', { 'mcp-method': 'tools/list' }],
      ['no Mcp-Name on tools/call', { 'mcp-name': null }],
      ['Mcp-Name differs from params.name', { 'mcp-name': 'chat' }],
    ]
    for (const [what, headers] of cases) {
      const r = await rpc('tools/call', { name: 'list_models', arguments: {} }, 'small', { headers })
      expect([r.status, r.body.error?.code], what).toEqual([400, -32020])
    }
    expect(upstreamCalls).toEqual([])
  })

  test('an Mcp-Name in the Base64 sentinel is decoded before it is compared', async () => {
    const sentinel = `=?base64?${Buffer.from('list_models').toString('base64')}?=`
    const r = await rpc('tools/call', { name: 'list_models', arguments: {} }, 'small', { headers: { 'mcp-name': sentinel } })
    expect(r.status).toBe(200)
    expect(r.body.result.isError).toBeUndefined()
  })

  test('an unsupported version is 400 + -32022 naming the supported versions and the requested one', async () => {
    const r = await send(await post('small', {
      jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
    }))
    expect(r.status).toBe(400)
    expect(r.body.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: '1900-01-01' } })
  })

  test('Mcp-Session-Id and Last-Event-ID are ignored, and no session id is ever minted', async () => {
    const r = await rpc('tools/list', {}, 'small', { headers: { 'mcp-session-id': 'abc', 'last-event-id': '42' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('mcp-session-id')).toBeNull()
  })

  test('GET and DELETE are 405, allowing POST', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request(`${DP}/p/small/mcp`, { method, headers: { authorization: `Bearer ${tokenFor(oauth)}` } })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })

  test('the proxy catch-all never sees /mcp, even with MCP not configured', async () => {
    build({ mcp: undefined })
    const res = await app.request(`${DP}/p/small/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(404)
    expect(upstreamCalls).toEqual([])
  })
})

describe('legacy (2025-11-25, 2025-06-18), stateless (D9)', () => {
  test('initialize echoes a supported legacy version, and mints no session', async () => {
    const r = await legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(r.status).toBe(200)
    expect(r.body.result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'metamodels', title: 'Small models', version: MCP_SERVER_VERSION },
    })
    expect(r.headers.get('mcp-session-id')).toBeNull()
  })

  test('initialize with a version this server does not speak answers the newest legacy version', async () => {
    const r = await legacy('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(r.body.result.protocolVersion).toBe('2025-11-25')
  })

  test('notifications/initialized is 202 with no body; ping is {}', async () => {
    const note = await post('small', { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'mcp-protocol-version': LEGACY } })
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
    expect((await legacy('ping')).body.result).toEqual({})
  })

  test('tools/list and tools/call reuse the handlers, in legacy result shapes', async () => {
    expect((await legacy('tools/list')).body.result).toEqual({ tools: ollamaToMcp(fence) })
    const chat = await legacy('tools/call', { name: 'chat', arguments: { model: 'llama3.2:1b', messages } }, 'small', { version: '2025-06-18' })
    expect(chat.body.result).toMatchObject({ content: [{ type: 'text', text: 'Hello' }] })
    expect(chat.body.result).not.toHaveProperty('resultType')
    expect(chat.body.result).not.toHaveProperty('_meta')
    await drainMeters()
    expect(Object.fromEntries(sink.events.map((e) => [e.dim, e.value]))).toEqual({ tokens_in: 11, tokens_out: 22 })
    expect(sink.events[0]).toMatchObject({ keyId: oauth.keyId, paddockId: fx.paddockId })
  })

  test('an unknown legacy method is -32601; an unknown tool is -32602', async () => {
    expect((await legacy('server/discover')).body.error?.code).toBe(-32601)
    expect((await legacy('tools/call', { name: 'pull', arguments: {} })).body.error?.code).toBe(-32602)
  })

  test('a legacy request without MCP-Protocol-Version is refused 400 + -32020 (it cannot be told from a malformed modern one)', async () => {
    const r = await legacy('tools/list', undefined, 'small', { version: null })
    expect([r.status, r.body.error?.code]).toEqual([400, -32020])
  })

  test('the same OAuth rules: no token 401 with resource_metadata; an mm_live_ key 401; a foreign Origin 403', async () => {
    const none = await legacy('initialize', { protocolVersion: LEGACY }, 'small', { token: null })
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe(mcpChallenge('small', DP))
    expect((await legacy('tools/list', undefined, 'small', { token: fx.keyPlaintext })).status).toBe(401)
    const foreign = await post('small', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } }, { headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
  })

  test('the rate limit is one budget across both eras (fence max 5/60s)', async () => {
    for (let i = 0; i < 3; i++) expect((await call('list_models', {})).body.result.isError).toBeUndefined()
    for (let i = 0; i < 2; i++) expect((await legacy('tools/call', { name: 'list_models', arguments: {} })).body.result.isError).toBeUndefined()
    expect((await legacy('tools/call', { name: 'list_models', arguments: {} })).body.result)
      .toEqual({ content: [{ type: 'text', text: 'rate limit exceeded' }], isError: true })
  })
})

describe('POST /p/:slug/mcp — authentication (M4 §4.2, §7)', () => {
  test('no token: 401 with resource_metadata', async () => {
    const res = await post('small', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }, { token: null })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(mcpChallenge('small', DP))
  })

  test('an mm_live_ key, another paddock\'s token and an admin-API token are 401', async () => {
    for (const token of [fx.keyPlaintext, tokenFor(oauth, 'other'), op.mint({ aud: 'http://console.test/api/admin', scope: 'read', client_id: 'x' })]) {
      expect((await rpc('tools/list', {}, 'small', { token })).status).toBe(401)
    }
  })

  test('an oauth token on the proxy is 401', async () => {
    const res = await app.request(`${DP}/p/small/api/chat`, {
      method: 'POST', headers: { authorization: `Bearer ${tokenFor(oauth)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:1b', messages }),
    })
    expect(res.status).toBe(401)
    expect(upstreamCalls).toEqual([])
  })

  test('a revoked key is 401 on its next request; a disabled paddock is 404', async () => {
    await db.update(schema.apiKey).set({ status: 'revoked' }).where(eq(schema.apiKey.id, oauth.keyId))
    expect((await rpc('tools/list')).status).toBe(401)
    await db.update(schema.apiKey).set({ status: 'active' }).where(eq(schema.apiKey.id, oauth.keyId))
    await db.update(schema.paddock).set({ status: 'disabled' }).where(eq(schema.paddock.id, fx.paddockId))
    expect((await rpc('tools/list')).status).toBe(404)
  })
})

describe('tools/call on an Ollama paddock (M4 §3.8)', () => {
  test('chat runs through the proxy pipeline and is metered under the oauth key', async () => {
    const { body } = await call('chat', { model: 'llama3.2:1b', messages })
    expect(body.result).toMatchObject({ resultType: 'complete', content: [{ type: 'text', text: 'Hello' }] })
    expect(body.result.isError).toBeUndefined()
    await drainMeters()
    expect(Object.fromEntries(sink.events.map((e) => [e.dim, e.value]))).toEqual({ tokens_in: 11, tokens_out: 22 })
    expect(sink.events[0]).toMatchObject({ keyId: oauth.keyId, paddockId: fx.paddockId, breedId: 'ollama' })
  })

  test('a disallowed model is isError with the fence\'s reason, and never reaches upstream', async () => {
    const { status, body } = await call('chat', { model: 'llama3:70b', messages })
    expect(status).toBe(200)
    expect(body.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: 'model not allowed: llama3:70b' }], isError: true, _meta: SERVER_INFO })
    expect(upstreamCalls).toEqual([])
  })

  test('list_models, embed and generate', async () => {
    expect((await call('list_models', {})).body.result.structuredContent).toEqual({ models: ['llama3.2:1b'] })
    expect((await call('embed', { model: 'llama3.2:1b', input: ['a'] })).body.result.structuredContent).toEqual({ embeddings: [[0.1, 0.2]] })
    expect((await call('generate', { model: 'llama3.2:1b', prompt: 'p' })).body.result.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  test('an unknown tool, or a mutate route by name, is -32602', async () => {
    const pull = await call('pull', { name: 'x' })
    expect([pull.status, pull.body.error?.code]).toEqual([200, -32602])
  })

  test('tools/call is rate-limited like the proxy (fence max 5/60s); tools/list is not', async () => {
    for (let i = 0; i < 10; i++) expect((await rpc('tools/list')).status).toBe(200)
    for (let i = 0; i < 5; i++) expect((await call('list_models', {})).body.result.isError).toBeUndefined()
    expect((await call('list_models', {})).body.result).toMatchObject({ content: [{ type: 'text', text: 'rate limit exceeded' }], isError: true })
  })

  test('an unreachable upstream is isError, and the JSON-RPC call still succeeds', async () => {
    build({ fetchImpl: async () => { throw new TypeError('fetch failed') } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status, body } = await call('list_models', {})
    err.mockRestore()
    expect(status).toBe(200)
    expect(body.result).toMatchObject({ content: [{ type: 'text', text: 'the upstream could not be reached' }], isError: true })
  })
})

describe('tools/call on a ComfyUI paddock (M4 §3.8)', () => {
  const txt2img = {
    id: 'txt2img',
    graph: {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
      '3': { class_type: 'KSampler', inputs: { seed: 0 } },
    },
    params: [
      { name: 'prompt', type: 'text', target: { node: '6', input: 'text' } },
      { name: 'seed', type: 'seed', targets: [{ node: '3', input: 'seed' }] },
    ],
    cost: 3,
  }
  let cf: Awaited<ReturnType<typeof seedOauthKey>>

  beforeEach(async () => {
    const [flock] = await db.insert(schema.flock).values({ orgId: fx.orgId, breed: 'comfyui', name: 'gpu', baseUrl: 'http://fake.comfyui' }).returning()
    const [paddock] = await db.insert(schema.paddock).values({ orgId: fx.orgId, flockId: flock!.id, slug: 'cf', name: 'Images' }).returning()
    await db.insert(schema.fence).values({ orgId: fx.orgId, paddockId: paddock!.id, constraintJson: { templates: [txt2img] }, rateLimit: { windowSec: 60, max: 100 }, quota: null })
    cf = await seedOauthKey(db, fx, { paddockId: paddock!.id })
  })
  const cfCall = (name: string, args: unknown, key = cf) => call(name, args, 'cf', { token: tokenFor(key, 'cf') })

  test('run, then get_job_result: pending, then the images as base64 image content, metered once', async () => {
    const run = await cfCall('run_txt2img', { prompt: 'a cat' })
    expect(run.body.result.structuredContent).toEqual({ job_id: 'cf-1' })
    expect((await cfCall('get_job_result', { job_id: 'cf-1' })).body.result.content)
      .toEqual([{ type: 'text', text: 'Job still running. Call again later.' }])

    comfy.complete('cf-1')
    const done = await cfCall('get_job_result', { job_id: 'cf-1' })
    const png = Buffer.from(FAKE_PNG).toString('base64')
    expect(done.body.result.content).toEqual([
      { type: 'text', text: 'Job finished with 2 images.' },
      { type: 'image', data: png, mimeType: 'image/png' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ])
    await cfCall('get_job_result', { job_id: 'cf-1' })
    await drainMeters()
    const dims = sink.events.filter((e) => e.keyId === cf.keyId).map((e) => [e.dim, e.value])
    expect(dims).toEqual([['jobs', 3], ['images', 2], ['gpu_ms', 500]])
  })

  test('another grant\'s key cannot see the job', async () => {
    await cfCall('run_txt2img', { prompt: 'a cat' })
    const [p] = await db.select().from(schema.paddock).where(eq(schema.paddock.slug, 'cf'))
    const other = await seedOauthKey(db, fx, { paddockId: p!.id, clientId: 'https://other.example/client.json' })
    expect((await cfCall('get_job_result', { job_id: 'cf-1' }, other)).body.result).toMatchObject({ content: [{ type: 'text', text: 'not found' }], isError: true })
  })

  test('images over the per-result cap are isError naming the cap', async () => {
    build({ mcp: { dataPlaneUrl: DP, oidcIssuer: op.issuer, verify: op.verifier, maxImageBytes: 10 } })
    await cfCall('run_txt2img', { prompt: 'a cat' })
    comfy.complete('cf-1')
    const r = (await cfCall('get_job_result', { job_id: 'cf-1' })).body.result
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('10-byte limit')
  })

  test('an undeclared parameter is refused by reconstructGraph, as isError', async () => {
    const r = (await cfCall('run_txt2img', { prompt: 'a', graph: {} })).body.result
    expect(r.isError).toBe(true)
    expect(upstreamCalls.filter((u) => u.endsWith('/prompt'))).toEqual([])
  })
})
