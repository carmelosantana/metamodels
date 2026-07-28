# MetaModels Plan 5.6 — CachingConfigStore + Redis pub/sub invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the data-plane from hitting Postgres for key/paddock/fence config on every proxied request by wrapping `DrizzleConfigStore` in a `CachingConfigStore`, **paired** with Redis pub/sub invalidation the control-plane publishes on every config write — so an operator edit is reflected in the hot path within one round-trip instead of serving stale config.

**Architecture:** A `CachingConfigStore` decorator (data-plane) memoizes `resolveKeyByHash`/`getPaddockBySlug` with a short injected TTL and exposes `invalidateAll()`. The control-plane, after any successful config mutation, publishes a small message on a shared Redis channel (`@metamodels/schema`). The data-plane runs a subscriber (on a duplicated Redis connection) that calls `invalidateAll()` on any message. Caching is enabled **only when Redis is configured** (no Redis → no invalidation channel → keep the uncached `DrizzleConfigStore`, matching how the rate-limiter/meter-sink already degrade). Invalidation is coarse (flush-all) — correct and cheap because config writes are rare operator actions; the TTL is a backstop for a missed message.

**Tech Stack:** TypeScript ESM, Drizzle/Postgres, `ioredis@5.4.2` (already in the monorepo; pub/sub via a duplicated connection), Vitest + `ioredis-mock` (data-plane) / injected fakes.

## Global Constraints

- **Node `>=24`; ESM only.** Shared packages (`@metamodels/schema`) use `.js` import specifiers resolving to `.ts`; the apps do NOT use `.js` specifiers within their own `src`.
- **No new migration.** No schema change — this is a caching + messaging layer over existing tables.
- **`ioredis` is already a monorepo dependency** (data-plane pins `ioredis@5.4.2` exact). Plan 5.6 adds `ioredis@5.4.2` (same exact pin, already-resolved in the lockfile — no new download) to `apps/control-plane` for the publisher. No other new dependency.
- **Shared channel/codec live in `@metamodels/schema`** (`stream.ts`, the existing home of `METER_STREAM_KEY`) so both planes agree on the wire format — exactly as the meter stream already does.
- **Caching is Redis-gated:** enable `CachingConfigStore` + the subscriber ONLY when `REDIS_URL` is set. Without Redis, use the plain `DrizzleConfigStore` (no cache → no staleness). The publisher is a **no-op when `REDIS_URL` is unset** (dev/tests), so control-plane behavior is unchanged in that mode.
- **Invalidation is best-effort and must never break an operator action:** `publishConfigInvalidation` swallows its own errors (logs, does not throw); it runs AFTER the mutation's transaction has committed (post-commit side effect, next to `revalidatePath`). The TTL bounds staleness if a message is ever lost.
- **The subscriber uses a SEPARATE Redis connection** (`redis.duplicate()`): an ioredis connection in subscriber mode cannot issue normal commands, and the main connection is used by the rate-limiter/meter-sink. ioredis auto-re-subscribes after a reconnect, so no manual re-subscribe logic is needed.
- **`CachingConfigStore` implements `ConfigStore` exactly** (`resolveKeyByHash`, `getPaddockBySlug`) so it is a drop-in for `createApp({ configStore })`, plus `invalidateAll()`.
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan5.6`.
- **Test lanes:** root `pnpm test` (baseline 176 pass / 3 skip — this lane covers `packages/*/test/**` and `apps/*/test/**`), control-plane `pnpm --filter @metamodels/control-plane exec vitest run` (baseline 109 pass — co-located `src/**/*.test.ts`), workspace typecheck `pnpm -w exec tsc -b`, control-plane `next build --webpack`. Every task keeps them green. (Two pre-existing scrypt tests can time out under CPU contention — a known flake; re-run with `--testTimeout=30000`.)

---

## File Structure

```
packages/schema/src/
  stream.ts                                  # MODIFY: + CONFIG_INVALIDATE_CHANNEL + ConfigInvalidation + encode/decode
packages/schema/test/
  stream.test.ts                             # MODIFY: + codec round-trip + malformed-reject tests

apps/data-plane/src/config/
  caching-config-store.ts                    # CREATE: TTL-memoizing decorator + invalidateAll()
  config-invalidation-subscriber.ts          # CREATE: pure handler + thin ioredis subscribe wiring
