import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { mcpResource } from '@metamodels/schema'
import { createApp, MAX_REQUEST_BODY_BYTES, type AppDeps } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { createFakeOllama } from './helpers/fake-ollama.js'
import { startTestIssuer, type TestIssuer } from './helpers/oauth.js'
import { makeDb, seedFixture, seedOauthKey, TEST_RING, type Fixture, type TestDb } from './helpers/seed.js'

const DP = 'http://dp.test'
const LIMIT = 1024
let op: TestIssuer
let db: TestDb
let fx: Fixture
let oauth: Awaited<ReturnType<typeof seedOauthKey>>
let upstreamCalls: string[]

beforeAll(async () => { op = await startTestIssuer() })
afterAll(async () => { await op.close() })
beforeEach(async () => {
  db = await makeDb()
  fx = await seedFixture(db)
  oauth = await seedOauthKey(db, fx)
  upstreamCalls = []
})

function appWith(over: Partial<AppDeps> = {}) {
  const ollama = createFakeOllama()
  return createApp({
    configStore: new DrizzleConfigStore(db, TEST_RING),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    fetchImpl: (url, init) => { upstreamCalls.push(url); return ollama.request(url, init) },
    mcp: { dataPlaneUrl: DP, oidcIssuer: op.issuer, verify: op.verifier },
    ...over,
  }).app
}

const chatBody = (content: string) => JSON.stringify({ model: 'llama3.2:1b', messages: [{ role: 'user', content }] })
/** A chat body of exactly `bytes` bytes (ASCII, so characters are bytes). */
const chatBodyOf = (bytes: number) => chatBody('x'.repeat(bytes - chatBody('').length))
const proxyChat = (app: ReturnType<typeof appWith>, body: string, headers: Record<string, string> = {}) =>
  app.request(`${DP}/p/small/api/chat`, {
    method: 'POST', body, headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json', ...headers },
  })

/**
 * `text` as a chunked body: no Content-Length, delivered 64 bytes per pull, counting the bytes the
 * server actually pulled from the client.
 */
function streamOf(text: string) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (offset >= bytes.length) return ctl.close()
      ctl.enqueue(bytes.slice(offset, offset + 64))
      offset += 64
    },
  }, { highWaterMark: 0 })
  return { stream, pulled: () => Math.min(offset, bytes.length) }
}
const streamed = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  ({ method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json', ...headers } }) as RequestInit

describe('request body limit on /p/* (follow-up ruling F2)', () => {
  test('the default is 32 MiB, above a worst-case 2048×2048 RGBA PNG as base64 (21.34 MiB)', () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(32 * 1024 * 1024)
    const png = 2048 * (2048 * 4 + 1)
    expect(4 * Math.ceil(png / 3)).toBeLessThan(MAX_REQUEST_BODY_BYTES)
  })

  test('the proxy passes a body at the limit and refuses one byte more with 413, never calling upstream', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    expect((await proxyChat(app, chatBodyOf(LIMIT))).status).toBe(200)
    upstreamCalls = []
    const over = await proxyChat(app, chatBodyOf(LIMIT + 1))
    expect(over.status).toBe(413)
    expect(await over.json()).toEqual({ error: 'request body too large' })
    expect(upstreamCalls).toEqual([])
  })

  test('a declared Content-Length over the limit is 413 before authentication, the body unread', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    const res = await app.request(`${DP}/p/small/api/chat`, {
      method: 'POST', body: chatBody('hi'), headers: { 'content-type': 'application/json', 'content-length': String(LIMIT + 1) },
    })
    expect(res.status).toBe(413)
  })

  test('MCP has the same limit: a declared Content-Length is judged before the token, a read body after it', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(LIMIT) } })
    const res = await app.request(`${DP}/p/small/mcp`, {
      method: 'POST', body: rpc, headers: { 'content-type': 'application/json', 'content-length': String(rpc.length) },
    })
    expect(res.status).toBe(413)
    const token = op.mint({ aud: mcpResource(DP, 'small'), scope: 'mcp', client_id: oauth.clientId, mm_kid: oauth.keyId })
    const authed = await app.request(`${DP}/p/small/mcp`, {
      method: 'POST', body: rpc, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    })
    expect(authed.status).toBe(413)
  })

  test('a streamed oversize body with no credential is 401: authentication runs before the body is read', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    const src = streamOf(chatBodyOf(LIMIT * 8))
    const res = await app.request(`${DP}/p/small/api/chat`, streamed(src.stream))
    expect(res.status).toBe(401)
    expect(src.pulled()).toBeLessThan(LIMIT)
    expect(upstreamCalls).toEqual([])
  })

  test('a streamed oversize body with a valid key is 413 on the proxy, never calling upstream', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    const src = streamOf(chatBodyOf(LIMIT * 8))
    const res = await app.request(`${DP}/p/small/api/chat`, streamed(src.stream, { authorization: `Bearer ${fx.keyPlaintext}` }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'request body too large' })
    expect(src.pulled()).toBeLessThan(LIMIT * 8)
    expect(upstreamCalls).toEqual([])
  })

  test('a streamed oversize body with a valid token is 413 on MCP, not a JSON-RPC parse error', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(LIMIT * 8) } })
    const token = op.mint({ aud: mcpResource(DP, 'small'), scope: 'mcp', client_id: oauth.clientId, mm_kid: oauth.keyId })
    const res = await app.request(`${DP}/p/small/mcp`, streamed(streamOf(rpc).stream, { authorization: `Bearer ${token}` }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'request body too large' })
  })

  test('a streamed body at exactly the limit passes', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    const res = await app.request(`${DP}/p/small/api/chat`, streamed(streamOf(chatBodyOf(LIMIT)).stream, { authorization: `Bearer ${fx.keyPlaintext}` }))
    expect(res.status).toBe(200)
    expect(upstreamCalls.length).toBe(1)
  })

  test('at the default limit, a 17 MiB chat still goes through', async () => {
    const res = await proxyChat(appWith(), chatBodyOf(17 * 1024 * 1024))
    expect(res.status).toBe(200)
  })
})
