# M4 follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. **Every subagent is Opus: implementer/fixer = Opus; task reviewer and whole-branch reviewer = Opus. Never Haiku, never Sonnet, never Fable. Pass `model: "opus"` explicitly on every dispatch.** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ten follow-ups found after M4 merged: the data plane stops proxying `/p/<slug>/mcp/`, limits request bodies, names the `mcp` scope in its 401 challenge and charges no budget for a `tools/call` it cannot plan; Ollama's `chat` forwards only `role` and `content`; the control plane's consent routes fail closed when Redis is down; the auth service keeps its page when a CSP lookup fails and gives a vanished paddock its own refusal; the key lookups refuse an expired key in their one query (Kanboard #4558); the console build stops fetching Google Fonts; and the test suites gain the missing gate coverage and stop printing expected failures to stderr.

**Architecture:** Every change is local to the file that owns the behaviour, with no new modules beyond two test helpers and two test files. The data plane gets one Hono `bodyLimit` middleware on `/p/*` (Hono's own, already in the lockfile) and one reserved route before the proxy catch-all. `callTool` swaps two blocks so planning precedes the gates. The replay guard gets fail-fast ioredis options, and its one caller turns a rejection into a 503. `cimdCspMiddleware` moves its lookups into a helper wrapped in `try`. `mcpConsent` returns a three-way result instead of `null`. The config store's key lookups gain one `WHERE` clause. The console's two fonts are vendored from google/fonts at a pinned commit and loaded with `next/font/local`.

**Tech Stack:** TypeScript (ESM), pnpm workspace, Node 24, Hono 4.12 (`hono/body-limit`), `oidc-provider@~9.12.2`, Next.js 16.3.5 (Route Handlers, `next/font/local`), drizzle-orm (PGlite in tests), ioredis 5.4.2, vitest 2.1, Playwright.

**Base:** `release/0.6.0` at `a57acd3`, whose tree is identical to `main` at `ae4ac8a` (0.6.0). Every file:line in this plan was re-checked against that tree. None of the cited source files changed after `3f75dd0`, where the measurements quoted below were first taken.

**Spec:** [`docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md`](../specs/2026-09-29-m4-mcp-endpoint-design.md). Read §3.5, §3.6, §3.8, §4 and §10 before starting. Every task that changes spec behaviour amends the spec in its own commit and appends a row to §10; the rulings are collected at the end under **Rulings (2026-09-30)**. The M4 plan, [`2026-09-29-m4-mcp-endpoint.md`](2026-09-29-m4-mcp-endpoint.md), is the house style and the source of the throwaway-stack commands in Task 10.

## Global Constraints

- **Node ≥ 24, pnpm workspace, TypeScript.** Before any command: `export PATH=/home/carmelo/.nvm/versions/node/v24.18.0/bin:$PATH`.
- **Zero new npm packages.** The `/p/*` body limit is our own lazy middleware (`apps/data-plane/src/body-limit.ts`, no package), and `next/font/local` ships inside `next@16.3.5`, already in the lockfile; no `package.json` changes, so no supply-chain run is needed. Vendored binaries (Task 9's fonts) come only from a pinned upstream commit, and are committed with their SHA-256 sums and licence.
- **Every mutation keeps its audit entry and org scoping and goes through the control-plane services** (`keys-service`, `users-service`). Nothing in this plan adds a write.
- **`mutate`-class routes are permanently unexposable:** never listed as tools, never planned by `mcpCall`, refused by `guard()`.
- **`/p/<slug>/mcp` accepts only OP-issued access tokens; `mm_live_` keys never open MCP; OAuth tokens never open the proxy.**
- **No hardcoded personal LAN IP** anywhere in shipped code, tests or docs. Every URL is configuration.
- **Test lanes that must stay green after every task:** root `pnpm test`, and the control-plane lane `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000`. Type-checking means `pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b`.
- **Production logging stays.** Tests silence an expected log line with a spy that also asserts the line; no `console.*` call is removed from `src/`.
- **Docker verification only on a throwaway compose project** with explicit `-p mm-verify` and non-default host ports, checked free with `ss -ltnp` first. Never touch compose project `metamodels` (ports 3200/8787/3100) or its data. `down -v` only ever with `-p mm-verify`.
- **Commits** are authored `Carmelo Santana <me@carmelosantana.com>` (check `git config user.email` once before the first commit), conventional-commit subjects, **no attribution or co-author lines**. Stay on `claude/m4-followups`; `main` needs linear history, so the branch lands by PR.
- **SDD uses Opus only**, for implementers, fixers and reviewers alike.

## File map

| File | Responsibility |
|---|---|
| `apps/auth/test/helpers/quiet.ts`, `apps/data-plane/test/helpers/quiet.ts` | Silence one console method for one test, and return the spy so the test asserts the line |
| `apps/data-plane/src/app.ts` | `MAX_REQUEST_BODY_BYTES`, `AppDeps.maxRequestBodyBytes`, the `/p/*` body limit |
| `apps/data-plane/src/mcp/endpoint.ts` | The reserved `/p/:slug/mcp/*` route; `callTool` plans before it spends budget |
| `apps/data-plane/src/mcp/auth.ts` | `mcpChallenge` names `scope="mcp"` |
| `apps/data-plane/test/body-limit.test.ts`, `apps/data-plane/test/pipeline.test.ts` | The body limit; `Pipeline.paddockScope`'s gates in isolation |
| `packages/connectors/src/ollama/mcp.ts` | `chatMessages`; `embed` input must be strings |
| `apps/control-plane/src/server/replay-guard.ts`, `internal-route.ts` | `REPLAY_REDIS_OPTIONS`; a guard failure is a 503 |
| `apps/auth/src/cimd-csp.ts` | Lookups in `cimdRedirectOrigin`, failures fall back to the static policy |
| `apps/auth/src/interactions.ts` | `mcpConsent` answers `not-mcp`, `no-paddock` or `consent` |
| `apps/data-plane/src/config/config-store.ts` | `usable(now)`: the key lookups refuse revoked and expired keys in their one query |
| `apps/control-plane/src/app/layout.tsx`, `apps/control-plane/src/app/fonts/*` | IBM Plex, vendored and loaded with `next/font/local`; `SHA256SUMS`, `OFL.txt`, `SOURCES.md` |
| `apps/e2e/specs/mcp.spec.ts` | Asserts `scope="mcp"` in the live challenge |
| `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` | §3.5, §3.6, §3.8, §4.1, §4.2, §4.3, §9 and §10 amendments |

---

### Task 1: Silence the expected-failure logs in the auth and data-plane tests

Follow-up item 6. Nine tests provoke a failure whose log line is the production behaviour they keep, and print it to the run's stderr. Measured on `3f75dd0` with `pnpm exec vitest run apps/auth apps/data-plane`: nine `stderr |` blocks, from `apps/data-plane/src/config/config-store.ts:78` (three tests), `apps/data-plane/src/mcp/auth.ts:34`, `apps/auth/src/interactions.ts:313`, `apps/auth/src/cimd.ts:116` and `apps/auth/src/server.ts:21` (two tests). Each test gets a spy that also asserts the line, so the logging is proven, not deleted. Landing this first means every later task can hold the count at zero.

The two `stdout |` lines from `apps/auth/src/server.ts:37` (`metamodels auth listening on :0`) are stdout, not stderr, and are left alone.

**Files:**
- Create: `apps/auth/test/helpers/quiet.ts`, `apps/data-plane/test/helpers/quiet.ts`
- Modify: `apps/data-plane/test/config-store.test.ts:60-84`, `apps/data-plane/test/app.integration.test.ts:188-194`, `apps/data-plane/test/mcp-auth.test.ts:80-88`
- Modify: `apps/auth/test/mcp-consent.test.ts:249-256`, `apps/auth/test/cimd-fixture-env.test.ts:29-34`, `apps/auth/test/server.test.ts:30-52`

**Interfaces:**
- Produces: `quiet(method: 'warn' | 'error'): MockInstance` in each app's `test/helpers/quiet.ts`. The spy is restored by `onTestFinished`. Task 7 uses it; every later task keeps the count at zero.

- [ ] **Step 1: Count the noise (the failing check)**

Run: `pnpm exec vitest run apps/auth apps/data-plane 2>&1 | grep -c '^stderr |'`
Expected: `9`.

- [ ] **Step 2: Create the helper, twice**

Create `apps/data-plane/test/helpers/quiet.ts` and `apps/auth/test/helpers/quiet.ts`, identical:

```ts
import { onTestFinished, vi } from 'vitest'

/**
 * Swallow one console method for the rest of the current test, and hand back its spy so the test can
 * assert what was logged. For tests that provoke a failure whose log line is the production behaviour
 * being kept: the line is proven, not printed to the run's stderr.
 */
export function quiet(method: 'warn' | 'error') {
  const spy = vi.spyOn(console, method).mockImplementation(() => {})
  onTestFinished(() => spy.mockRestore())
  return spy
}
```

- [ ] **Step 3: The data-plane tests**

`apps/data-plane/test/config-store.test.ts`: add `import { quiet } from './helpers/quiet.js'` above the `./helpers/seed.js` import. In `'one it cannot open resolves the paddock with the reason and NO credential, rather than throwing'`, make the first line `const err = quiet('error')`, and after `expect(JSON.stringify(p)).not.toContain('sealed:v1:')` add:

```ts
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[config\] flock .+: cannot open sealed value: sealed under key .+, which this keyring does not hold$/))
```

In `'an envelope copied onto another flock\'s row will not open there — it resolves as tampered'`, make the first line `const err = quiet('error')`, and after `expect(p!.flock.upstreamAuth).toBeNull()` add:

```ts
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[config\] flock .+: cannot open sealed value: envelope under key .+ failed authentication for this flock$/))
```

`apps/data-plane/test/app.integration.test.ts`: add `import { quiet } from './helpers/quiet.js'` above the `./helpers/seed.js` import. In `'fails closed with a 503 when the credential cannot be opened, and never calls upstream'`, make the first line `const err = quiet('error')`, and after `expect(seen).toEqual([])` add:

```ts
    expect(err).toHaveBeenCalledWith(expect.stringContaining('cannot open sealed value'))
```

`apps/data-plane/test/mcp-auth.test.ts`: add `import { quiet } from './helpers/quiet.js'` after the `./helpers/oauth.js` import. In `'a key set that cannot be fetched is 503 with Retry-After: 30, not 401'`, make the first line `const err = quiet('error')`, and after `expect(out.res.headers.get('retry-after')).toBe('30')` add:

```ts
    expect(err).toHaveBeenCalledWith('[auth] 503 on /mcp, key set unavailable: the key set endpoint could not be reached')
```

- [ ] **Step 4: The auth tests**

`apps/auth/test/mcp-consent.test.ts`: add `import { quiet } from './helpers/quiet.js'` after the `./helpers/flow.js` import. In `'a mint that fails ends with server_error and no grant, so no grant exists without a key'`, make the first line `const err = quiet('error')`, and after `expect(await op!.db.select().from(schema.apiKey)).toEqual([])` add:

```ts
    expect(err).toHaveBeenCalledWith('[auth] recording an MCP approval failed: control plane down')
```

`apps/auth/test/cimd-fixture-env.test.ts`: add `import { quiet } from './helpers/quiet.js'` after the `./helpers/flow.js` import. In `'serves each listed document by its client_id'`, make the first line `const warn = quiet('warn')`, and after the `toMatchObject({ client_id: CIMD_CLIENT_ID })` line add:

```ts
    expect(warn).toHaveBeenCalledWith('[auth] E2E_CIMD_DOCUMENTS: serving 1 fixture client document(s). Test stacks only.')
```

`apps/auth/test/server.test.ts`: add `import { quiet } from './helpers/quiet.js'` after the `./helpers/db.js` import, and above the first `test(` add:

```ts
const EPHEMERAL_KEY_WARNING = '[auth] OIDC_ALLOW_EPHEMERAL_KEY: signing with a throwaway key — every token dies on restart. Development only.'
```

In both tests (`'serves the provider on the configured port and shuts down cleanly'` and `'sweeps expired rows at startup, not only after the first hourly interval'`), make the first line `const warn = quiet('warn')`, and immediately before `await close(server)` add:

```ts
  expect(warn).toHaveBeenCalledWith(EPHEMERAL_KEY_WARNING)
```

- [ ] **Step 5: Count again, and run the lanes**

Run: `pnpm exec vitest run apps/auth apps/data-plane 2>&1 | tee /tmp/quiet.log | grep -c '^stderr |'; grep -E 'Test Files|Tests  ' /tmp/quiet.log`
Expected: `0`; every file passes (`43 passed | 1 skipped`, `383 passed | 1 skipped` tests, as at `3f75dd0`: this task adds no tests), `0 failed`.

- [ ] **Step 6: Commit**

```bash
git add apps/auth/test apps/data-plane/test
git commit -m "test: assert and silence the expected-failure logs in the auth and data-plane suites"
```

---

### Task 2: The data plane reserves `/mcp/` and limits request bodies

Follow-up items 1 and 2. Rulings F1 and F2.

**F1, verified:** `app.all('/p/:slug/*')` (`apps/data-plane/src/app.ts:97`) matches `/p/small/mcp/`, and nothing before it does: `registerMcpRoutes` (`app.ts:85`) registers only `/p/:slug/mcp` (`endpoint.ts:60`, `:102`). A probe against Hono 4.12.32 routed `POST /p/s/mcp/` to the catch-all, and a `GET` with a live key reached `guard()` and came back 403. The ruling is 404 for every method on `/p/:slug/mcp/` and on every path beneath it: the MCP resource is compared exactly (`aud = mcpResource(DATA_PLANE_URL, slug)`), so no token can name `/mcp/`. Answering it "the same way" would open an endpoint no client can authorize for, and the MCP authorization spec says to use the form without a trailing slash.

**F2, measured:** neither route limits the body. The proxy buffers it (`app.ts:114-118`), and MCP buffers it too (`endpoint.ts:77`). The largest legitimate body is a ComfyUI template submit carrying a base64 `image` parameter (`packages/connectors/src/comfyui/breed.ts:163-175`, decoded at `:88`). MCP's `run_<tpl>` plans the same `/submit` request (`packages/connectors/src/comfyui/mcp.ts:130`), and Ollama chat can also carry base64 `images` through the proxy. Worst case, an incompressible PNG is `h·(w·c+1)` bytes and base64 is `4·⌈n/3⌉`:

| Image | PNG | base64 |
|---|---|---|
| 1024² RGB | 3.00 MiB | 4.00 MiB |
| 1024² RGBA | 4.00 MiB | 5.33 MiB |
| 2048² RGB | 12.00 MiB | 16.00 MiB |
| 2048² RGBA | 16.00 MiB | 21.34 MiB |
| 4096² RGB | 48.00 MiB | 64.01 MiB |

**Ruling F2: 32 MiB for every `/p/*` body, MCP included.** It carries the worst-case 2048² RGBA input with 1.5× headroom. A 4096² input is an upscaler's job, not an input parameter. MCP gets the same limit because D8 makes `run_<tpl>` the same request as `/submit`: a smaller MCP limit would make a template runnable over REST and not over MCP. An oversized body is refused with 413 `{ error: 'request body too large' }` before authentication, from a declared `Content-Length` unread, or as a chunked body streams. That reveals nothing (it answers the caller's own request shape) and it never buffers 32 MiB for an anonymous caller. Every body in the existing e2e is under 1 KiB.

**Files:**
- Modify: `apps/data-plane/src/app.ts:1-15` (import, `AppDeps`, constant), `:68` (middleware before `createPipeline`)
- Modify: `apps/data-plane/src/mcp/endpoint.ts:101-106` (reserved route after the 405 route)
- Create: `apps/data-plane/test/body-limit.test.ts`
- Modify: `apps/data-plane/test/mcp.integration.test.ts` (the `'modern (2026-07-28): transport rules'` describe)
- Modify: `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` (§4.1, §9, §10)

**Interfaces:**
- Consumes: `createApp(deps: AppDeps)` (`app.ts:46`); the test helpers `startTestIssuer`, `makeDb`, `seedFixture`, `seedOauthKey`, `createFakeOllama`.
- Produces: `export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024` from `apps/data-plane/src/app.ts`; `AppDeps.maxRequestBodyBytes?: number`.

- [ ] **Step 1: Write the failing body-limit tests**

Create `apps/data-plane/test/body-limit.test.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing reserved-path test**

In `apps/data-plane/test/mcp.integration.test.ts`, inside `describe('modern (2026-07-28): transport rules', …)`, after the test `'the proxy catch-all never sees /mcp, even with MCP not configured'`, add:

```ts
  test('/mcp/ and anything beneath it is 404 for every method and never reaches the proxy (ruling F1)', async () => {
    for (const path of ['/p/small/mcp/', '/p/small/mcp/x', '/p/small/mcp//']) {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const res = await app.request(`${DP}${path}`, {
          method,
          headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify({ model: 'llama3.2:1b', messages }) } : {}),
        })
        expect([path, method, res.status]).toEqual([path, method, 404])
      }
    }
    expect(upstreamCalls).toEqual([])
  })
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run apps/data-plane/test/body-limit.test.ts apps/data-plane/test/mcp.integration.test.ts`
Expected: 5 failures. `the default is 32 MiB` fails with `expected undefined to be 33554432`. The proxy test fails with `expected 200 to be 413`. The Content-Length and MCP tests fail with `expected 401 to be 413`. The reserved-path test fails with `expected [ '/p/small/mcp/', 'GET', 403 ] to deeply equal [ '/p/small/mcp/', 'GET', 404 ]`: the proxy's `guard()` answered. The 17 MiB test passes already.

- [ ] **Step 4: Implement the body limit**

In `apps/data-plane/src/app.ts`, add after `import type { Context } from 'hono'`:

```ts
import { bodyLimit } from 'hono/body-limit'
```

Replace the `AppDeps` interface (`:11-15`) with:

```ts
export interface AppDeps extends PipelineDeps {
  readiness?: () => Promise<boolean>
  /** The MCP endpoint (M4). Absent: `/p/:slug/mcp` answers 404, and the proxy still never sees it. */
  mcp?: McpDeps
  /** The request body limit on every `/p/*` request; defaults to `MAX_REQUEST_BODY_BYTES`. Tests lower it. */
  maxRequestBodyBytes?: number
}