apps/data-plane/test/
  caching-config-store.test.ts               # CREATE
  config-invalidation-subscriber.test.ts     # CREATE
apps/data-plane/src/
  server.ts                                  # MODIFY: wire CachingConfigStore + subscriber when Redis present

apps/control-plane/
  package.json                               # MODIFY: + "ioredis": "5.4.2"
  src/server/
    config-publisher.ts                      # CREATE: publishConfigInvalidation (lazy, no-op w/o REDIS_URL, error-swallowing)
    config-publisher.test.ts                 # CREATE (co-located)
  src/app/(app)/flocks/actions.ts            # MODIFY: publish on save/delete
  src/app/(app)/paddocks/actions.ts          # MODIFY: publish on save/status/delete
  src/app/(app)/paddocks/[id]/fence/actions.ts       # MODIFY: publish on save
  src/app/(app)/keys/actions.ts              # MODIFY: publish on create/revoke
  src/app/(app)/paddocks/[id]/templates/actions.ts   # MODIFY: publish on save/delete
```

---

### Task 1: Shared invalidation channel + codec (`@metamodels/schema`)

**Files:**
- Modify: `packages/schema/src/stream.ts`
- Modify: `packages/schema/test/stream.test.ts`

**Interfaces:**
- Consumes: nothing new (pure).
- Produces (added to `@metamodels/schema`):
  - `CONFIG_INVALIDATE_CHANNEL = 'metamodels:config:invalidate'`
  - `interface ConfigInvalidation { reason: string; at: number }`
  - `encodeConfigInvalidation(reason: string, at: number): string`
  - `decodeConfigInvalidation(payload: string): ConfigInvalidation` (throws on malformed)

- [ ] **Step 1: Write the failing test**

Append to `packages/schema/test/stream.test.ts`:
```ts
import {
  CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation, decodeConfigInvalidation,
} from '../src/stream.js'

describe('config invalidation codec', () => {
  test('channel name is stable', () => {
    expect(CONFIG_INVALIDATE_CHANNEL).toBe('metamodels:config:invalidate')
  })

  test('encode → decode round-trips reason + at', () => {
    const payload = encodeConfigInvalidation('flock.save', 1_700_000_000_000)
    expect(decodeConfigInvalidation(payload)).toEqual({ reason: 'flock.save', at: 1_700_000_000_000 })
  })

  test('decode rejects malformed payloads', () => {
    expect(() => decodeConfigInvalidation('not json')).toThrow()
    expect(() => decodeConfigInvalidation(JSON.stringify({ reason: 'x' }))).toThrow() // missing at
    expect(() => decodeConfigInvalidation(JSON.stringify({ at: 1 }))).toThrow() // missing reason
  })
})
```
(If `stream.test.ts` does not already `import { describe, expect, test } from 'vitest'`, add it — check the top of the file first.)

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm exec vitest run packages/schema/test/stream.test.ts`
Expected: FAIL — `CONFIG_INVALIDATE_CHANNEL`/`encodeConfigInvalidation`/`decodeConfigInvalidation` are not exported.

- [ ] **Step 3: Implement in `stream.ts`**

Append to `packages/schema/src/stream.ts`:
```ts
/** Redis pub/sub channel the control-plane PUBLISHes to on any config write and the
 * data-plane SUBSCRIBEs to, to invalidate its cached key/paddock/fence config. */
export const CONFIG_INVALIDATE_CHANNEL = 'metamodels:config:invalidate'

/** A config-invalidation signal. `reason` is a human/audit hint (e.g. 'flock.save'); the
 * data-plane flushes its whole config cache regardless of reason. `at` is emit time (ms). */
export interface ConfigInvalidation {
  reason: string
  at: number
}

export function encodeConfigInvalidation(reason: string, at: number): string {
  return JSON.stringify({ reason, at })
}

export function decodeConfigInvalidation(payload: string): ConfigInvalidation {
  const o = JSON.parse(payload) as unknown
  if (
    typeof o !== 'object' || o === null ||
    typeof (o as { reason?: unknown }).reason !== 'string' ||
    typeof (o as { at?: unknown }).at !== 'number'
  ) {
    throw new Error('invalid config-invalidation payload')
  }
  return o as ConfigInvalidation
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm exec vitest run packages/schema/test/stream.test.ts`
Expected: PASS (existing stream tests + 3 new).

