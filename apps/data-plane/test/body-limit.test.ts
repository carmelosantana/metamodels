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

  test('MCP has the same limit, checked before the token', async () => {
    const app = appWith({ maxRequestBodyBytes: LIMIT })
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(LIMIT) } })
    const res = await app.request(`${DP}/p/small/mcp`, { method: 'POST', body: rpc, headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(413)
    const token = op.mint({ aud: mcpResource(DP, 'small'), scope: 'mcp', client_id: oauth.clientId, mm_kid: oauth.keyId })
    const authed = await app.request(`${DP}/p/small/mcp`, {
      method: 'POST', body: rpc, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    })
    expect(authed.status).toBe(413)
  })

  test('at the default limit, a 17 MiB chat still goes through', async () => {
    const res = await proxyChat(appWith(), chatBodyOf(17 * 1024 * 1024))
    expect(res.status).toBe(200)
  })
})