/**
 * The largest request body `/p/*` accepts: 32 MiB, for the streaming proxy and MCP alike (follow-up
 * ruling F2). The largest legitimate body is a ComfyUI template submit carrying a base64 image
 * parameter (`/submit`, or `run_<tpl>` over MCP, which plans the same request). A worst-case,
 * incompressible 2048×2048 RGBA PNG is 16.0 MiB, 21.3 MiB as base64, so 32 MiB leaves 1.5× headroom
 * for it. MCP gets the same limit because its `run_<tpl>` carries the same payload (spec M4 D8).
 */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024
```

In `createApp`, immediately before `const pipeline = createPipeline(deps)` (`:68`), add:

```ts
  // Before any `/p/*` handler, so an oversized body is refused before authentication and before it
  // is buffered: a declared Content-Length is judged unread, a chunked body as it streams.
  app.use('/p/*', bodyLimit({
    maxSize: deps.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }))
```

- [ ] **Step 5: Implement the reserved path**

In `apps/data-plane/src/mcp/endpoint.ts`, after the `app.all('/p/:slug/mcp', …)` 405 route (`:101-106`), add:

```ts

  // `/p/:slug/mcp/` and everything beneath it is no endpoint, whatever the method (follow-up ruling F1):
  // the resource is compared exactly, so no token names it, and the proxy catch-all must never see it.
  app.all('/p/:slug/mcp/*', (c: Context) => c.json({ error: 'not found' }, 404))
```

In the same file, update the doc comment of `registerMcpRoutes` (`:38-45`): replace `Must be registered before \`ALL /p/:slug/*\`.` with `Must be registered before \`ALL /p/:slug/*\`, and so must the reserved \`/p/:slug/mcp/*\` (404, ruling F1).`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/data-plane/test/body-limit.test.ts apps/data-plane/test/mcp.integration.test.ts`
Expected: PASS, `43 passed` (5 + 38).

- [ ] **Step 7: Amend the spec**

In `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` §4.1, replace:

```markdown
registered **before** the `ALL /p/:slug/*` catch-all, and a test proves the proxy never sees `/mcp`.
No SDK: the method set is small.
```

with:

```markdown
registered **before** the `ALL /p/:slug/*` catch-all, and a test proves the proxy never sees `/mcp`.
`/p/:slug/mcp/` and every path beneath it answer 404 for every method and are never proxied: the
resource is compared exactly, so no token names them *(amended 2026-09-30, F1)*. Every `/p/*` request
body, MCP included, is limited to 32 MiB; a larger one is 413 `{ error: 'request body too large' }`,
judged before authentication *(amended 2026-09-30, F2)*. No SDK: the method set is small.
```

In §9, append to the rulings table:

```markdown
| 32 MiB body limit on every `/p/*` request, MCP included (F2) | A worst-case incompressible 2048² RGBA PNG is 21.34 MiB as base64; MCP's `run_<tpl>` is the same request as `/submit` (D8) | Low: one constant; a larger input image is refused 413 and the limit is raised |
```

In §10, replace the intro line:

```markdown
Found while writing the plan, each checked against `main` at `4d36af2`. The plan follows the code.
```

with:

```markdown
Found while writing the plan, each checked against `main` at `4d36af2`. The plan follows the code.
Rows marked **F1**–**F8** were added on 2026-09-30 by the M4 follow-ups plan
([`2026-09-30-m4-followups.md`](../plans/2026-09-30-m4-followups.md)), checked against `main` at `ae4ac8a` (0.6.0).
```

and append these rows to the end of the §10 table:

```markdown
| 4.1 (F1) | `/p/:slug/mcp/` fell through to the proxy catch-all | 404 for every method on `/mcp/` and beneath it; never proxied |
| 4.1 (F2) | No request body limit on MCP or the proxy | 32 MiB on every `/p/*` body; 413 before authentication |
```

- [ ] **Step 8: Run the lanes and typecheck**

Run: `pnpm test 2>&1 | grep -E 'Test Files|Tests  ' && pnpm -w exec tsc -b && echo typecheck-ok`
Expected: `0 failed` on both lines; `typecheck-ok`.

- [ ] **Step 9: Commit**

```bash
git add apps/data-plane docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md
git commit -m "fix(data-plane): reserve /p/<slug>/mcp/ and limit request bodies to 32 MiB"
```

---

### Task 3: The MCP 401 names its scope, and the auth gates are tested one at a time

Follow-up items 7 and 5 (gates). Ruling F5.

**F5, verified against the primary source.** The MCP 2026-07-28 authorization page (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), §"Scope Selection Strategy", says MCP servers **SHOULD** include a `scope` parameter in `WWW-Authenticate`. Its example is the **401**, `WWW-Authenticate: Bearer resource_metadata="…", scope="files:read"`, and clients use that `scope` first when they select scopes. The `error="insufficient_scope"` challenge is a separate case: §"Runtime Insufficient Scope Errors" gives it a 403. This endpoint never sends it, because every MCP token carries exactly `mcp` and a token without it is one of the collapsed 401s (`apps/data-plane/src/mcp/auth.ts:87`, spec §4.2). So `scope="mcp"` goes on every MCP 401, the missing-token one included. No `error=` is added, which keeps the anti-oracle rule of `unauthorized.ts`. The admin API is not an MCP server, so this spec does not govern it, and its challenge (`apps/control-plane/src/server/problem.ts:57-65`) is unchanged.

**Gates in isolation.** `authenticateMcp` step 3 (`auth.ts:89-93`) has three refusals that no test isolates. The expired key (`:91`) and the not-scoped key (`:92`) are untested. The client mismatch (`:93`) is one row of a table whose rows all answer the same body, so nothing proves which gate refused. Each new test changes one thing and asserts the logged reason. `Pipeline.paddockScope` (`apps/data-plane/src/pipeline.ts:218-231`) has no unit test, and its 403 `key not scoped to paddock` (`:221-223`) cannot be reached through MCP, because `auth.ts:92` refuses first. It is reached only through the proxy. A new `pipeline.test.ts` covers its 404/403/503 order.

**Files:**
- Modify: `apps/data-plane/src/mcp/auth.ts:14-17`
- Modify: `apps/data-plane/test/mcp-auth.test.ts:4` (import), `:42-44` (challenge), and new tests before `'a revoked key is refused at once…'`
- Create: `apps/data-plane/test/pipeline.test.ts`
- Modify: `apps/e2e/specs/mcp.spec.ts:126-127`
- Modify: `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` (§4.2, §9, §10)

**Interfaces:**
- Consumes: `authenticateMcp`, `mcpChallenge` (`auth.ts`); `ConfigStore` (`config/config-store.ts:7-13`); `createPipeline(deps: PipelineDeps): Pipeline` (`pipeline.ts:165`); `ResolvedKey`, `ResolvedPaddock` (`config/types.ts`).
- Produces: `mcpChallenge(slug, dataPlaneUrl)` now returns `Bearer resource_metadata="<url>", scope="mcp"`. Every caller already goes through it: `auth.ts:40` and the tests.

- [ ] **Step 1: Write the failing tests**

In `apps/data-plane/test/mcp-auth.test.ts`, replace `import { DrizzleConfigStore } from '../src/config/config-store.js'` with:

```ts
import { DrizzleConfigStore, type ConfigStore } from '../src/config/config-store.js'
```

Replace the body of `'the challenge names the paddock\'s RFC 9728 metadata document'` with:

```ts
    expect(mcpChallenge('small', DP))
      .toBe('Bearer resource_metadata="http://dp.test/.well-known/oauth-protected-resource/p/small/mcp", scope="mcp"')
```

Insert before `test('a revoked key is refused at once, although its token is still unexpired', …)`:

```ts
  // Each of step 3's gates alone: every other check passes, so the logged reason names the one that refused.
  // The store is stubbed to answer a key already past expires_at, as the 30 s CachingConfigStore does for
  // a key that expired after it was cached. From Task 4 on, DrizzleConfigStore never answers an expired
  // key at all, so this is the only way to reach the gate, and the gate is what holds in that window.
  test('an oauth key past its expires_at is refused by this gate, as one cached before it expired would be', async () => {
    const live = await store().resolveKeyById(oauth.keyId)
    const cached: ConfigStore = {
      resolveKeyByHash: async () => null,
      getPaddockBySlug: async () => null,
      resolveKeyById: async () => ({ ...live!, expiresAt: new Date(Date.now() - 1_000) }),
    }
    const out = await authenticateMcp(`Bearer ${good()}`, 'small', deps(), cached)
    expect(out.ok).toBe(false)
    expect(warn).toHaveBeenLastCalledWith('[auth] 401 on /mcp: the oauth key has expired')
  })

  test('an oauth key not scoped to the requested paddock is refused, with a token minted for that paddock', async () => {
    const out = await auth(`Bearer ${good({ aud: mcpResource(DP, 'other') })}`, 'other')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.res.status).toBe(401)
    expect(out.res.headers.get('www-authenticate')).toBe(mcpChallenge('other', DP))
    expect(await out.res.json()).toEqual({ error: 'invalid access token' })
    expect(warn).toHaveBeenLastCalledWith('[auth] 401 on /mcp: the oauth key is not scoped to this paddock')
  })

  test('a token whose client_id is not the client the key was approved for is refused', async () => {
    await expectRefused(`Bearer ${good({ client_id: 'https://evil.example/client.json' })}`, 'invalid access token')
    expect(warn).toHaveBeenLastCalledWith('[auth] 401 on /mcp: the token client is not the client the key was approved for')
  })
```

(`warn` is the file's `beforeEach` spy on `console.warn`.)

Create `apps/data-plane/test/pipeline.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { buildRegistry } from '../src/breeds.js'
import type { ConfigStore } from '../src/config/config-store.js'
import type { ResolvedKey, ResolvedPaddock } from '../src/config/types.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { createPipeline } from '../src/pipeline.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'