- [ ] **Step 5: Typecheck + root suite**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm test`
Expected: root green — 179 pass / 3 skip (176 + 3 new). (The barrel `@metamodels/schema` re-exports `./stream.js` via `export * from './stream.js'` already, so the new names are available package-wide.)

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/stream.ts packages/schema/test/stream.test.ts
git commit -m "feat(schema): config-invalidation channel + codec for data-plane cache invalidation"
```

---

### Task 2: CachingConfigStore decorator

**Files:**
- Create: `apps/data-plane/src/config/caching-config-store.ts`
- Create: `apps/data-plane/test/caching-config-store.test.ts`

**Interfaces:**
- Consumes: `ConfigStore`/`ResolvedKey`/`ResolvedPaddock` from `./config-store.js` and `./types.js`.
- Produces:
  - `class CachingConfigStore implements ConfigStore` with constructor `(inner: ConfigStore, opts?: { ttlMs?: number; now?: () => number })` (defaults: `ttlMs = 30_000`, `now = Date.now`).
  - Methods: `resolveKeyByHash(hash): Promise<ResolvedKey | null>`, `getPaddockBySlug(slug): Promise<ResolvedPaddock | null>` (both memoize, including negative/`null` results, and reload after TTL), `invalidateAll(): void` (clears both caches).

- [ ] **Step 1: Write the failing test**

`apps/data-plane/test/caching-config-store.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { CachingConfigStore } from '../src/config/caching-config-store.js'
import type { ConfigStore } from '../src/config/config-store.js'
import type { ResolvedKey, ResolvedPaddock } from '../src/config/types.js'

function fakeKey(id: string): ResolvedKey {
  return { keyId: id, orgId: 'o', status: 'active', expiresAt: null, paddockSlugs: ['s'], overrides: null }
}
function fakePaddock(slug: string): ResolvedPaddock {
  return {
    paddockId: 'p', orgId: 'o', slug, status: 'active', breedId: 'ollama',
    flock: { baseUrl: 'http://f', upstreamAuth: null, tlsTrust: false },
    fence: { constraintJson: {}, rateLimit: null, quota: null },
  }
}

class CountingInner implements ConfigStore {
  keyCalls = 0
  paddockCalls = 0
  key: ResolvedKey | null = fakeKey('k1')
  paddock: ResolvedPaddock | null = fakePaddock('small')
  async resolveKeyByHash(): Promise<ResolvedKey | null> { this.keyCalls++; return this.key }
  async getPaddockBySlug(): Promise<ResolvedPaddock | null> { this.paddockCalls++; return this.paddock }
}

describe('CachingConfigStore', () => {
  test('memoizes a key hit — inner hit once for repeated reads', async () => {
    const inner = new CountingInner()
    const c = new CachingConfigStore(inner)
    expect((await c.resolveKeyByHash('h'))!.keyId).toBe('k1')
    await c.resolveKeyByHash('h')
    await c.resolveKeyByHash('h')
    expect(inner.keyCalls).toBe(1)
  })

  test('memoizes distinct hashes and slugs separately', async () => {
    const inner = new CountingInner()
    const c = new CachingConfigStore(inner)
    await c.resolveKeyByHash('a')
    await c.resolveKeyByHash('b')
    expect(inner.keyCalls).toBe(2)
    await c.getPaddockBySlug('x')
    await c.getPaddockBySlug('x')
    expect(inner.paddockCalls).toBe(1)
  })

  test('negative results are cached too (unknown key not re-queried)', async () => {
    const inner = new CountingInner()
    inner.key = null
    const c = new CachingConfigStore(inner)
    expect(await c.resolveKeyByHash('h')).toBeNull()
    expect(await c.resolveKeyByHash('h')).toBeNull()
    expect(inner.keyCalls).toBe(1)
  })

  test('reloads after TTL expiry', async () => {
    const inner = new CountingInner()
    let t = 1000
    const c = new CachingConfigStore(inner, { ttlMs: 100, now: () => t })
    await c.resolveKeyByHash('h')
    t = 1099 // within TTL
    await c.resolveKeyByHash('h')
    expect(inner.keyCalls).toBe(1)
    t = 1101 // past TTL
    await c.resolveKeyByHash('h')
    expect(inner.keyCalls).toBe(2)
  })

  test('invalidateAll clears both caches', async () => {
    const inner = new CountingInner()
    const c = new CachingConfigStore(inner)
    await c.resolveKeyByHash('h')
    await c.getPaddockBySlug('x')
    c.invalidateAll()
    await c.resolveKeyByHash('h')
    await c.getPaddockBySlug('x')
    expect(inner.keyCalls).toBe(2)
    expect(inner.paddockCalls).toBe(2)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm exec vitest run apps/data-plane/test/caching-config-store.test.ts`
Expected: FAIL — `Cannot find module '../src/config/caching-config-store.js'`.

- [ ] **Step 3: Implement `caching-config-store.ts`**

`apps/data-plane/src/config/caching-config-store.ts`:
```ts
import type { ConfigStore } from './config-store.js'
import type { ResolvedKey, ResolvedPaddock } from './types.js'

interface Entry<T> { value: T; expiresAt: number }

/**
 * Memoizing decorator over a ConfigStore for the request hot path. Caches both hits and
 * negative (null) results with a short TTL, and exposes invalidateAll() for pub/sub-driven
 * eviction on config writes. Redis-agnostic — the subscriber (elsewhere) drives invalidation.
 */
export class CachingConfigStore implements ConfigStore {
  private readonly keyCache = new Map<string, Entry<ResolvedKey | null>>()
  private readonly paddockCache = new Map<string, Entry<ResolvedPaddock | null>>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    private readonly inner: ConfigStore,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  private fresh<T>(entry: Entry<T> | undefined): entry is Entry<T> {
    return entry !== undefined && entry.expiresAt > this.now()
  }

  async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
    const cached = this.keyCache.get(hash)
    if (this.fresh(cached)) return cached.value
    const value = await this.inner.resolveKeyByHash(hash)
    this.keyCache.set(hash, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }

  async getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null> {
    const cached = this.paddockCache.get(slug)
    if (this.fresh(cached)) return cached.value
    const value = await this.inner.getPaddockBySlug(slug)
    this.paddockCache.set(slug, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }

  /** Flush the entire config cache. Called by the invalidation subscriber on any config write. */
  invalidateAll(): void {
    this.keyCache.clear()
    this.paddockCache.clear()
  }
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm exec vitest run apps/data-plane/test/caching-config-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + root suite**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm test`
Expected: root green — 184 pass / 3 skip (179 + 5).

- [ ] **Step 6: Commit**

```bash
git add apps/data-plane/src/config/caching-config-store.ts apps/data-plane/test/caching-config-store.test.ts
git commit -m "feat(data-plane): CachingConfigStore — TTL-memoizing ConfigStore decorator + invalidateAll"
```

---

### Task 3: Invalidation subscriber + server wiring

**Files:**
- Create: `apps/data-plane/src/config/config-invalidation-subscriber.ts`
- Create: `apps/data-plane/test/config-invalidation-subscriber.test.ts`
- Modify: `apps/data-plane/src/server.ts`

**Interfaces:**
- Consumes: `CONFIG_INVALIDATE_CHANNEL`/`decodeConfigInvalidation` from `@metamodels/schema`; `CachingConfigStore` (Task 2).
- Produces:
  - `interface Invalidatable { invalidateAll(): void }`
  - `interface RedisSubscriber { subscribe(channel: string): unknown; on(event: 'message', listener: (channel: string, message: string) => void): unknown }`
  - `handleInvalidationMessage(payload: string, store: Invalidatable): void` (pure — decode + flush; swallows malformed payloads)
  - `subscribeConfigInvalidation(sub: RedisSubscriber, store: Invalidatable): void` (subscribes to the channel + wires the message handler)

- [ ] **Step 1: Write the failing test**