const key = (over: Partial<ResolvedKey> = {}): ResolvedKey => ({
  keyId: 'k1', orgId: 'o1', status: 'active', expiresAt: null, paddockSlugs: ['small'], overrides: null, ...over,
})
const paddock = (over: Partial<ResolvedPaddock> = {}): ResolvedPaddock => ({
  paddockId: 'p1', orgId: 'o1', slug: 'small', name: 'Small models', status: 'active', breedId: 'ollama',
  flock: { baseUrl: 'http://fake.ollama', upstreamAuth: null, tlsTrust: false },
  fence: { constraintJson: { allowedRoutes: ['chat'], allowedModels: null }, rateLimit: null, quota: null },
  ...over,
})

/** The pipeline over a config store that knows at most one paddock. */
function pipelineWith(p: ResolvedPaddock | null) {
  const configStore: ConfigStore = {
    resolveKeyByHash: async () => null,
    resolveKeyById: async () => null,
    getPaddockBySlug: async (slug) => (p !== null && p.slug === slug ? p : null),
  }
  return createPipeline({
    configStore, rateLimiter: new InMemoryRateLimiter(), meterSink: new InMemoryMeterSink(), registry: buildRegistry(), jobStore: new InMemoryJobStore(),
  })
}

describe('Pipeline.paddockScope, each gate alone (spec M4 §4.2 step 4)', () => {
  test('an active paddock the key is scoped to opens, with its breed', async () => {
    const out = await pipelineWith(paddock()).paddockScope(key(), 'small')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.scope.breed.id).toBe('ollama')
  })

  test('an unknown or inactive paddock is 404, before the scope is looked at', async () => {
    const unscoped = key({ paddockSlugs: [] })
    for (const p of [null, paddock({ status: 'disabled' })]) {
      expect(await pipelineWith(p).paddockScope(unscoped, 'small'))
        .toEqual({ ok: false, refusal: { status: 404, body: { error: 'unknown paddock' } } })
    }
  })

  test('a key not scoped to the paddock is 403', async () => {
    expect(await pipelineWith(paddock()).paddockScope(key({ paddockSlugs: ['other'] }), 'small'))
      .toEqual({ ok: false, refusal: { status: 403, body: { error: 'key not scoped to paddock' } } })
  })

  test('an upstream credential that cannot be opened is 503, and only a scoped key learns it', async () => {
    const broken = pipelineWith(paddock({ upstreamAuthError: 'unknown-key' }))
    expect(await broken.paddockScope(key(), 'small'))
      .toEqual({ ok: false, refusal: { status: 503, body: { error: 'upstream credential unavailable' } } })
    expect(await broken.paddockScope(key({ paddockSlugs: ['other'] }), 'small'))
      .toMatchObject({ ok: false, refusal: { status: 403 } })
  })
})
```

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run apps/data-plane/test/mcp-auth.test.ts apps/data-plane/test/pipeline.test.ts`
Expected: exactly one failure, the challenge test: `expected 'Bearer resource_metadata="http://dp.test/…/p/small/mcp"' to be 'Bearer resource_metadata="…", scope="mcp"'`. The three gate tests and the four pipeline tests pass already. They are the missing coverage: the gates exist, and these tests pin them one at a time.

- [ ] **Step 3: Implement the challenge**

In `apps/data-plane/src/mcp/auth.ts`, replace `:14-17`:

```ts
/** RFC 9728 §5.1: the bare scheme plus where to discover the authorization server. Nothing else. */
export function mcpChallenge(slug: string, dataPlaneUrl: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(mcpResource(dataPlaneUrl, slug))}"`
}
```

with:

```ts
/**
 * The challenge on every MCP 401: the scheme, where to discover the authorization server (RFC 9728
 * §5.1), and the scope to ask for (MCP 2026-07-28 authorization, "Scope Selection Strategy": servers
 * SHOULD include `scope`, and clients use it first). Nothing else: an `error=` parameter would grade
 * the refusals the fixed 401 body refuses to grade.
 */
export function mcpChallenge(slug: string, dataPlaneUrl: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(mcpResource(dataPlaneUrl, slug))}", scope="${MCP_SCOPE}"`
}
```

(`MCP_SCOPE` is already imported at `:1`.)

- [ ] **Step 4: Let the live e2e prove it too**

In `apps/e2e/specs/mcp.spec.ts`, after `const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]` (`:126`), add:

```ts
  expect(/scope="([^"]+)"/.exec(challenge)?.[1]).toBe('mcp')
```

- [ ] **Step 5: Run the data-plane lane and typecheck**

Run: `pnpm exec vitest run apps/data-plane 2>&1 | grep -E 'Test Files|Tests  ' && pnpm -w exec tsc -b && echo typecheck-ok`
Expected: `0 failed`; `typecheck-ok`. `mcp.integration.test.ts` builds its expected header with `mcpChallenge` and its `resource_metadata` regex still matches, so it needs no edit.

- [ ] **Step 6: Amend the spec**

In §4.2, replace:

```markdown
1. Take the bearer token. If there is none, answer 401 with
   `WWW-Authenticate: Bearer resource_metadata="<DATA_PLANE_URL>/.well-known/oauth-protected-resource/p/<slug>/mcp"`.
```

with:

```markdown
1. Take the bearer token. If there is none, answer 401 with
   `WWW-Authenticate: Bearer resource_metadata="<DATA_PLANE_URL>/.well-known/oauth-protected-resource/p/<slug>/mcp", scope="mcp"`
   (MCP 2026-07-28 authorization, "Scope Selection Strategy": the `scope` a client asks for first) *(amended 2026-09-30, F5)*.
```

and replace `Every refused token gets **one fixed 401 body and the bare challenge plus \`resource_metadata\`**` with `Every refused token gets **one fixed 401 body and the same challenge (scheme, \`resource_metadata\`, \`scope\`)**`.

In §9, append:

```markdown
| `scope="mcp"` on every MCP 401, no `insufficient_scope` 403 (F5) | MCP 2026-07-28 SHOULDs `scope` in the 401 challenge; every MCP token carries exactly `mcp`, and a token without it stays a collapsed 401 | Low: a second scope would add the 403 arm; the admin API's challenge is not governed by the MCP spec and is unchanged |
```

In §10, append:

```markdown
| 4.2 (F5) | Challenge `Bearer resource_metadata="…"` | `Bearer resource_metadata="…", scope="mcp"` on every MCP 401 |
```

- [ ] **Step 7: Commit**

```bash
git add apps/data-plane apps/e2e/specs/mcp.spec.ts docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md
git commit -m "fix(mcp): name the mcp scope in the 401 challenge; test each auth gate alone"
```

---

### Task 4: Key lookups refuse an expired key in their one query (Kanboard #4558)

Kanboard #4558. Ruling F9.

**Verified:** `DrizzleConfigStore.resolveKeyByHash` (`apps/data-plane/src/config/config-store.ts:23-26`) and `resolveKeyById` (`:28-33`) filter by hash or id, and by kind, in SQL. `resolve` (`:35-53`) filters `status` in JS (`:36`) and never looks at `expires_at`. So an unknown key costs one query. A revoked key also costs one query. An **expired** active key costs two, because its paddocks are loaded (`:38-42`), and it is refused only later, by the caller: `apps/data-plane/src/app.ts:78` for the proxy, and `apps/data-plane/src/mcp/auth.ts:91` for MCP. The fix puts `status = 'active' AND (expires_at IS NULL OR expires_at > now)` into the lookup's `WHERE`. Unknown, revoked and expired then all take the same single query and resolve to the same `null`, so they get the same uniform 401. `now` is the process clock (`new Date()`), which is the clock both callers compare with.

**Ruling F9: the callers keep their expiry checks.** They are not provably redundant. The running data plane wraps the store in `CachingConfigStore` (`apps/data-plane/src/server.ts:81`), which caches a resolved key for 30 s (`caching-config-store.ts:23`). A key resolved one second before its `expires_at` is therefore served from the cache for up to 29 s after it, and only the caller's check refuses it in that window. Each caller gets a test with a store stub that answers an already-expired key, which is exactly what the cache does. For MCP, that test is Task 3's. For the proxy, it is added here. One observable change: the log reason for an expired key that is *not* cached becomes `no key matches the presented hash` (proxy) or `the token names no active oauth key` (MCP). The caller's `…has expired` reason now appears only for the cached window. The 401 body is unchanged, and `app.integration.test.ts:94` (`'an expired key is byte-identical to an unknown key, end to end'`) keeps passing.

**Query counting:** no existing test counts queries. The test builds a second drizzle instance over the same PGlite (`db.$client`) with drizzle's own `logger.logQuery` hook, so every statement the store sends is recorded. No new package is needed.

**Files:**
- Modify: `apps/data-plane/src/config/config-store.ts:1` (import), `:16-18` (new `usable`), `:23-33` (both lookups), `:36` (`resolve`)
- Modify: `apps/data-plane/test/config-store.test.ts` (import; a new describe at the end)
- Modify: `apps/data-plane/test/app.integration.test.ts` (one test before `:94`)

**Interfaces:**
- Consumes: `DrizzleConfigStore`, `ConfigStore` (unchanged signatures); `createApp`, `seedFixture`, `seedOauthKey`, `makeDb` (test helpers).
- Produces: nothing new outside the module. The contract of `resolveKeyByHash` and `resolveKeyById` narrows to "active and not expired", which `ConfigStore`'s doc comments now say.

- [ ] **Step 1: Write the failing tests**

In `apps/data-plane/test/config-store.test.ts`, add after `import { eq } from 'drizzle-orm'`:

```ts
import { drizzle } from 'drizzle-orm/pglite'
```

and append to the end of the file:

```ts
describe('an expired key costs what an unknown key costs (Kanboard #4558, follow-up ruling F9)', () => {
  /** A store over the same database whose every statement is counted. */
  function counted(db: TestDb) {
    const log: string[] = []
    const counting = drizzle(db.$client, { schema, logger: { logQuery: (query) => { log.push(query) } } })
    return { store: new DrizzleConfigStore(counting, TEST_RING), log }
  }
  const past = () => new Date(Date.now() - 60_000)

  test('resolveKeyByHash: unknown, revoked and expired are each one query and null; a usable key is two', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const [revoked] = await db.insert(schema.apiKey).values({ orgId: fx.orgId, name: 'r', prefix: 'mm_live_r', hash: 'h-revoked', status: 'revoked' }).returning()
    const [expired] = await db.insert(schema.apiKey).values({ orgId: fx.orgId, name: 'e', prefix: 'mm_live_e', hash: 'h-expired', expiresAt: past() }).returning()
    await db.insert(schema.keyPaddock).values([{ keyId: revoked!.id, paddockId: fx.paddockId }, { keyId: expired!.id, paddockId: fx.paddockId }])
    for (const hash of ['0'.repeat(64), 'h-revoked', 'h-expired']) {
      const { store, log } = counted(db)
      expect(await store.resolveKeyByHash(hash), hash).toBeNull()
      expect(log, hash).toHaveLength(1)
    }
    const { store, log } = counted(db)
    expect((await store.resolveKeyByHash(fx.keyHash))?.keyId).toBe(fx.keyId)
    expect(log).toHaveLength(2)
  })

  test('a key whose expires_at is still ahead resolves', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    await db.update(schema.apiKey).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.apiKey.id, fx.keyId))
    expect((await new DrizzleConfigStore(db, TEST_RING).resolveKeyByHash(fx.keyHash))?.keyId).toBe(fx.keyId)
  })

  test('resolveKeyById: unknown, revoked and expired oauth keys are each one query and null', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const revoked = await seedOauthKey(db, fx, { status: 'revoked' })
    const expired = await seedOauthKey(db, fx)
    await db.update(schema.apiKey).set({ expiresAt: past() }).where(eq(schema.apiKey.id, expired.keyId))
    for (const id of ['00000000-0000-4000-8000-000000000000', revoked.keyId, expired.keyId]) {
      const { store, log } = counted(db)
      expect(await store.resolveKeyById(id), id).toBeNull()
      expect(log, id).toHaveLength(1)
    }
  })
})
```

In `apps/data-plane/test/app.integration.test.ts`, inside `describe('data-plane /p/:slug', …)`, before `test('an expired key is byte-identical to an unknown key, end to end', …)` (`:94`), add:

```ts
  test('the proxy still refuses a key past its expires_at when the store answers one, as a cached entry can', async () => {
    const live = await new DrizzleConfigStore(db, TEST_RING).resolveKeyByHash(fx.keyHash)
    const { app: cachedApp } = createApp({
      configStore: {
        resolveKeyByHash: async () => ({ ...live!, expiresAt: new Date(Date.now() - 1_000) }),
        resolveKeyById: async () => null,
        getPaddockBySlug: async () => null,
      },
      rateLimiter: new InMemoryRateLimiter(),
      meterSink: new InMemoryMeterSink(),
      registry: buildRegistry(),
    })
    const res = await cachedApp.request('http://dp.local/p/small/api/chat', {
      ...chat('llama3.2:1b'), headers: { 'content-type': 'application/json', authorization: `Bearer ${fx.keyPlaintext}` },
    })
    expect(res.status).toBe(401)
    expect(warn).toHaveBeenLastCalledWith('[auth] 401 on /p: the presented key has expired')
  })
```