`apps/data-plane/test/config-invalidation-subscriber.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest'
import { CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation } from '@metamodels/schema'
import {
  handleInvalidationMessage, subscribeConfigInvalidation, type RedisSubscriber,
} from '../src/config/config-invalidation-subscriber.js'

function counter() {
  return { n: 0, invalidateAll() { this.n++ } }
}

describe('config invalidation subscriber', () => {
  test('handleInvalidationMessage flushes on a valid payload', () => {
    const store = counter()
    handleInvalidationMessage(encodeConfigInvalidation('flock.save', 1), store)
    expect(store.n).toBe(1)
  })

  test('handleInvalidationMessage ignores a malformed payload (no throw, no flush)', () => {
    const store = counter()
    expect(() => handleInvalidationMessage('not json', store)).not.toThrow()
    expect(store.n).toBe(0)
  })

  test('subscribeConfigInvalidation subscribes to the channel and flushes on a matching message', () => {
    const store = counter()
    let handler: ((channel: string, message: string) => void) | undefined
    const sub: RedisSubscriber = {
      subscribe: vi.fn(),
      on: (_event, listener) => { handler = listener },
    }
    subscribeConfigInvalidation(sub, store)
    expect(sub.subscribe).toHaveBeenCalledWith(CONFIG_INVALIDATE_CHANNEL)

    handler!(CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation('key.revoke', 2))
    expect(store.n).toBe(1)

    handler!('some:other:channel', encodeConfigInvalidation('x', 3)) // wrong channel ignored
    expect(store.n).toBe(1)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm exec vitest run apps/data-plane/test/config-invalidation-subscriber.test.ts`
Expected: FAIL — `Cannot find module '../src/config/config-invalidation-subscriber.js'`.

- [ ] **Step 3: Implement `config-invalidation-subscriber.ts`**

`apps/data-plane/src/config/config-invalidation-subscriber.ts`:
```ts
import { CONFIG_INVALIDATE_CHANNEL, decodeConfigInvalidation } from '@metamodels/schema'

export interface Invalidatable {
  invalidateAll(): void
}

/** The minimal ioredis surface this module needs (a duplicated, subscriber-mode connection). */
export interface RedisSubscriber {
  subscribe(channel: string): unknown
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
}

/** Decode a channel payload and flush the store. Malformed payloads are ignored (no throw). */
export function handleInvalidationMessage(payload: string, store: Invalidatable): void {
  try {
    decodeConfigInvalidation(payload) // validates shape; reason is a log hint only
    store.invalidateAll()
  } catch {
    // Ignore malformed messages — never let a bad publish crash the subscriber.
  }
}

/** Subscribe to the config-invalidation channel and flush `store` on every matching message. */
export function subscribeConfigInvalidation(sub: RedisSubscriber, store: Invalidatable): void {
  sub.subscribe(CONFIG_INVALIDATE_CHANNEL)
  sub.on('message', (channel, message) => {
    if (channel === CONFIG_INVALIDATE_CHANNEL) handleInvalidationMessage(message, store)
  })
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm exec vitest run apps/data-plane/test/config-invalidation-subscriber.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire it into `server.ts`**

In `apps/data-plane/src/server.ts`, add imports near the other config imports:
```ts
import { CachingConfigStore } from './config/caching-config-store.js'
import { subscribeConfigInvalidation } from './config/config-invalidation-subscriber.js'
```
Also import the `ConfigStore` type for the local variable:
```ts
import { DrizzleConfigStore, type ConfigStore } from './config/config-store.js'
```
(Replace the existing `import { DrizzleConfigStore } from './config/config-store.js'` line with the one above.)

Then, inside `startServer`, AFTER the `if (cfg.redisUrl) { … } else { … }` block that sets `redis`/`rateLimiter`/`meterSink`, and BEFORE the `createApp({ … })` call, insert:
```ts
  // Caching requires the invalidation channel: with Redis, wrap the store and subscribe to
  // control-plane config writes on a duplicated (subscriber-mode) connection. Without Redis,
  // there is no invalidation path, so serve config uncached to avoid staleness.
  const baseStore = new DrizzleConfigStore(db)
  let configStore: ConfigStore = baseStore
  if (redis) {
    const caching = new CachingConfigStore(baseStore)
    subscribeConfigInvalidation(redis.duplicate(), caching)
    configStore = caching
  }
```
Then change the `createApp` call's `configStore` line from `configStore: new DrizzleConfigStore(db),` to:
```ts
    configStore,
```

- [ ] **Step 6: Typecheck + root suite (server wiring is integration-only, verified by tsc + the existing server-config test)**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm test`
Expected: root green — 187 pass / 3 skip (184 + 3). The existing `apps/data-plane/test/server-config.test.ts` (which exercises `loadServerConfig`) still passes; `startServer`'s Redis-branch wiring is integration-only (like the existing `RedisRateLimiter`/`RedisMeterSink` wiring, which is not unit-tested at the `startServer` level).

- [ ] **Step 7: Commit**

```bash
git add apps/data-plane/src/config/config-invalidation-subscriber.ts apps/data-plane/test/config-invalidation-subscriber.test.ts apps/data-plane/src/server.ts
git commit -m "feat(data-plane): subscribe to config-invalidation channel; cache config only with Redis"
```

---

### Task 4: Control-plane config publisher

**Files:**
- Modify: `apps/control-plane/package.json` (add `"ioredis": "5.4.2"`)
- Create: `apps/control-plane/src/server/config-publisher.ts`
- Create: `apps/control-plane/src/server/config-publisher.test.ts`

**Interfaces:**
- Consumes: `CONFIG_INVALIDATE_CHANNEL`/`encodeConfigInvalidation` from `@metamodels/schema`.
- Produces:
  - `interface ConfigPublisher { publish(channel: string, message: string): Promise<unknown> }`
  - `publishConfigInvalidation(reason: string, publisher?: ConfigPublisher | null): Promise<void>` — with the `publisher` argument OMITTED it lazily builds a singleton ioredis client from `REDIS_URL` (or resolves to a no-op if `REDIS_URL` is unset); passing `null` forces the no-op; passing a fake injects it (tests). Always swallows publish errors.

- [ ] **Step 1: Add the dependency**

In `apps/control-plane/package.json`, add to `"dependencies"` (keeping alphabetical order among the existing entries — after `"drizzle-orm"`):
```json
    "ioredis": "5.4.2",
```
Then install (offline resolve — the version is already in the monorepo lockfile):

Run: `pnpm install`
Expected: lockfile updated to add `ioredis` under the control-plane workspace; no package downloaded (already resolved for the data-plane).

- [ ] **Step 2: Write the failing test**

`apps/control-plane/src/server/config-publisher.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest'
import { CONFIG_INVALIDATE_CHANNEL, decodeConfigInvalidation } from '@metamodels/schema'
import { publishConfigInvalidation, type ConfigPublisher } from './config-publisher'

describe('publishConfigInvalidation', () => {
  test('publishes a decodable invalidation to the shared channel', async () => {
    const publish = vi.fn().mockResolvedValue(1)
    const fake: ConfigPublisher = { publish }
    await publishConfigInvalidation('flock.save', fake)
    expect(publish).toHaveBeenCalledTimes(1)
    const [channel, message] = publish.mock.calls[0]
    expect(channel).toBe(CONFIG_INVALIDATE_CHANNEL)
    const decoded = decodeConfigInvalidation(message as string)
    expect(decoded.reason).toBe('flock.save')
    expect(typeof decoded.at).toBe('number')
  })

  test('a null publisher (no REDIS_URL) is a no-op and does not throw', async () => {
    await expect(publishConfigInvalidation('x', null)).resolves.toBeUndefined()
  })

  test('swallows publisher errors (never breaks the caller)', async () => {
    const fake: ConfigPublisher = { publish: vi.fn().mockRejectedValue(new Error('boom')) }
    await expect(publishConfigInvalidation('x', fake)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 3: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/config-publisher.test.ts`
Expected: FAIL — `Cannot find module './config-publisher'`.

- [ ] **Step 4: Implement `config-publisher.ts`**