(`warn` is that file's `beforeEach` spy on `console.warn`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/data-plane/test/config-store.test.ts apps/data-plane/test/app.integration.test.ts`
Expected: 2 failures. The first is `h-expired: expected { …(6) } to be null`, and the second is `<the expired key's id>: expected { …(7) } to be null`: an expired key resolves today. `'a key whose expires_at is still ahead resolves'` and the proxy test pass already. The proxy test pins the caller's check, which this task keeps.

- [ ] **Step 3: Refuse an unusable key in the lookup**

In `apps/data-plane/src/config/config-store.ts`, change the first import to:

```ts
import { and, eq, gt, isNull, or, type SQL } from 'drizzle-orm'
```

Insert before `// Accepts any Drizzle Postgres database (postgres-js in prod, pglite in tests).`:

```ts
/**
 * A key the data plane may honour right now: active, and not past its `expires_at` (Kanboard #4558,
 * follow-up ruling F9). In the lookup itself, so an unknown, revoked and expired key all cost the same
 * one query and resolve to the same null; only a usable key goes on to load its paddocks. The callers
 * still check `expiresAt`: `CachingConfigStore` can serve a key for up to its TTL after it expires.
 */
function usable(now: Date): SQL {
  return and(eq(apiKey.status, 'active'), or(isNull(apiKey.expiresAt), gt(apiKey.expiresAt, now)))!
}

```

Replace the two lookup statements:

```ts
    const rows = await this.db.select().from(apiKey).where(and(eq(apiKey.hash, hash), eq(apiKey.kind, 'live'))).limit(1)
```

```ts
    const rows = await this.db.select().from(apiKey).where(and(eq(apiKey.id, id), eq(apiKey.kind, 'oauth'))).limit(1)
```

with, respectively:

```ts
    const rows = await this.db.select().from(apiKey)
      .where(and(eq(apiKey.hash, hash), eq(apiKey.kind, 'live'), usable(new Date()))).limit(1)
```

```ts
    const rows = await this.db.select().from(apiKey)
      .where(and(eq(apiKey.id, id), eq(apiKey.kind, 'oauth'), usable(new Date()))).limit(1)
```

In `resolve`, change `if (!key || key.status !== 'active') return null` (`:36`) to `if (!key) return null`.

In the `ConfigStore` interface (`:7-13`), make the two doc comments say what the lookups now guarantee:

```ts
  /** A consumer `mm_live_` key by the hash of its plaintext: `kind='live'`, active and unexpired, else null. */
  resolveKeyByHash(hash: string): Promise<ResolvedKey | null>
  /** An oauth key by id, as an MCP access token's `mm_kid` names it: `kind='oauth'`, active and unexpired, else null (M4 §4.2). */
  resolveKeyById(id: string): Promise<ResolvedKey | null>
```

In `apps/data-plane/src/app.ts:78` and `apps/data-plane/src/mcp/auth.ts:91`, leave the expiry checks as they are, and add this comment line above each, indented to match:

```ts
// Not redundant with the store's own filter (ruling F9): a cached key can outlive its expires_at by the cache TTL.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/data-plane 2>&1 | grep -E 'Test Files|Tests  |×'`
Expected: `0 failed`. The two counting tests pass, and so does the rest of the lane, including `unauthorized.test.ts` and the end-to-end byte-identical test.

- [ ] **Step 5: Typecheck and check the noise**

Run: `pnpm -w exec tsc -b && echo typecheck-ok; pnpm exec vitest run apps/data-plane 2>&1 | grep -c '^stderr |'`
Expected: `typecheck-ok`; `0`.

- [ ] **Step 6: Commit**

```bash
git add apps/data-plane
git commit -m "fix(data-plane): refuse an expired key in the lookup's one query, as an unknown key is (#4558)"
```

No spec amendment. Spec §4.2 step 3 already says `resolveKeyById` answers only an active, unexpired key. This task makes the query itself hold that, instead of the query plus the caller.

---

### Task 5: `tools/call` plans before it spends budget, and Ollama takes only what it declares

Follow-up items 8, 9 and 5 (quota). Rulings F6 and F7.

**F6, verified:** `callTool` (`apps/data-plane/src/mcp/endpoint.ts:177-215`) calls `pipeline.limits(scope)` at `:182`, which consumes a rate-limit slot (`pipeline.ts:235`), before `breed.mcpCall` validates the arguments at `:185`. So a malformed call spends budget. The spec's own order in §3.8 is plan, then gates ("builds a `RequestCtx` from the planned request. It then runs … rate limit, then quota"). The fix swaps the two blocks. `mcpCall` is pure and does no I/O (`packages/connectors/src/breed.ts`, D8), so planning first costs nothing. Every call that plans is still limited, `get_job_result` included.

**F7, verified:** `ollamaMcpCall` (`packages/connectors/src/ollama/mcp.ts:130-132`) forwards `a.messages` whole. Any key a caller puts on a message (`images`, `tool_calls`, `thinking`) reaches Ollama, although the tool's inputSchema says `additionalProperties: false` (`:29-36`), and the doc comment (`:117-122`) claims "Only the fields each tool's inputSchema declares are copied". `embed` checks only that `input` is a non-empty array (`:144`). The ruling: each message is rebuilt as `{ role, content }`, where both are strings and `role` is `system`, `user` or `assistant`. A message carrying anything else is refused with `invalid arguments`, not trimmed, because the caller asked for something the tool does not offer. Top-level extras stay dropped, as the existing test `'a caller cannot turn streaming back on…'` requires. `embed`'s `input` items must be strings. The doc comment is rewritten to say exactly that.

**Quota over MCP:** nothing tests a quota refusal as `isError`. The rate-limit arm is tested (`mcp.integration.test.ts`, `'tools/call is rate-limited like the proxy'`). The new test is coverage and passes as soon as it is written.

**Files:**
- Modify: `apps/data-plane/src/mcp/endpoint.ts:181-186`
- Modify: `packages/connectors/src/ollama/mcp.ts:117-148`
- Modify: `apps/data-plane/test/mcp.integration.test.ts` (imports; the Ollama and ComfyUI `tools/call` describes)
- Modify: `packages/connectors/test/ollama-mcp-call.test.ts` (new tests before `'the model is NOT checked here…'`)
- Modify: `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` (§3.8, §10)

**Interfaces:**
- Consumes: `Pipeline.limits`, `Breed.mcpCall` (unchanged signatures); `DrizzleUsageReader` (`apps/data-plane/src/meter/usage-reader.ts`); `periodBucket` from `@metamodels/schema`.
- Produces: `ollamaMcpCall` refusals `invalid arguments: messages[<i>] must be an object`, `…messages[<i>] may carry only role and content`, `…messages[<i>].role must be system, user or assistant`, `…messages[<i>].content must be a string`, `…input must be an array of strings`.

- [ ] **Step 1: Write the failing data-plane tests**

In `apps/data-plane/test/mcp.integration.test.ts`, add after the `@metamodels/connectors` import:

```ts
import { periodBucket } from '@metamodels/schema'
```

and after the `../src/meter/meter-sink.js` import:

```ts
import { DrizzleUsageReader } from '../src/meter/usage-reader.js'
```

In `describe('tools/call on an Ollama paddock (M4 §3.8)', …)`, before `'an unreachable upstream is isError, and the JSON-RPC call still succeeds'`, add:

```ts
  test('a call the breed cannot plan is isError and spends no rate-limit budget (fence max 5/60s)', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await call('chat', { model: 'llama3.2:1b' })).body.result)
        .toMatchObject({ content: [{ type: 'text', text: 'invalid arguments: messages must be a non-empty array' }], isError: true })
    }
    for (let i = 0; i < 5; i++) expect((await call('list_models', {})).body.result.isError).toBeUndefined()
    expect((await call('list_models', {})).body.result).toMatchObject({ content: [{ type: 'text', text: 'rate limit exceeded' }], isError: true })
    expect(upstreamCalls).toHaveLength(5)
  })

  test('a quota at its cap is isError with the proxy\'s reason, and never reaches upstream', async () => {
    build({ usageReader: new DrizzleUsageReader(db) })
    await db.update(schema.fence).set({ quota: [{ dim: 'tokens_out', max: 10, period: 'hour' }] }).where(eq(schema.fence.paddockId, fx.paddockId))
    await db.insert(schema.usageRollup).values({
      orgId: fx.orgId, keyId: oauth.keyId, paddockId: fx.paddockId, period: periodBucket(Date.now()), dim: 'tokens_out', value: 10,
    })
    const { status, body } = await call('chat', { model: 'llama3.2:1b', messages })
    expect(status).toBe(200)
    expect(body.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: 'quota exceeded' }], isError: true, _meta: SERVER_INFO })
    expect(upstreamCalls).toEqual([])
  })
```

In `describe('tools/call on a ComfyUI paddock (M4 §3.8)', …)`, before `'images over the per-result cap are isError naming the cap'`, add:

```ts
  test('get_job_result is rate-limited like every call that plans; one without a job_id spends nothing', async () => {
    const [p] = await db.select().from(schema.paddock).where(eq(schema.paddock.slug, 'cf'))
    await db.update(schema.fence).set({ rateLimit: { windowSec: 60, max: 2 } }).where(eq(schema.fence.paddockId, p!.id))
    for (let i = 0; i < 3; i++) {
      expect((await cfCall('get_job_result', {})).body.result)
        .toMatchObject({ content: [{ type: 'text', text: 'invalid arguments: job_id must be a non-empty string' }], isError: true })
    }
    expect((await cfCall('run_txt2img', { prompt: 'a cat' })).body.result.structuredContent).toEqual({ job_id: 'cf-1' })
    expect((await cfCall('get_job_result', { job_id: 'cf-1' })).body.result.isError).toBeUndefined()
    expect((await cfCall('get_job_result', { job_id: 'cf-1' })).body.result)
      .toMatchObject({ content: [{ type: 'text', text: 'rate limit exceeded' }], isError: true })
  })
```

- [ ] **Step 2: Write the failing connector tests**

In `packages/connectors/test/ollama-mcp-call.test.ts`, inside `describe('ollamaMcpCall (M4 D8)', …)`, before `'the model is NOT checked here: guard() is the enforcement point'`, add:

```ts
  test('chat rebuilds each message from role and content alone', () => {
    const sent = [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u' }]
    const plan = ollamaMcpCall('chat', { model: 'llama3.2:1b', messages: sent }, fence)
    expect(plan).toEqual({ ok: true, request: { method: 'POST', path: '/api/chat', body: { model: 'llama3.2:1b', messages: sent, stream: false } } })
    if (!plan.ok) return
    const planned = (plan.request.body as { messages: unknown[] }).messages
    for (const [i, m] of planned.entries()) expect(m, String(i)).not.toBe(sent[i])
  })

  test('a chat message that is not exactly { role, content } is refused, never forwarded', () => {
    const cases: Array<[unknown[], string]> = [
      [[{ role: 'user', content: 'hi', images: ['aGk='] }], 'messages[0] may carry only role and content'],
      [[{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', tool_calls: [] }], 'messages[1] may carry only role and content'],
      [[{ role: 'tool', content: 'x' }], 'messages[0].role must be system, user or assistant'],
      [[{ content: 'x' }], 'messages[0].role must be system, user or assistant'],
      [[{ role: 'user', content: 42 }], 'messages[0].content must be a string'],
      [[{ role: 'user' }], 'messages[0].content must be a string'],
      [['hi'], 'messages[0] must be an object'],
      [[null], 'messages[0] must be an object'],
      [[['user', 'hi']], 'messages[0] must be an object'],
    ]
    for (const [messages, why] of cases) {
      expect(ollamaMcpCall('chat', { model: 'm', messages }, open), why).toEqual({ ok: false, error: `invalid arguments: ${why}` })
    }
  })

  test('embed input must be strings', () => {
    for (const input of [[1], ['a', null], [{ text: 'a' }], [['a']]]) {
      expect(ollamaMcpCall('embed', { model: 'm', input }, open), JSON.stringify(input))
        .toEqual({ ok: false, error: 'invalid arguments: input must be an array of strings' })
    }
  })
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run apps/data-plane/test/mcp.integration.test.ts packages/connectors/test/ollama-mcp-call.test.ts`
Expected: 5 failures. The two budget tests fail with `expected { resultType: 'complete', …(3) } to match object { Object (content, isError) }`: the sixth invalid call was already rate-limited. `chat rebuilds…` fails with `expected { role: 'system', content: 's' } not to be { role: 'system', content: 's' }`. The message cases and the embed cases fail with `expected { ok: true, request: … } to deeply equal { ok: false, … }`. The quota test passes already (it is coverage).

- [ ] **Step 4: Plan before the gates**

In `apps/data-plane/src/mcp/endpoint.ts` `callTool`, replace:

```ts
    // Every tools/call, get_job_result included, is rate-limited and quota-checked (spec M4 §1), in either era.
    const limited = await pipeline.limits(scope)
    if (limited) return toolError(refusalReason(limited))

    const plan = breed.mcpCall(name, args, fence)
    if (!plan.ok) return toolError(plan.error)
```

with:

```ts
    // Plan first: a call the breed cannot plan is isError and spends no rate-limit or quota budget
    // (follow-up ruling F6). Pure, no I/O, so planning before the gates costs nothing.
    const plan = breed.mcpCall(name, args, fence)
    if (!plan.ok) return toolError(plan.error)

    // Every call that plans, get_job_result included, is rate-limited and quota-checked (spec M4 §3.8), in either era.
    const limited = await pipeline.limits(scope)
    if (limited) return toolError(refusalReason(limited))
```

- [ ] **Step 5: Copy only what Ollama's tools declare**

In `packages/connectors/src/ollama/mcp.ts`, replace the doc comment above `ollamaMcpCall` (`:117-122`, from `/**\n * Plan an Ollama \`tools/call\`.` to ` */`) with:

```ts
const CHAT_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant'])

/**
 * The chat tool's `messages`, rebuilt message by message from exactly what its inputSchema declares:
 * `role` (system, user or assistant) and `content`, both strings. A message carrying anything else
 * (`images`, `tool_calls`, `thinking`…) is refused, not trimmed: the schema says
 * `additionalProperties: false`, so the caller asked for something this tool does not offer.
 */
function chatMessages(v: unknown): Array<{ role: string; content: string }> | string {
  if (!Array.isArray(v) || v.length === 0) return 'messages must be a non-empty array'
  const out: Array<{ role: string; content: string }> = []
  for (const [i, m] of v.entries()) {
    const o = argsObject(m)
    if (!o) return `messages[${i}] must be an object`
    if (Object.keys(o).some((k) => k !== 'role' && k !== 'content')) return `messages[${i}] may carry only role and content`
    if (typeof o.role !== 'string' || !CHAT_ROLES.has(o.role)) return `messages[${i}].role must be system, user or assistant`
    if (typeof o.content !== 'string') return `messages[${i}].content must be a string`
    out.push({ role: o.role, content: o.content })
  }
  return out
}

/**
 * Plan an Ollama `tools/call`. The request is built only from what each tool's inputSchema declares:
 * other top-level arguments are dropped, so a caller cannot reach `options`, `keep_alive` or `format`;
 * each chat message is rebuilt from its `role` and `content`, and one carrying any other field is
 * refused; `embed`'s `input` must be strings. Anything malformed is `invalid arguments`. Inference is
 * always `stream: false` (one JSON-RPC response per call). The model is NOT checked here — `guard()`
 * does that, with the same reason string the proxy returns.
 */
```

Replace the `chat` case (`:130-132`):

```ts
    case 'chat':
      if (!Array.isArray(a.messages) || a.messages.length === 0) return invalid('messages must be a non-empty array')
      return { ok: true, request: { method: 'POST', path: '/api/chat', body: { model: a.model, messages: a.messages, stream: false } } }
```

with:

```ts
    case 'chat': {
      const messages = chatMessages(a.messages)
      if (typeof messages === 'string') return invalid(messages)
      return { ok: true, request: { method: 'POST', path: '/api/chat', body: { model: a.model, messages, stream: false } } }
    }
```

Replace the `embed` case body (`:144-145`):

```ts
      if (!Array.isArray(a.input) || a.input.length === 0) return invalid('input must be a non-empty array')
      return { ok: true, request: { method: 'POST', path: '/api/embed', body: { model: a.model, input: a.input } } }
```

with:

```ts
      if (!Array.isArray(a.input) || a.input.length === 0) return invalid('input must be a non-empty array')
      if (!a.input.every((x) => typeof x === 'string')) return invalid('input must be an array of strings')
      return { ok: true, request: { method: 'POST', path: '/api/embed', body: { model: a.model, input: [...a.input] } } }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/data-plane/test/mcp.integration.test.ts packages/connectors/test/ollama-mcp-call.test.ts`
Expected: PASS, `41 passed` (the 38 in `mcp.integration.test.ts` after Task 2, plus 3) and `13 passed`.

- [ ] **Step 7: Amend the spec**

In §3.8, replace:

```markdown
- **Dispatch.** The MCP handler builds a `RequestCtx` from the planned request. It then runs the
  **same pipeline** as `ALL /p/:slug/*`:
```

with:

```markdown
- **Dispatch.** The MCP handler first has the breed plan the call; a call it cannot plan is
  `isError` (`invalid arguments: …`) and spends no rate-limit or quota budget *(amended 2026-09-30, F6)*.
  It builds a `RequestCtx` from the planned request, then runs the **same pipeline** as `ALL /p/:slug/*`:
```

Under **Ollama.** in §3.8, append this bullet after the `stream: false` bullet:

```markdown
  - Only what each inputSchema declares is forwarded. `chat` rebuilds every message as
    `{ role, content }` (both strings; `role` is `system`, `user` or `assistant`) and refuses a message
    carrying any other field; `embed`'s `input` must be strings. Both refusals are `invalid arguments`
    *(amended 2026-09-30, F7)*.
```

In §10, append:

```markdown
| 3.8 (F6) | Rate limit and quota spent before `mcpCall` validated the arguments | Plan first; an unplannable call is `isError` and spends nothing; every call that plans is still limited |
| 3.8 (F7) | `chat` forwarded whole message objects | Each message rebuilt as `{ role, content }`, anything else refused; `embed` input must be strings |
```

- [ ] **Step 8: Run the root lane and typecheck**

Run: `pnpm test 2>&1 | grep -E 'Test Files|Tests  ' && pnpm -w exec tsc -b && echo typecheck-ok`
Expected: `0 failed`; `typecheck-ok`.

- [ ] **Step 9: Commit**

```bash
git add apps/data-plane packages/connectors docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md
git commit -m "fix(mcp): plan tools/call before spending budget; Ollama chat forwards role and content only"
```

---

### Task 6: The consent routes fail closed when Redis is unreachable

Follow-up item 3. Ruling F3.

**Verified:** `withConsentAssertion` awaits `replayGuard().claimOnce` bare (`apps/control-plane/src/server/internal-route.ts:52`). The guard's client is `new Redis(url)` with ioredis defaults (`replay-guard.ts:42-43`). Against a refused port (`redis://127.0.0.1:1`), `SET … NX` with those defaults rejected after **10 519 ms** (`MaxRetriesPerRequestError … (which is 20)`). The rejection escapes the wrapper, and Next answers a raw 500. It also arrives after the OP's 5 s call timeout (`apps/auth/src/consent-api.ts:8`), so the OP never sees even that. With `{ maxRetriesPerRequest: 1, connectTimeout: 2000 }` the same claim rejected in **54 ms**. The ruling: the client fails fast, and the wrapper answers a rejected claim with a 503 problem and `Retry-After: 5`. It never mints. A 503 is correct, not a 401: the assertion may be fine, and the service could not check it. The OP already maps a non-200 mint to `server_error` (`consent-api.ts:117`) and a non-200 preflight to `PREFLIGHT_UNAVAILABLE` (`:83-87`), so nothing changes on the auth side.

**Files:**
- Modify: `apps/control-plane/src/server/replay-guard.ts:33-50`
- Modify: `apps/control-plane/src/server/internal-route.ts:10-16`, `:52-56`
- Modify: `apps/control-plane/src/server/replay-guard.test.ts`
- Modify: `apps/control-plane/src/server/internal-oauth-keys.test.ts` (one test in each describe)
- Modify: `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` (§3.5, §9, §10)

**Interfaces:**
- Consumes: `problem(status, title, detail?, extra?, headers?)` (`problem.ts:36`); `setReplayGuardForTests` (`replay-guard.ts:53`).
- Produces: `export const REPLAY_REDIS_OPTIONS = { maxRetriesPerRequest: 1, connectTimeout: 2_000 } as const` (`replay-guard.ts`); `export const REPLAY_GUARD_RETRY_AFTER_SECONDS = '5'` (`internal-route.ts`).

- [ ] **Step 1: Write the failing tests**

In `apps/control-plane/src/server/replay-guard.test.ts`, replace the two import lines with:

```ts
import Redis from 'ioredis'
import { describe, expect, test } from 'vitest'
import { MemoryReplayGuard, REPLAY_REDIS_OPTIONS, RedisReplayGuard } from './replay-guard'
```

and add before `describe('MemoryReplayGuard', …)`:

```ts
describe('RedisReplayGuard with Redis unreachable (follow-up ruling F3)', () => {
  test('a claim rejects in under 2 s, well inside the OP\'s 5 s call timeout', async () => {
    // Port 1 on loopback: nothing listens, so every connection is refused at once.
    const client = new Redis('redis://127.0.0.1:1', REPLAY_REDIS_OPTIONS)
    client.on('error', () => {})
    try {
      const started = Date.now()
      await expect(new RedisReplayGuard(client).claimOnce('j1', 120)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      client.disconnect()
    }
  })
})
```

In `apps/control-plane/src/server/internal-oauth-keys.test.ts`, in `describe('POST /api/internal/v1/oauth-keys', …)` before `'bearer-only, like the admin API…'`, add:

```ts
  test('Redis unreachable: 503 with Retry-After, nothing minted, nothing published (fail closed)', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    setReplayGuardForTests({ claimOnce: async () => { throw new Error('Reached the max retries per request limit (which is 1).') } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await mint(bearer(await tok.mintConsent(claims(u.id))))
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('5')
      expect(res.headers.get('content-type')).toBe('application/problem+json')
      expect(await res.json()).toMatchObject({ status: 503, detail: 'the consent assertion cannot be checked right now; retry after the Retry-After interval' })
      expect(await db.select().from(schema.apiKey)).toEqual([])
      expect(published).toEqual([])
      expect(err).toHaveBeenCalledWith('[internal] 503, the consent replay guard is unavailable:', 'Error: Reached the max retries per request limit (which is 1).')
    } finally {
      err.mockRestore()
    }
  })
```

and in `describe('GET /api/internal/v1/oauth-keys/preflight', …)` before `'refuses an access token presented as an assertion'`, add:

```ts
  test('Redis unreachable: 503 with Retry-After, not an answer', async () => {
    const u = await (await world()).userIn()
    setReplayGuardForTests({ claimOnce: async () => { throw new Error('connect ECONNREFUSED') } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await preflight(bearer(await tok.mintConsent(claims(u.id, { grant_id: undefined }))))
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('5')
    } finally {
      err.mockRestore()
    }
  })
```

(The file's `beforeEach` installs a fresh `MemoryReplayGuard` for every test, so the throwing guard does not leak.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/replay-guard.test.ts src/server/internal-oauth-keys.test.ts`
Expected: 3 failures. The mint test fails with `Error: Reached the max retries per request limit (which is 1).` and the preflight test with `Error: connect ECONNREFUSED`: both escape the wrapper. The replay-guard test fails with `expected 10524 to be less than 2000`: `REPLAY_REDIS_OPTIONS` is not exported yet, so ioredis runs on its defaults.

- [ ] **Step 3: Fail fast in the guard**

In `apps/control-plane/src/server/replay-guard.ts`, insert before `let singleton: ReplayGuard | undefined` (`:33`):

```ts
/**
 * The replay guard's ioredis options (follow-up ruling F3). With Redis unreachable, ioredis's defaults
 * (20 retries per command, backoff up to 2 s) hold a claim for about 10.5 s before rejecting: longer
 * than the OP's 5 s call timeout (`apps/auth/src/consent-api.ts` `CALL_TIMEOUT_MS`), so the OP gave up
 * first and the route's answer was never seen. One retry rejects a refused connection in well under a
 * second; `connectTimeout` bounds a host that never answers. The route turns the rejection into a 503.
 */
export const REPLAY_REDIS_OPTIONS = { maxRetriesPerRequest: 1, connectTimeout: 2_000 } as const

```

and change `const client = new Redis(url)` (`:43`) to:

```ts
  const client = new Redis(url, REPLAY_REDIS_OPTIONS)
```

- [ ] **Step 4: Answer 503 in the wrapper**

In `apps/control-plane/src/server/internal-route.ts`, insert before `/** One body for every refused assertion…` (`:13`):

```ts
/**
 * How long the OP should wait before trying again when the replay guard cannot answer. The guard's
 * ioredis reconnect backoff reaches 2 s at most (`REPLAY_REDIS_OPTIONS`), so 5 s spans a few attempts.
 */
export const REPLAY_GUARD_RETRY_AFTER_SECONDS = '5'

```

Replace (`:52-56`):

```ts
    if (!(await (await replayGuard()).claimOnce(claims.jti, REPLAY_WINDOW_SECONDS))) {
      // eslint-disable-next-line no-console
      console.warn('[internal] consent assertion refused: jti replayed')
      return refused()
    }
```

with:

```ts
    // Fail closed (follow-up ruling F3): a jti that cannot be claimed is never honoured, and Redis being
    // unreachable is the service's fault, not the assertion's, so it is a 503 the OP may retry, not a 401.
    let first: boolean
    try {
      first = await (await replayGuard()).claimOnce(claims.jti, REPLAY_WINDOW_SECONDS)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[internal] 503, the consent replay guard is unavailable:', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      return problem(
        503,
        'Service Unavailable',
        'the consent assertion cannot be checked right now; retry after the Retry-After interval',
        undefined,
        { 'retry-after': REPLAY_GUARD_RETRY_AFTER_SECONDS },
      )
    }
    if (!first) {
      // eslint-disable-next-line no-console
      console.warn('[internal] consent assertion refused: jti replayed')
      return refused()
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/replay-guard.test.ts src/server/internal-oauth-keys.test.ts`
Expected: PASS, `15 passed`.

- [ ] **Step 6: Amend the spec**

In §3.5, replace:

```markdown
  with `typ` and `aud` fixed. It rejects a replayed `jti` using a short-TTL Redis `SET NX`.
```

with:

```markdown
  with `typ` and `aud` fixed. It rejects a replayed `jti` using a short-TTL Redis `SET NX`. If Redis
  cannot answer, the route fails closed: a 503 problem with `Retry-After: 5`, never a mint, and the
  client gives up within about a second rather than after ioredis's default ~10 s *(amended 2026-09-30, F3)*.
```

In §9, append:

```markdown
| Replay guard fails closed with 503 when Redis is unreachable (F3) | An unclaimable `jti` must not be honoured; the fault is the service's, not the assertion's | Low: an approval during a Redis outage fails with `server_error`, and the user retries |
```

In §10, append:

```markdown
| 3.5 (F3) | Redis unreachable: the claim rejected after ~10.5 s and the route answered a raw 500 | ioredis fails fast (`maxRetriesPerRequest: 1`, `connectTimeout: 2000`); the route answers 503 + `Retry-After: 5` |
```

- [ ] **Step 7: Run the control-plane lane and build**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 2>&1 | grep -E 'Test Files|Tests  ' && pnpm --filter @metamodels/control-plane build >/dev/null && pnpm -w exec tsc -b && echo build-ok`
Expected: `0 failed`; `build-ok`.

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/server docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md
git commit -m "fix(control-plane): the consent replay guard fails closed with 503 when Redis is unreachable"
```

---

### Task 7: A failed CSP lookup keeps the page, and the widened CSP is covered where it was not

Follow-up items 4 and 5 (CSP). Ruling F4.

**Verified:** in `cimdCspMiddleware` (`apps/auth/src/cimd-csp.ts:20-36`), `opts.provider.Interaction.find` (`:26`) is awaited bare, after `next()` has built the page. It is the outermost middleware (`apps/auth/src/provider.ts:239`), so a rejection there replaces a finished page with a 500. **Discrepancy with the brief:** `Client.find` (`:30`) already has `.catch(() => undefined)`, so only `Interaction.find` escapes. The fix moves both lookups into `cimdRedirectOrigin` behind one `try`. On failure the page keeps the static policy, which `interactionMiddleware` already set (`interactions.ts:139`), and the failure is logged. The one cost is that the hand-back redirect may be blocked by `form-action`, which the user can retry. A 500 in place of the page could not be retried.

**Coverage:** a probe on `3f75dd0` showed that the consent-refused page and the switch-account step reached from the consent screen's link both already carry the widened policy. Their tests are coverage and pass when written; they pin D5 on the two pages it had no test for.

**Files:**
- Modify: `apps/auth/src/cimd-csp.ts:20-36`
- Modify: `apps/auth/test/cimd-csp.test.ts`
- Modify: `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` (§3.6, §10)

**Interfaces:**
- Consumes: `quiet` (Task 1, `apps/auth/test/helpers/quiet.ts`); `Preflight` (`apps/auth/src/consent-api.ts:23`); `authorize`, `seedUser`, `startTestOp` (test helpers).
- Produces: `cimdCspMiddleware` keeps its signature; the new `cimdRedirectOrigin(provider, uid): Promise<string | null>` is module-private.

- [ ] **Step 1: Write the tests**

In `apps/auth/test/cimd-csp.test.ts`, replace the import block (`:1-7`) with:

```ts
import { afterEach, describe, expect, test } from 'vitest'
import type { Provider } from 'oidc-provider'
import { mcpResource } from '@metamodels/schema'
import { cimdCspMiddleware } from '../src/cimd-csp.js'
import type { Preflight } from '../src/consent-api.js'
import { authCsp } from '../src/views.js'
import { seedUser } from './helpers/db.js'
import {
  authorize, CIMD_CLIENT_ID, CIMD_REDIRECT_URI, cimdDocument, CONSOLE_URL, DATA_PLANE_URL, startTestOp, type TestOp,
} from './helpers/flow.js'
import { quiet } from './helpers/quiet.js'
```

(keep the existing `import * as schema` and `import { eq }` lines below it). Change `mcpOp`'s first two lines (`:17-20`) so the preflight answer is a parameter:

```ts
async function mcpOp(preflight: Preflight = { allowed: true }) {
  op = await startTestOp({
    cimdDocuments: { [CIMD_CLIENT_ID]: cimdDocument() },
    providerOptions: { consentApi: { preflight: async () => preflight, mint: async () => ({ ok: false, kind: 'error', detail: 'unused' }) } },
```

In `describe('cimdCspMiddleware (M4 D5)', …)`, before `'the console, a static third-party client and the health check keep the static policy'`, add:

```ts
  test('the refusal screen a viewer sees allows the same form-action, so Close can hand back', async () => {
    await mcpOp({ allowed: false, reason: 'Your role cannot approve apps.' })
    const refused = await authorize(op!, { ...mcpRequest, email: 'm@x.io', password: 'hunter2hunter2' })
    if (refused.kind !== 'page') throw new Error('expected the refusal screen')
    expect(refused.body).toContain('You cannot approve this app')
    expect(refused.csp).toBe(WIDENED)
  }, T)

  test('the switch-account step, reached from the consent screen\'s link, allows the same form-action', async () => {
    await mcpOp()
    await seedUser(op!.db, { email: 'b@x.io', password: 'hunter3hunter3', role: 'member' })
    const consent = await authorize(op!, { ...mcpRequest, email: 'm@x.io', password: 'hunter2hunter2' })
    if (consent.kind !== 'page') throw new Error('expected the consent screen')
    expect(consent.body).toContain('prompt=login+consent')
    // The link's own request: the same authorization request with prompt=login consent, as the other account.
    const switched = await authorize(op!, {
      ...mcpRequest, jar: consent.jar, email: 'b@x.io', password: 'hunter3hunter3',
      extra: { ...mcpRequest.extra, prompt: 'login consent' },
    })
    if (switched.kind !== 'page') throw new Error('expected the switch-account step')
    expect(switched.body).toContain('<h1>Switch account?</h1>')
    expect(switched.csp).toBe(WIDENED)
  }, T)
```

Append to the end of the file:

```ts
describe('cimdCspMiddleware when a lookup fails (follow-up ruling F4)', () => {
  const cimdClient = { clientIdMetadataDocument: true, redirectUriAllowed: (u: string) => u === CIMD_REDIRECT_URI }
  const interaction = { params: { client_id: CIMD_CLIENT_ID, redirect_uri: CIMD_REDIRECT_URI } }

  /** Just the provider surface the middleware reads. */
  function fakeProvider(o: { interaction?: () => Promise<unknown>; client?: () => Promise<unknown> } = {}): Provider {
    return {
      Interaction: { find: o.interaction ?? (async () => interaction) },
      Client: { find: o.client ?? (async () => cimdClient) },
    } as unknown as Provider
  }

  /** Run the middleware over an HTML interaction page; the CSP it set, if any. */
  async function cspAfter(provider: Provider): Promise<string | undefined> {
    const headers = new Map<string, string>()
    const ctx = {
      path: '/interaction/abc123',
      response: { is: (t: string) => (t === 'html' ? 'html' : false) },
      set: (k: string, v: string) => { headers.set(k, v) },
    }
    await cimdCspMiddleware({ provider, consoleOrigin: CONSOLE_URL })(ctx as never, async () => {})
    return headers.get('Content-Security-Policy')
  }

  test('with both lookups answering, the fake reaches the widening', async () => {
    expect(await cspAfter(fakeProvider())).toBe(WIDENED)
  })

  test('Interaction.find failing leaves the static policy in place, logs why, and does not throw', async () => {
    const warn = quiet('warn')
    expect(await cspAfter(fakeProvider({ interaction: async () => { throw new Error('adapter down') } }))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[auth] form-action not widened for /interaction/abc123: adapter down')
  })

  test('Client.find failing does the same', async () => {
    const warn = quiet('warn')
    expect(await cspAfter(fakeProvider({ client: async () => { throw new Error('document refetch failed') } }))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[auth] form-action not widened for /interaction/abc123: document refetch failed')
  })
})
```

(The middleware sets no header when it does not widen: in the running service, `interactionMiddleware` has already set the static one, so `undefined` here means "left alone".)

- [ ] **Step 2: Run them**

Run: `pnpm exec vitest run apps/auth/test/cimd-csp.test.ts`
Expected: 2 failures. `Interaction.find failing…` fails with `Error: adapter down`, which escapes the middleware. `Client.find failing…` fails with `expected "warn" to be called with arguments`, because the existing `.catch` swallows the error silently. The refusal-screen, switch-account and fake-reaches tests pass.

- [ ] **Step 3: Implement the fallback**

In `apps/auth/src/cimd-csp.ts`, replace `cimdCspMiddleware` (`:20-36`, from `export function cimdCspMiddleware` to the end of the file) with:

```ts
export function cimdCspMiddleware(opts: { provider: Provider; consoleOrigin: string }): Middleware {
  return async (ctx, next) => {
    await next()
    if (!ctx.response.is('html')) return
    const match = INTERACTION_PAGE.exec(ctx.path)
    if (!match) return
    let origin: string | null
    try {
      origin = await cimdRedirectOrigin(opts.provider, match[1]!)
    } catch (e) {
      // The page is built and already carries the static policy: a failed lookup (the adapter's
      // database, a CIMD document refetch) only means form-action is not widened. The hand-back
      // redirect may then be blocked, which the user can retry; a 500 in place of the page could not be.
      // eslint-disable-next-line no-console
      console.warn(`[auth] form-action not widened for ${ctx.path}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (origin !== null) ctx.set('Content-Security-Policy', authCsp([opts.consoleOrigin, origin]))
  }
}

/** The validated `redirect_uri` origin of interaction `uid`, when its client is a CIMD client; else null. May throw. */
async function cimdRedirectOrigin(provider: Provider, uid: string): Promise<string | null> {
  const interaction = await provider.Interaction.find(uid)
  if (!interaction) return null
  const { client_id: clientId, redirect_uri: redirectUri } = interaction.params as Record<string, unknown>
  if (typeof clientId !== 'string' || typeof redirectUri !== 'string') return null
  const client = await provider.Client.find(clientId)
  if (!client || !isCimdClient(client) || !client.redirectUriAllowed(redirectUri)) return null
  const origin = new URL(redirectUri).origin
  return origin === 'null' ? null : origin
}
```

and append one sentence to the doc comment above it (after `Nothing else changes, on any response.`): `If either lookup fails, the static policy stays and the failure is logged (follow-up ruling F4).`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/cimd-csp.test.ts`
Expected: PASS, `7 passed`.

- [ ] **Step 5: Amend the spec**

In §3.6, replace:

```markdown
directive, and every other response, keeps the static policy. A test asserts both the widened header
on a CIMD consent response and the unchanged header everywhere else.
```

with:

```markdown
directive, and every other response, keeps the static policy. A test asserts both the widened header
on a CIMD consent response and the unchanged header everywhere else. If looking up the interaction
or its client fails, the page keeps the static policy and the failure is logged; it is never turned
into a 500 *(amended 2026-09-30, F4)*.
```

In §10, append:

```markdown
| 3.6 (F4) | An `Interaction.find` failure escaped the CSP middleware as a 500 | Both lookups guarded; the static policy stays and the failure is logged |
```

- [ ] **Step 6: Run the auth lane and check the noise**

Run: `pnpm exec vitest run apps/auth 2>&1 | tee /tmp/auth.log | grep -E 'Test Files|Tests  '; grep -c '^stderr |' /tmp/auth.log`
Expected: `0 failed`; `0`.

- [ ] **Step 7: Commit**

```bash
git add apps/auth docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md
git commit -m "fix(auth): a failed CIMD CSP lookup keeps the page and the static policy"
```

---

### Task 8: A paddock that vanished during consent gets the paddock refusal

Follow-up item 10. Ruling F8.

**Verified:** `mcpConsent` (`apps/auth/src/interactions.ts:244-271`) returns `null` for an unknown or disabled paddock (`:250-251`), and both callers turn `null` into M1's `NOT_PERMITTED`, "This client is not permitted to sign in yet." (`:36`, `:196-200`, `:292-293`). **Discrepancy with the brief:** `/auth` already refuses an unknown or disabled paddock with `invalid_target` (`apps/auth/src/resources.ts:83`). This path is therefore reached only when the paddock is disabled or deleted after the request began. A probe showed Approve on a shown screen, after the paddock was disabled, coming back as `error=access_denied&error_description=This+client+is+not+permitted+to+sign+in+yet.`, and a reload of the screen doing the same.

**Ruling F8:** `mcpConsent` answers `not-mcp`, `no-paddock` or `consent`. `no-paddock` renders the same refusal page the preflight's `PREFLIGHT_NO_PADDOCK` answer renders (`apps/control-plane/src/server/keys-service.ts:250-251`). It uses its auth-side twin `MINT_DENIED_PADDOCK` (`apps/auth/src/consent-api.ts:13`), with only Close. Approve and Close end with `access_denied` and that description, and Deny keeps its usual answer. A disabled paddock in the user's org and a paddock in another org then produce byte-identical pages, which a test asserts. So the screen reveals nothing about another org. (The pre-login `invalid_target` versus login-page difference at `/auth` already tells active slugs from others, for anyone. That is D2's dynamic resolution, and it is out of scope here.)

**Files:**
- Modify: `apps/auth/src/interactions.ts:11`, `:195-201`, `:213-216`, `:238-271`, `:292-295`
- Modify: `apps/auth/test/mcp-consent.test.ts:7` (import) and three tests before `'a CIMD client asking for no MCP resource…'`
- Modify: `docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md` (§4.3, §10)

**Interfaces:**
- Consumes: `MINT_DENIED_PADDOCK` (`consent-api.ts:13`); `renderConsentRefusedPage({ uid, reason, email, switchAccountHref })` (`views.ts:153`); `send`, `consentPage`, `decide`, `fakeControlPlane`, `setup` (test file helpers).
- Produces: the module-private type `McpConsent = { kind: 'not-mcp' } | { kind: 'no-paddock'; email; switchAccountHref } | { kind: 'consent'; request; view }`.

- [ ] **Step 1: Write the failing tests**

In `apps/auth/test/mcp-consent.test.ts`, replace `import type { ConsentApi, ConsentRequest, Preflight } from '../src/consent-api.js'` with:

```ts
import { MINT_DENIED_PADDOCK, type ConsentApi, type ConsentRequest, type Preflight } from '../src/consent-api.js'
```

and before `test('a CIMD client asking for no MCP resource is still refused at consent, as in M1', …)` add:

```ts
  test('a paddock disabled after the screen was shown: reloading it shows the paddock refusal and only Close; Close sends that reason on', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    await op!.db.update(schema.paddock).set({ status: 'disabled' })
    const reloaded = await send(page.jar, `${op!.issuer}/interaction/${page.uid}`)
    const body = await reloaded.text()
    expect(reloaded.status).toBe(200)
    expect(body).toContain(MINT_DENIED_PADDOCK)
    expect(body).toContain(EMAIL)
    expect(body).not.toContain('value="approve"')
    const back = await decide(page, 'close')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('error_description')).toBe(MINT_DENIED_PADDOCK)
    expect(cp.calls.preflight).toHaveLength(1)
    expect(cp.calls.mint).toEqual([])
  }, T)

  test('Approve on a screen whose paddock was disabled since: access_denied with the paddock reason, nothing minted, no grant', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    await op!.db.update(schema.paddock).set({ status: 'disabled' })
    const back = await decide(page, 'approve')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('error_description')).toBe(MINT_DENIED_PADDOCK)
    expect(cp.calls.mint).toEqual([])
    expect(await grants()).toEqual([])
  }, T)

  test('a disabled paddock renders byte for byte the page the control plane\'s answer for another org\'s paddock does', async () => {
    // The preflight's refusal for a paddock outside the user's org, in the words it uses (PREFLIGHT_NO_PADDOCK).
    const cp = fakeControlPlane({ preflight: { allowed: false, reason: MINT_DENIED_PADDOCK } })
    await setup(cp)
    const foreign = await consentPage()
    await op!.db.update(schema.paddock).set({ status: 'disabled' })
    const disabled = await send(foreign.jar, `${op!.issuer}/interaction/${foreign.uid}`)
    expect(await disabled.text()).toBe(foreign.body)
  }, T)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/mcp-consent.test.ts`
Expected: 3 failures. The reload test fails with `expected 303 to be 200`: the interaction was finished with `NOT_PERMITTED`. The Approve test fails with `expected 'This client is not permitted to sign in yet.' to be 'This paddock does not exist, is disabled, or is not in your organization.'`. The byte-for-byte test fails because the reload is a 303 with an empty body.

- [ ] **Step 3: Implement the three-way answer**

In `apps/auth/src/interactions.ts`, replace `import type { ConsentApi, ConsentRequest } from './consent-api.js'` (`:11`) with:

```ts
import { MINT_DENIED_PADDOCK, type ConsentApi, type ConsentRequest } from './consent-api.js'
```

In `showInteraction`, replace (`:195-201`):

```ts
    const mcp = await mcpConsent(deps, details)
    if (!mcp) {
      await deps.provider.interactionFinished(ctx.req, ctx.res, {
        error: 'access_denied', error_description: NOT_PERMITTED,
      }, { mergeWithLastSubmission: false })
      return
    }
```

with:

```ts
    const mcp = await mcpConsent(deps, details)
    if (mcp.kind === 'not-mcp') {
      await deps.provider.interactionFinished(ctx.req, ctx.res, {
        error: 'access_denied', error_description: NOT_PERMITTED,
      }, { mergeWithLastSubmission: false })
      return
    }
    if (mcp.kind === 'no-paddock') {
      html(ctx, 200, renderConsentRefusedPage({ uid, reason: MINT_DENIED_PADDOCK, email: mcp.email, switchAccountHref: mcp.switchAccountHref }))
      return
    }
```

Replace the `McpConsent` interface (`:213-216`) with:

```ts
/**
 * What `mcpConsent` found: not an MCP consent at all (M1's refusal answers it); an MCP consent whose
 * paddock is unknown or disabled; or one to show.
 */
type McpConsent =
  | { kind: 'not-mcp' }
  | { kind: 'no-paddock'; email: string; switchAccountHref: string }
  | { kind: 'consent'; request: ConsentRequest; view: Omit<ConsentView, 'uid'> }
```

Replace `mcpConsent` and its doc comment (`:238-271`) with:

```ts
/**
 * The consent context of this interaction. A CIMD client asking for exactly one MCP resource is an MCP
 * consent; anything else is `not-mcp`. Everything shown is re-read here: the client from its document
 * (cached by oidc-provider), the paddock and the user's email from the database.
 *
 * `/auth` already refuses an unknown or disabled paddock (`invalid_target`, `resources.ts`), so
 * `no-paddock` is a paddock disabled or deleted after the request began. It is answered with the
 * words the control plane's preflight gives for a paddock in another org (`MINT_DENIED_PADDOCK`, the
 * twin of `PREFLIGHT_NO_PADDOCK`), on the same refusal page, so the screen cannot tell the two apart.
 */
async function mcpConsent(deps: InteractionDeps, details: InteractionDetails): Promise<McpConsent> {
  const client = await deps.provider.Client.find(String(details.params.client_id)).catch(() => undefined)
  if (!client || !isCimdClient(client)) return { kind: 'not-mcp' }
  const resource = singleResource(details.params.resource)
  const slug = resource === null ? null : parseMcpResource(deps.dataPlaneUrl, resource)
  if (resource === null || slug === null) return { kind: 'not-mcp' }

  const accountId = details.session?.accountId
  if (!accountId) throw new Error('consent prompt reached without an authenticated session')
  const rows = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, accountId)).limit(1)
  const email = rows[0]?.email ?? ''
  const href = switchAccountHref(details.params)

  const paddock = await findPaddock(deps.db, slug)
  if (!paddock || paddock.status !== 'active') return { kind: 'no-paddock', email, switchAccountHref: href }

  const clientHost = new URL(client.clientId).host
  const clientName = client.clientName ?? clientHost
  return {
    kind: 'consent',
    request: { accountId, clientId: client.clientId, clientName, resource },
    view: {
      clientName,
      clientHost,
      redirectHost: new URL(String(details.params.redirect_uri)).host,
      paddockName: paddock.name,
      paddockSlug: paddock.slug,
      email,
      switchAccountHref: href,
    },
  }
}
```

In `submitConsent`, replace (`:292-295`):

```ts
  const mcp = await mcpConsent(deps, details)
  if (!mcp) return void await fail({ error: 'access_denied', error_description: NOT_PERMITTED })

  const decision = form.get('decision')
```

with:

```ts
  const mcp = await mcpConsent(deps, details)
  if (mcp.kind === 'not-mcp') return void await fail({ error: 'access_denied', error_description: NOT_PERMITTED })

  const decision = form.get('decision')
  if (mcp.kind === 'no-paddock') {
    // What the same decision gets for another org's paddock: Deny its usual answer; Approve (a screen
    // shown before the paddock went away) and Close the paddock reason, as the mint's 404 and preflight give it.
    return void await fail({
      error: 'access_denied',
      error_description: decision === 'deny' ? 'The request was denied.' : MINT_DENIED_PADDOCK,
    })
  }
```

The rest of `showInteraction` and `submitConsent` reads `mcp.request` and `mcp.view` exactly as before. After the `kind` checks, TypeScript narrows `mcp` to the `consent` arm.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/mcp-consent.test.ts`
Expected: PASS, `14 passed`.

- [ ] **Step 5: Amend the spec**

In §4.3, replace:

```markdown
Approve and Deny post back to the OP. Deny ends the interaction with `access_denied`. If the
preflight (§3.5) returns `allowed: false`, the screen shows the reason and only a Close button.
```

with:

```markdown
Approve and Deny post back to the OP. Deny ends the interaction with `access_denied`. If the
preflight (§3.5) returns `allowed: false`, the screen shows the reason and only a Close button.
If the paddock is unknown or disabled when the screen is shown or submitted (disabled after `/auth`
accepted the resource), the screen is that same refusal with the preflight's words for another org's
paddock (`PREFLIGHT_NO_PADDOCK`). Approve or Close then ends with `access_denied` and that description,
so the two cases cannot be told apart *(amended 2026-09-30, F8)*.
```

In §10, append:

```markdown
| 4.3 (F8) | A paddock gone at consent got M1's "This client is not permitted to sign in yet." | The paddock refusal page with `PREFLIGHT_NO_PADDOCK`'s words; `access_denied` with that description |
```

- [ ] **Step 6: Run the auth lane and typecheck**

Run: `pnpm exec vitest run apps/auth 2>&1 | tee /tmp/auth.log | grep -E 'Test Files|Tests  '; grep -c '^stderr |' /tmp/auth.log; pnpm -w exec tsc -b && echo typecheck-ok`
Expected: `0 failed`; `0`; `typecheck-ok`.

- [ ] **Step 7: Commit**

```bash
git add apps/auth docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md
git commit -m "fix(auth): a paddock gone at consent gets the paddock refusal, not M1's"
```

---

### Task 9: The console build fetches no fonts

Follow-up item 11. Ruling F10.

**What happened.** The v0.6.0 release run failed once in `next build --webpack` with `An error occurred in next/font. TypeError: Cannot read properties of null (reading '1')`, and a rerun passed. `apps/control-plane/src/app/layout.tsx:3` imports `IBM_Plex_Sans` and `IBM_Plex_Mono` from `next/font/google`, which fetches Google Fonts at build time. It is the only `next/font/google` use in `apps/control-plane` (`grep -rn "next/font" apps/control-plane/src` also finds only two comments, `src/lib/csp.ts:62` and `src/lib/csp.test.ts:44`). **Reproduced:** with the network removed (`unshare -rn`, a user plus network namespace with no interfaces), `pnpm --filter @metamodels/control-plane build` fails in 8 s with ``Failed to fetch `IBM Plex Mono` from Google Fonts.`` and ``Failed to fetch `IBM Plex Sans` from Google Fonts.`` (`getaddrinfo EAI_AGAIN fonts.googleapis.com`). The Docker image builds the console the same way (`docker/Dockerfile:18`), so every image build shares the risk.

**Ruling F10: vendor the fonts from google/fonts at a pinned commit, and load them with `next/font/local`.** The source is the google/fonts repository at commit `9710da1eacb3be272583c3224dcb70f9da6eadbb`, which was HEAD on 2026-09-30. These are the exact font binaries Google Fonts itself serves (subsetting aside), with the family's `OFL.txt` beside them. Pinning the commit makes the URL immutable, so the checksums below hold forever. Plex Sans is published there only as the variable font `IBMPlexSans[wdth,wght].ttf` (METADATA.pb, version 3.201), which is also what `next/font/google` was serving; weights 400–600 come from its `wght` axis. Plex Mono is static, and Regular (400) and Medium (500) are the two weights the layout loads. Both families carry the same OFL text (identical SHA-256), so it is vendored once. The TTFs are committed unconverted, so each file's checksum is upstream's. The cost is size: about 537 KB plus two files of about 135 KB each, where Google's Latin subsets were ~40 KB woff2 each. They are served same-origin with Next's immutable cache headers. Converting to woff2 would need a new tool and would break the upstream checksums, so it is not done here. The system-font fallback the brief allowed is not needed, because an authoritative URL and checksum were pinned.

**Behaviour stays the same.** It is the same families and the same weights (Sans 400/500/600, Mono 400/500), and the same CSS variables, `--font-ibm-plex-sans` and `--font-ibm-plex-mono`, which `src/app/globals.css:20-21` reads. `next/font/local` generates an Arial-metric fallback just as `next/font/google` did. Measured on the two builds: Sans `size-adjust` 101.13% vs 101.17%, and Mono 131.49% vs 134.59%. That is a fallback-only difference, visible only before the font loads. The generated `font-family` name changes from `IBM Plex Sans` to a hashed local name, and nothing references that name: the layout reads only the variables.

**The test is the offline build, not a grep.** A grep for `next/font/google` only proves that one import is gone. The property this task needs is "the console builds with no network", and only an offline build proves it. It would also catch any other build-time fetch, for example a future `next/font/google` in another file or a remote image. `unshare -rn` gives the build a namespace with no network at all, which is stricter than blocking one hostname, and it needs no root. Its red run is the failure above. It runs here, and again in Task 10.

**CSP.** `apps/control-plane/src/lib/csp.ts:62` already allows only `font-src 'self'`. There is no `fonts.gstatic.com` or `fonts.googleapis.com` allowance to remove, because `next/font/google` self-hosted its downloads. Only the two comments that name `next/font/google` change.

**Files:**
- Create: `apps/control-plane/src/app/fonts/IBMPlexSans[wdth,wght].ttf`, `IBMPlexMono-Regular.ttf`, `IBMPlexMono-Medium.ttf`, `OFL.txt`, `SHA256SUMS`, `SOURCES.md`
- Modify: `apps/control-plane/src/app/layout.tsx:3-15`
- Modify: `apps/control-plane/src/lib/csp.ts:62`, `apps/control-plane/src/lib/csp.test.ts:44` (comments only)

**Interfaces:**
- Consumes: `next/font/local` (part of `next@16.3.5`, already installed; no new package).
- Produces: the same `ibmPlexSans.variable` / `ibmPlexMono.variable` class names on `<html>` (`layout.tsx:29`), which set `--font-ibm-plex-sans` and `--font-ibm-plex-mono`.

- [ ] **Step 1: Prove the build needs the network today (the failing test)**

Run:

```bash
unshare -rn sh -c 'getent hosts fonts.googleapis.com || echo no-network'
NEXT_TELEMETRY_DISABLED=1 unshare -rn pnpm --filter @metamodels/control-plane build 2>&1 | grep -E 'Failed to fetch|Failed to compile'; echo "rc=${PIPESTATUS[0]}"
```

Expected: `no-network`; then ``Failed to fetch `IBM Plex Mono` from Google Fonts.``, ``Failed to fetch `IBM Plex Sans` from Google Fonts.``, `Failed to compile.`, and a non-zero `rc`. (If `unshare -rn` itself fails with `Operation not permitted`, unprivileged user namespaces are off on this machine. Say so, and run Steps 1 and 6 with `docker run --network none` over the workspace instead. Do not skip them.)

- [ ] **Step 2: Download the fonts and the licence from the pinned upstream commit**

```bash
B=https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl
D=apps/control-plane/src/app/fonts
mkdir -p "$D"
curl -fsSL -o "$D/IBMPlexSans[wdth,wght].ttf" "$B/ibmplexsans/IBMPlexSans%5Bwdth,wght%5D.ttf"
curl -fsSL -o "$D/IBMPlexMono-Regular.ttf" "$B/ibmplexmono/IBMPlexMono-Regular.ttf"
curl -fsSL -o "$D/IBMPlexMono-Medium.ttf" "$B/ibmplexmono/IBMPlexMono-Medium.ttf"
curl -fsSL -o "$D/OFL.txt" "$B/ibmplexsans/OFL.txt"
curl -fsSL "$B/ibmplexmono/OFL.txt" | sha256sum
```

Expected: every `curl` exits 0; the last line is `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da  -`, the Mono family's `OFL.txt`, identical to the Sans one vendored.

- [ ] **Step 3: Record and verify the checksums**

Create `apps/control-plane/src/app/fonts/SHA256SUMS` with exactly these lines (the checksums measured on 2026-09-30 at the pinned commit):

```
3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3  IBMPlexSans[wdth,wght].ttf
6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46  IBMPlexMono-Regular.ttf
a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755  IBMPlexMono-Medium.ttf
7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da  OFL.txt
```

Run: `(cd apps/control-plane/src/app/fonts && sha256sum -c SHA256SUMS)`
Expected: four lines ending `OK`. Any `FAILED` means the download is not the pinned upstream file: stop, and do not commit it.

Create `apps/control-plane/src/app/fonts/SOURCES.md`:

```markdown
# Vendored fonts

Loaded by `../layout.tsx` with `next/font/local`, so the console build fetches nothing (ruling F10 of
`docs/superpowers/plans/2026-09-30-m4-followups.md`). Files are upstream's, byte for byte; `SHA256SUMS`
pins them (`sha256sum -c SHA256SUMS`).

| File | Source (google/fonts @ `9710da1eacb3be272583c3224dcb70f9da6eadbb`) |
|---|---|
| `IBMPlexSans[wdth,wght].ttf` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexsans/IBMPlexSans%5Bwdth,wght%5D.ttf` |
| `IBMPlexMono-Regular.ttf` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexmono/IBMPlexMono-Regular.ttf` |
| `IBMPlexMono-Medium.ttf` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexmono/IBMPlexMono-Medium.ttf` |
| `OFL.txt` | `https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ibmplexsans/OFL.txt` (identical to `ofl/ibmplexmono/OFL.txt`) |

IBM Plex is © 2017 IBM Corp., licensed under the SIL Open Font License 1.1 (`OFL.txt`), with Reserved
Font Name "Plex". To update: pick a new google/fonts commit, re-download, and regenerate `SHA256SUMS`.
```

- [ ] **Step 4: Load them locally**

In `apps/control-plane/src/app/layout.tsx`, replace `:3-15`:

```tsx
import { IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google'

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-sans',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-ibm-plex-mono',
})
```

with:

```tsx
import localFont from 'next/font/local'

// Vendored (fonts/SOURCES.md, ruling F10): the build fetches nothing, so a Google Fonts hiccup cannot fail it.
// Same families, weights and CSS variables as the next/font/google setup this replaced.
const ibmPlexSans = localFont({
  src: [{ path: './fonts/IBMPlexSans[wdth,wght].ttf', weight: '400 600', style: 'normal' }],
  variable: '--font-ibm-plex-sans',
})

const ibmPlexMono = localFont({
  src: [
    { path: './fonts/IBMPlexMono-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexMono-Medium.ttf', weight: '500', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
})
```

- [ ] **Step 5: Correct the CSP comments**

In `apps/control-plane/src/lib/csp.ts:62`, replace `// next/font/google downloads and self-hosts at build time: no external font origin.` with `// Fonts are vendored and served by next/font/local from /_next/static: no external font origin.`. In `apps/control-plane/src/lib/csp.test.ts:44`, replace `// next/font/google self-hosts its downloads at build time, so no external font origin.` with `// Fonts are vendored (next/font/local), so no external font origin.`. The policy itself is unchanged: `font-src 'self'`.

- [ ] **Step 6: Build with the network off (the passing test)**

Run:

```bash
grep -rn "next/font/google" apps/control-plane/src || echo "no next/font/google"
NEXT_TELEMETRY_DISABLED=1 unshare -rn pnpm --filter @metamodels/control-plane build 2>&1 | grep -E 'Compiled successfully|Failed'; echo "rc=${PIPESTATUS[0]}"
grep -o '__variable_[a-z0-9]*{[^}]*}' apps/control-plane/.next/static/css/*.css
grep -o '@font-face{font-family:[a-zA-Z]*;[^}]*font-weight:[^;]*' apps/control-plane/.next/static/css/*.css | grep -o 'font-weight:.*'
```

Expected: `no next/font/google`; `✓ Compiled successfully`, `rc=0`, with no network at all. Two variable rules, `--font-ibm-plex-sans:"ibmPlexSans","ibmPlexSans Fallback"` and `--font-ibm-plex-mono:"ibmPlexMono","ibmPlexMono Fallback"`. Font weights `400 600` (Sans), `400` and `500` (Mono).

- [ ] **Step 7: The control-plane lane and typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/lib/csp.test.ts 2>&1 | grep -E 'Tests  ' && pnpm -w exec tsc -b && echo typecheck-ok`
Expected: `0 failed`; `typecheck-ok`.

- [ ] **Step 8: Commit**

```bash
git add apps/control-plane/src/app/fonts apps/control-plane/src/app/layout.tsx apps/control-plane/src/lib/csp.ts apps/control-plane/src/lib/csp.test.ts
git commit -m "build(control-plane): vendor IBM Plex and load it with next/font/local, so the build fetches no fonts"
```

---

### Task 10: Verification

Both vitest lanes, the build, and the MCP e2e on a throwaway stack. No code changes, unless a check fails. A failure goes back to the task that owns it, as a fix commit.

**Files:** none modified.

**Interfaces:**
- Consumes: every earlier task, through the lanes and the running stack.

- [ ] **Step 1: Both vitest lanes, and the noise**

Run:

```bash
pnpm test 2>&1 | tee /tmp/root.log | grep -E 'Test Files|Tests  '
pnpm exec vitest run apps/auth apps/data-plane 2>&1 | grep -c '^stderr |'
pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 2>&1 | grep -E 'Test Files|Tests  '
```

Expected: both lanes `0 failed`; `0` stderr blocks from the auth and data-plane suites (it was `9` at `3f75dd0`).

- [ ] **Step 2: Build and typecheck (CI's order), then build again with no network**

Run:

```bash
pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b && echo build-ok
(cd apps/control-plane/src/app/fonts && sha256sum -c SHA256SUMS)
NEXT_TELEMETRY_DISABLED=1 unshare -rn pnpm --filter @metamodels/control-plane build 2>&1 | grep -E 'Compiled successfully|Failed'; echo "rc=${PIPESTATUS[0]}"
```

Expected: the Next build succeeds; `build-ok`; four `OK` lines; `✓ Compiled successfully` and `rc=0` with no network (Task 9, ruling F10). At `ae4ac8a` this offline build failed with ``Failed to fetch `IBM Plex Mono` from Google Fonts.``

- [ ] **Step 3: List the MCP spec**

Run: `pnpm --filter @metamodels/e2e exec playwright test --list specs/mcp.spec.ts | tail -1`
Expected: `Total: 8 tests in 1 file`.

- [ ] **Step 4: Bring up the throwaway stack**

Never the `metamodels` project, never its ports (3200/8787/3100). Check the ports are free first:

```bash
ss -ltnp | grep -E ':(3310|3311|8797)\b' && echo "PORT IN USE — pick others" || echo free
docker compose -p metamodels ps --format '{{.Name}} {{.Status}}' > /tmp/metamodels-before.txt
SCRATCH=$(mktemp -d)
cp .env.example "$SCRATCH/mm-verify.env"
cat >> "$SCRATCH/mm-verify.env" <<'EOF'
CONTROL_PLANE_PORT=3310
AUTH_HOST_PORT=3311
DATA_PLANE_PORT=8797
CONSOLE_URL=http://localhost:3310
OIDC_ISSUER=http://localhost:3311
DATA_PLANE_URL=http://localhost:8797
EOF
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml -f apps/e2e/compose.mcp.yml up -d --build --wait
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml run --rm control-plane pnpm seed
OPERATOR_EMAIL=viewer@example.test OPERATOR_PASSWORD=viewer-password-0123 \
  docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml run --rm -e OPERATOR_EMAIL -e OPERATOR_PASSWORD control-plane pnpm seed
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" logs auth | grep -E 'E2E_CIMD_DOCUMENTS|listening'
```

Expected: `free`; every service `Healthy`/`Started`; the auth log shows `serving 1 fixture client document(s)` and `listening on :3100 (issuer http://localhost:3311)`.

- [ ] **Step 5: F1 and F2 against the live data plane**

```bash
curl -s -o /dev/null -w 'mcp/ -> %{http_code}\n' -X POST http://localhost:8797/p/nope/mcp/
head -c 34000000 /dev/zero | tr '\0' 'x' | curl -s -o /dev/null -w '33 MB body -> %{http_code}\n' \
  -X POST -H 'content-type: application/json' --data-binary @- http://localhost:8797/p/nope/api/chat
curl -s -o /dev/null -w 'small body, no key -> %{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' http://localhost:8797/p/nope/api/chat
```

Expected: `mcp/ -> 404`; `33 MB body -> 413`, refused before authentication; `small body, no key -> 401`, the unchanged proxy.

- [ ] **Step 6: Run the MCP spec, then every suite, on that stack**

```bash
GW=$(docker network inspect mm-verify_default -f '{{(index .IPAM.Config 0).Gateway}}')
export E2E_BASE_URL=http://localhost:3310 E2E_AUTH_URL=http://localhost:3311 E2E_PROXY_URL=http://localhost:8797 \
  E2E_UPSTREAM_HOST="$GW" E2E_VIEWER_EMAIL=viewer@example.test E2E_VIEWER_PASSWORD=viewer-password-0123 E2E_MCP=1
pnpm --filter @metamodels/e2e exec playwright test specs/mcp.spec.ts 2>&1 | tee "$SCRATCH/mcp-e2e.log"
grep '^\[mcp\]' "$SCRATCH/mcp-e2e.log"
pnpm --filter @metamodels/e2e exec playwright test 2>&1 | tail -5
```

Expected: `8 passed`. The `[mcp]` lines are as in the M4 plan's Task 15, Step 11, except that the no-token line now reads `no token on … -> 401 Bearer resource_metadata="http://localhost:8797/.well-known/oauth-protected-resource/p/…/mcp", scope="mcp"`. The spec's new `scope="mcp"` assertion (Task 3) passed inside `discover`. The full run passes every spec that is not skipped for a missing opt-in; the proxy suites are unchanged and stay green under the 32 MiB limit.

- [ ] **Step 7: Tear down the throwaway stack**

```bash
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml -f apps/e2e/compose.mcp.yml down -v
docker ps -a --filter label=com.docker.compose.project=mm-verify --format '{{.Names}}' | wc -l
docker compose -p metamodels ps --format '{{.Name}} {{.Status}}' | diff - /tmp/metamodels-before.txt && echo metamodels-untouched
rm -rf "$SCRATCH"
```

Expected: `0`; `metamodels-untouched`.

- [ ] **Step 8: Final sweep**

```bash
git diff origin/main -- . ':!docs/superpowers' | grep -E '^\+.*192\.168\.' || echo "no LAN IP"
git log --format='%an <%ae>' origin/main..HEAD | sort -u
git log --format='%b' origin/main..HEAD | grep -ciE 'co-authored|generated with' || true
git diff --stat origin/main -- '**/package.json' pnpm-lock.yaml | tail -1
```

Expected: `no LAN IP`; one author, `Carmelo Santana <me@carmelosantana.com>`; `0` attribution lines; an empty `package.json`/lockfile diff (zero new packages).

---

## Rulings (2026-09-30)

Each is applied in the task named. F1–F8 change spec behaviour and are recorded in the spec's §10 (and §9 where the cost is worth stating). F9 and F10 do not change spec behaviour, and are recorded here only.

- **F1 — `/p/<slug>/mcp/` is reserved (Task 2).** 404 for every method on it and beneath it; never proxied. The MCP resource is compared exactly, so serving the trailing-slash form would be an endpoint no token can name. Verified: `app.ts:97` caught it and `guard()` answered 403.
- **F2 — 32 MiB request bodies on every `/p/*` route, MCP included (Task 2).** Evidence: a worst-case incompressible 2048² RGBA PNG is 21.34 MiB as base64. The limit is lazy (`apps/data-plane/src/body-limit.ts`): a declared `Content-Length` over the maximum is refused unread, before authentication; any other body is counted as it is read, after authentication. Either way the answer is 413 `{ error: 'request body too large' }`. MCP matches the proxy because `run_<tpl>` is the same request as `/submit` (D8).
- **F3 — the consent replay guard fails closed (Task 6).** ioredis with `{ maxRetriesPerRequest: 1, connectTimeout: 2000 }` rejected in 54 ms, against 10 519 ms on the defaults (beyond the OP's 5 s timeout). A rejection becomes a 503 problem with `Retry-After: 5`, and never a mint.
- **F4 — a CSP lookup failure keeps the page (Task 7).** Both lookups are guarded, and the static policy stays. Only `Interaction.find` escaped (`cimd-csp.ts:26`); `Client.find` already had a `.catch` (`:30`), which now logs as well.
- **F5 — `scope="mcp"` on every MCP 401 (Task 3).** MCP 2026-07-28 authorization, "Scope Selection Strategy": servers SHOULD include `scope` in `WWW-Authenticate`, and its example is the 401. `insufficient_scope` is a 403 for step-up, which this endpoint never needs: every token carries exactly `mcp`. No `error=` is added, which keeps the anti-oracle rule. The admin API challenge is unchanged.
- **F6 — plan, then limit (Task 5).** An unplannable `tools/call` is `isError` and spends no rate-limit or quota budget. Every call that plans is still limited, `get_job_result` included. This restores the order spec §3.8 already describes.
- **F7 — Ollama forwards only declared fields (Task 5).** Chat messages are rebuilt as `{ role, content }`, and any other message shape is refused with `invalid arguments`. `embed` input must be strings. Top-level extras are still dropped, as before.
- **F8 — a vanished paddock at consent gets the paddock refusal (Task 8).** It is the same page and the same `PREFLIGHT_NO_PADDOCK` words as another org's paddock, and they are byte-identical by test. The path is reachable only when a paddock is disabled after `/auth` accepted it, because `resources.ts:83` refuses it earlier with `invalid_target`.
- **F9 — key lookups refuse an expired key in their one query; callers keep their checks (Task 4, Kanboard #4558).** `status = 'active' AND (expires_at IS NULL OR expires_at > now)` is in the `WHERE` of `resolveKeyByHash` and `resolveKeyById`, so unknown, revoked and expired keys each cost one query (counted with drizzle's `logQuery`) and resolve to `null`. The callers' checks (`app.ts:78`, `mcp/auth.ts:91`) stay: `CachingConfigStore` (`server.ts:81`, 30 s TTL) can serve a key after its `expires_at`, and only they refuse it then. Both are pinned by store-stub tests.
- **F10 — the console's fonts are vendored (Task 9).** IBM Plex Sans (variable `[wdth,wght]`, weights 400–600) and IBM Plex Mono (Regular, Medium) come from google/fonts at `9710da1eacb3be272583c3224dcb70f9da6eadbb`. The TTFs are committed unconverted with `SHA256SUMS` and `OFL.txt`, and loaded with `next/font/local` under the same CSS variables. The cost is ~800 KB of TTF where there was ~40 KB of Latin woff2 per face, served same-origin and cached. The proof is a `next build` inside `unshare -rn` (no network namespace): it failed before and passes after. A grep would prove only that one import is gone. No CSP change: `font-src` was already `'self'` only. The system-font fallback was not needed.

**Amended during execution.** Two controller amendments change what the tasks above say; the spec already records both (§4.1, §3.5, §10):

- **F2 uses a lazy limit, not `hono/body-limit`.** `hono/body-limit` buffers a body sent without `Content-Length` before the handler runs, so an anonymous caller could make the process hold up to 32 MiB before authentication. Task 2's `bodyLimit` code was replaced by `limitRequestBody` in `apps/data-plane/src/body-limit.ts`.
- **F3 adds `commandTimeout: 2_000`.** `maxRetriesPerRequest` and `connectTimeout` alone left a claim on a stalled socket pending indefinitely; `REPLAY_REDIS_OPTIONS` now bounds every claim to about 2 s.