`apps/control-plane/src/server/config-publisher.ts`:
```ts
import { CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation } from '@metamodels/schema'

/** The minimal publish surface (satisfied by an ioredis client). */
export interface ConfigPublisher {
  publish(channel: string, message: string): Promise<unknown>
}

// undefined = not yet initialised; null = disabled (no REDIS_URL); object = live client.
let singleton: ConfigPublisher | null | undefined

/** Lazily build (once) the ioredis publisher from REDIS_URL, or null when Redis is unconfigured. */
async function defaultPublisher(): Promise<ConfigPublisher | null> {
  if (singleton !== undefined) return singleton
  const url = process.env.REDIS_URL
  if (!url) {
    singleton = null
    return null
  }
  const { default: Redis } = await import('ioredis')
  singleton = new Redis(url)
  return singleton
}

/**
 * Publish a config-invalidation signal so the data-plane flushes its config cache.
 * Post-commit, best-effort: never throws (a failed publish is logged; the TTL backstops it).
 * Pass `null` to force a no-op, or a fake to inject (tests); omit to use the REDIS_URL singleton.
 */
export async function publishConfigInvalidation(
  reason: string, publisher?: ConfigPublisher | null,
): Promise<void> {
  const p = publisher !== undefined ? publisher : await defaultPublisher()
  if (!p) return
  try {
    await p.publish(CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation(reason, Date.now()))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[config-publisher] invalidation publish failed:', e)
  }
}
```

- [ ] **Step 5: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/config-publisher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + control-plane suite + build**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 112 pass (109 + 3). (If the two scrypt tests time out under contention, re-run with `--testTimeout=30000`.)

Run: `pnpm --filter @metamodels/control-plane exec next build --webpack`
Expected: build succeeds. `config-publisher.ts` is server-only (imported only by `'use server'` actions in Task 5; here it is imported only by its test), and `ioredis` is loaded via a dynamic `import()` gated on `REDIS_URL`, so it never enters a client bundle.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/package.json pnpm-lock.yaml apps/control-plane/src/server/config-publisher.ts apps/control-plane/src/server/config-publisher.test.ts
git commit -m "feat(control-plane): config-publisher — best-effort Redis invalidation on config writes"
```

---

### Task 5: Publish invalidation from every config-mutating action

**Files:**
- Modify: `apps/control-plane/src/app/(app)/flocks/actions.ts`
- Modify: `apps/control-plane/src/app/(app)/paddocks/actions.ts`
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts`
- Modify: `apps/control-plane/src/app/(app)/keys/actions.ts`
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/templates/actions.ts`

**Interfaces:**
- Consumes: `publishConfigInvalidation` (Task 4).
- Produces: nothing new — each config mutation now publishes an invalidation AFTER the service call succeeds (post-commit), best-effort.

Placement rule for every edit below: call `await publishConfigInvalidation('<reason>')` immediately after the successful `revalidatePath(...)` for that mutation (still inside the `try` for the actions that have one). The publisher swallows its own errors, so no extra try/catch is needed and a no-op in dev/tests (no `REDIS_URL`) changes nothing.

- [ ] **Step 1: Flocks**

In `apps/control-plane/src/app/(app)/flocks/actions.ts`, add the import (after the `deleteFlock` import line):
```ts
import { publishConfigInvalidation } from '../../../server/config-publisher'
```
In `saveFlockAction`, after `revalidatePath('/flocks')` add:
```ts
    await publishConfigInvalidation('flock.save')
```
In `deleteFlockAction`, after `revalidatePath('/flocks')` add:
```ts
  await publishConfigInvalidation('flock.delete')
```

- [ ] **Step 2: Paddocks**

In `apps/control-plane/src/app/(app)/paddocks/actions.ts`, add the import (after the `NotFoundError` import line):
```ts
import { publishConfigInvalidation } from '../../../server/config-publisher'
```
In `savePaddockAction`, after `revalidatePath('/paddocks')` (inside the try) add:
```ts
    await publishConfigInvalidation('paddock.save')
```
In `togglePaddockStatusAction`, after `revalidatePath('/paddocks')` add:
```ts
  await publishConfigInvalidation('paddock.status')
```
In `deletePaddockAction`, after `revalidatePath('/paddocks')` add:
```ts
  await publishConfigInvalidation('paddock.delete')
```

- [ ] **Step 3: Fence**

In `apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts`, add the import (after the `buildBreedRegistry` import line):
```ts
import { publishConfigInvalidation } from '../../../../../server/config-publisher'
```
In `saveFenceAction`, after `revalidatePath(\`/paddocks/${paddockId}/fence\`)` add:
```ts
    await publishConfigInvalidation('fence.save')
```

- [ ] **Step 4: Keys**

In `apps/control-plane/src/app/(app)/keys/actions.ts`, add the import (after the `createKey, revokeKey` import line):
```ts
import { publishConfigInvalidation } from '../../../server/config-publisher'
```
In `createKeyAction`, after `revalidatePath('/keys')` add:
```ts
    await publishConfigInvalidation('key.create')
```
In `revokeKeyAction`, after `revalidatePath('/keys')` add:
```ts
    await publishConfigInvalidation('key.revoke')
```

- [ ] **Step 5: Templates**

In `apps/control-plane/src/app/(app)/paddocks/[id]/templates/actions.ts`, add the import (after the `validateDraft` import line):
```ts
import { publishConfigInvalidation } from '../../../../../server/config-publisher'
```
In `saveTemplateAction`, after `revalidatePath(\`/paddocks/${paddockId}/templates\`)` add:
```ts
    await publishConfigInvalidation('template.save')
```
In `deleteTemplateAction`, after `revalidatePath(\`/paddocks/${paddockId}/templates\`)` add:
```ts
    await publishConfigInvalidation('template.delete')
```
(Do NOT touch `dryRunTemplateAction` — it is read-only.)

- [ ] **Step 6: Typecheck, suites, and build**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 112 pass (unchanged — the actions publish a no-op in tests without `REDIS_URL`; the service tests do not exercise the action layer). Re-run with `--testTimeout=30000` if the scrypt flake appears.

Run: `pnpm --filter @metamodels/control-plane exec next build --webpack`
Expected: build succeeds; all existing routes present. (`config-publisher` remains server-only — imported only by `'use server'` actions.)

Run: `pnpm test`
Expected: root green — 187 pass / 3 skip (unchanged from Task 3).

- [ ] **Step 7: Commit**

```bash
git add "apps/control-plane/src/app/(app)/flocks/actions.ts" "apps/control-plane/src/app/(app)/paddocks/actions.ts" "apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts" "apps/control-plane/src/app/(app)/keys/actions.ts" "apps/control-plane/src/app/(app)/paddocks/[id]/templates/actions.ts"
git commit -m "feat(control-plane): publish config-invalidation from every mutating action"
```

---

## Self-Review

**Spec coverage:**
- `CachingConfigStore` wrapping `DrizzleConfigStore` → Task 2 + wired in Task 3. ✓
- Redis pub/sub invalidation the control-plane publishes on config writes → shared channel/codec (Task 1), publisher (Task 4), wired into all mutating actions (Task 5), subscriber (Task 3). ✓
- "Document the pairing" (roadmap Plan-4 carry-forward) → the Global Constraints + Task 3 comment state that caching is enabled only with Redis (no invalidation path → no cache) and the TTL is the missed-message backstop. ✓
- No migration, no new dependency beyond the already-in-monorepo `ioredis`. ✓

**Placeholder scan:** every code step carries complete code; every run step has an exact command + expected output. No TBD/TODO. ✓

**Type consistency:** `CONFIG_INVALIDATE_CHANNEL`/`ConfigInvalidation`/`encodeConfigInvalidation`/`decodeConfigInvalidation` (Task 1) are used identically in the subscriber (Task 3) and publisher (Task 4). `CachingConfigStore` (Task 2) implements `ConfigStore` and is consumed in Task 3's server wiring; its `invalidateAll()` matches the subscriber's `Invalidatable` interface. `ConfigPublisher.publish(channel, message): Promise<unknown>` matches the ioredis `publish` signature and the test fakes. `publishConfigInvalidation(reason, publisher?)` signature is identical in Task 4 (definition/test) and Task 5 (call sites, which omit the second arg). ✓

**Decisions flagged for the reviewer:** (1) invalidation is coarse flush-all (correct + cheap; a per-mutation cache-key mapping is a deliberate non-goal — config writes are rare operator actions); (2) caching is Redis-gated (no-Redis dev serves uncached to avoid staleness with no invalidation channel); (3) negative/`null` results are cached (bad keys don't hit the DB every request) and flushed on the next config write; (4) the subscriber relies on ioredis auto-re-subscribe after reconnect (no manual re-subscribe), with the TTL as the backstop for the reconnect gap; (5) `startServer`'s Redis-branch wiring is integration-only (not unit-tested at that level, matching the existing `RedisRateLimiter`/`RedisMeterSink` wiring).
