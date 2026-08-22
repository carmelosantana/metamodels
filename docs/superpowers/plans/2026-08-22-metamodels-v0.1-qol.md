# MetaModels v0.1 QoL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first release (`v0.1.0`) with a live Ollama model picker in the fence editor and pre-built GHCR images deployable on Portainer.

**Architecture:** Feature A adds an optional `listModels` breed capability (Ollama → `/api/tags`), a server function + thin action to expose it org-scoped, and a fence UI control that turns the free-text allowlist into a live multiselect with a free-text escape hatch — saving the identical `allowedModels: string[]`, so no schema/enforcement change. Feature B adds a generic `runtime` Docker stage yielding two publishable images, a SHA-pinned GHCR release workflow, and a self-contained Portainer deploy compose. The two features are file-disjoint.

**Tech Stack:** TypeScript, pnpm workspaces, Next.js 16 (webpack), Hono, Drizzle, vitest, Playwright, Docker/Compose, GitHub Actions, GHCR.

## Global Constraints

- Node `>=24`; pnpm `11.9.0` (corepack); `tsc -b` must stay clean.
- **No new runtime or test dependency.** UI logic is unit-tested as pure helpers (vitest, node env); UI behavior is verified via the existing Playwright e2e + a real browser. No jsdom/testing-library.
- Feature B adds only CI-time GitHub Actions, each **pinned to a 40-char commit SHA**.
- Supply-chain posture unchanged: `.npmrc` `minimumReleaseAge=1440` + `blockExoticSubdeps=true`; no `pull_request_target`; least-privilege `permissions:` on every workflow.
- Two vitest lanes: root `pnpm test` (`packages/**/test/**` + `apps/**/test/**/*.test.ts`) and control-plane `vitest` (`src/**/*.test.ts`). New tests go in the correct lane; nothing double-collected.
- **No migration.** Stored constraint stays `allowedModels: string[]`; the data-plane guard in `packages/connectors/src/ollama/breed.ts` is not touched.
- The capability that gates reading the model list is `'read'` (from `Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'`).
- Saving a fence parses `fd.get('models')` as a comma-separated string → `allowedModels` (empty ⇒ `null` ⇒ "any model"). The new control must keep populating that exact hidden `models` field.
- Stack under test on this machine: control-plane host port **3200** (`CONTROL_PLANE_PORT=3200` in `.env`), data-plane **8787**. Real Ollama at `http://192.168.1.140:11434`, model `qwen2.5-coder:0.5b`.

---

# GROUP A — Ollama model picker

### Task A1: `listModels` breed capability (interface + Ollama)

**Files:**
- Modify: `packages/connectors/src/breed.ts` (add `ModelListResult`, add `listModels?` to `Breed`)
- Modify: `packages/connectors/src/ollama/breed.ts` (implement `listModels`)
- Test: `packages/connectors/test/ollama-listmodels.test.ts`

**Interfaces:**
- Produces: `interface ModelListResult { ok: boolean; models: string[]; detail?: string }`; `Breed.listModels?(flock: FlockRef): Promise<ModelListResult>`; `ollamaBreed.listModels`.
- Consumes: existing `FlockRef { baseUrl: string; upstreamAuth?: string | null; tlsTrust?: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/ollama-listmodels.test.ts`:

```ts
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ollamaBreed } from '../src/ollama/index.js'

const flock = { baseUrl: 'http://ollama:11434', upstreamAuth: null, tlsTrust: false }

afterEach(() => vi.unstubAllGlobals())

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

describe('ollamaBreed.listModels', () => {
  test('parses /api/tags into sorted, de-duplicated names', async () => {
    stubFetch(async (url) => {
      expect(url).toBe('http://ollama:11434/api/tags')
      return new Response(
        JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5-coder:0.5b' }, { name: 'llama3.1:8b' }] }),
        { status: 200 },
      )
    })
    const r = await ollamaBreed.listModels!(flock)
    expect(r).toEqual({ ok: true, models: ['llama3.1:8b', 'qwen2.5-coder:0.5b'] })
  })

  test('sends Authorization when upstreamAuth is set', async () => {
    const seen: Record<string, string> = {}
    stubFetch(async (_url, init) => {
      Object.assign(seen, Object.fromEntries(new Headers(init?.headers).entries()))
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    })
    await ollamaBreed.listModels!({ ...flock, upstreamAuth: 'Bearer t0ken' })
    expect(seen['authorization']).toBe('Bearer t0ken')
  })

  test('returns ok:false (never throws) on a non-200', async () => {
    stubFetch(async () => new Response('nope', { status: 502 }))
    const r = await ollamaBreed.listModels!(flock)
    expect(r.ok).toBe(false)
    expect(r.models).toEqual([])
    expect(r.detail).toContain('502')
  })

  test('returns ok:false on a network error and on malformed JSON', async () => {
    stubFetch(async () => { throw new Error('ECONNREFUSED') })
    expect((await ollamaBreed.listModels!(flock)).ok).toBe(false)
    stubFetch(async () => new Response('<html>not json', { status: 200 }))
    const r = await ollamaBreed.listModels!(flock)
    expect(r.ok).toBe(false)
    expect(r.models).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/connectors exec vitest run test/ollama-listmodels.test.ts`
Expected: FAIL — `listModels` is undefined.

- [ ] **Step 3: Add the type + interface member**

In `packages/connectors/src/breed.ts`, directly after the `HealthStatus` interface:

```ts
export interface ModelListResult {
  ok: boolean
  models: string[]
  detail?: string
}
```

In the same file, add to `interface Breed<C = unknown>` right after the `health(...)` line:

```ts
  listModels?(flock: FlockRef): Promise<ModelListResult>
```

- [ ] **Step 4: Implement it on the Ollama breed**

In `packages/connectors/src/ollama/breed.ts`, import the type and add the method after `health`:

```ts
import { defineBreed } from '../breed.js'
import type { Breed, GuardResult, RequestCtx, UpstreamResult, MeterEvent, ModelListResult } from '../breed.js'
```

```ts
  async listModels(flock): Promise<ModelListResult> {
    try {
      const headers: Record<string, string> = {}
      if (flock.upstreamAuth) headers['Authorization'] = flock.upstreamAuth
      const res = await fetch(`${flock.baseUrl.replace(/\/$/, '')}/api/tags`, { headers })
      if (!res.ok) return { ok: false, models: [], detail: `upstream returned HTTP ${res.status}` }
      const data = (await res.json()) as { models?: Array<{ name?: unknown }> }
      const names = Array.isArray(data.models)
        ? data.models.map((m) => m?.name).filter((n): n is string => typeof n === 'string')
        : []
      return { ok: true, models: [...new Set(names)].sort() }
    } catch (err) {
      return { ok: false, models: [], detail: String(err) }
    }
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @metamodels/connectors exec vitest run test/ollama-listmodels.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -w exec tsc -b` → clean.

```bash
git add packages/connectors/src/breed.ts packages/connectors/src/ollama/breed.ts packages/connectors/test/ollama-listmodels.test.ts
git commit -m "feat(connectors): listModels breed capability; Ollama reads /api/tags"
```

---

### Task A2: `listFlockModels` server function + action

**Files:**
- Modify: `apps/control-plane/src/server/flock-health.ts` (add `listFlockModels`)
- Modify: `apps/control-plane/src/app/(app)/flocks/actions.ts` (add `listFlockModelsAction`)
- Test: `apps/control-plane/src/server/flock-health.test.ts` (new)

**Interfaces:**
- Consumes: `ModelListResult`, `BreedRegistry`, `listFlocks(db, actor)`, `buildBreedRegistry()`.
- Produces: `listFlockModels(registry: BreedRegistry, db: Db, actor: Actor, flockId: string): Promise<ModelListResult>`; `listFlockModelsAction(flockId: string): Promise<ModelListResult>`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/flock-health.test.ts`:

```ts
import { afterEach, describe, expect, test, vi } from 'vitest'
import { freshDb, seedOrg } from '../test/db'
import { saveFlock } from './flocks-service'
import { buildBreedRegistry, listFlockModels } from './flock-health'
import type { Actor } from '../auth/authorize'

const registry = buildBreedRegistry()
afterEach(() => vi.unstubAllGlobals())

async function actorFor(db: Awaited<ReturnType<typeof freshDb>>): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: 'admin@x.io', role: 'admin' }
}

describe('listFlockModels', () => {
  test('returns the ollama flock’s models, org-scoped', async () => {
    const db = await freshDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'local', baseUrl: 'http://o:11434', tlsTrust: false })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:0.5b' }] }), { status: 200 })))
    const r = await listFlockModels(registry, db, actor, f.id)
    expect(r).toEqual({ ok: true, models: ['qwen2.5-coder:0.5b'] })
  })

  test('a flock in another org is not found (no cross-org read)', async () => {
    const db = await freshDb()
    const mine = await actorFor(db)
    const otherOrg = await seedOrg(db)
    const stranger: Actor = { id: 'u2', orgId: otherOrg.id, email: 'x@y.io', role: 'admin' }
    const f = await saveFlock(db, stranger, { breed: 'ollama', name: 'theirs', baseUrl: 'http://o', tlsTrust: false })
    const r = await listFlockModels(registry, db, mine, f.id)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('not found')
  })

  test('a comfyui flock reports unsupported (models live in graphs)', async () => {
    const db = await freshDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'comfyui', name: 'c', baseUrl: 'http://c:8188', tlsTrust: false })
    const r = await listFlockModels(registry, db, actor, f.id)
    expect(r).toEqual({ ok: false, models: [], detail: 'unsupported' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/flock-health.test.ts`
Expected: FAIL — `listFlockModels` is not exported.

- [ ] **Step 3: Implement the server function**

In `apps/control-plane/src/server/flock-health.ts`, add imports and the function:

```ts
import { BreedRegistry, comfyuiBreed, ollamaBreed, type ModelListResult } from '@metamodels/connectors'
import type { Db } from './db'
import type { Actor } from '../auth/authorize'
import { listFlocks } from './flocks-service'
```

```ts
export async function listFlockModels(
  registry: BreedRegistry,
  db: Db,
  actor: Actor,
  flockId: string,
): Promise<ModelListResult> {
  const f = (await listFlocks(db, actor)).find((x) => x.id === flockId)
  if (!f) return { ok: false, models: [], detail: 'flock not found' }
  const breed = registry.get(f.breed)
  if (!breed.listModels) return { ok: false, models: [], detail: 'unsupported' }
  return breed.listModels({ baseUrl: f.baseUrl, upstreamAuth: f.upstreamAuth, tlsTrust: f.tlsTrust })
}
```

(Confirm `Db` is exported from `./db`; if the type is named differently there, import the type the other services use — grep `from './db'` in `apps/control-plane/src/server`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/flock-health.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the thin server action**

In `apps/control-plane/src/app/(app)/flocks/actions.ts`, add the import and action (the file already imports `requireUser`, `requireCapability`, `getDb`, and builds `registry`):

```ts
import { testFlockConnection, listFlockModels, buildBreedRegistry } from '../../../server/flock-health'
import type { ModelListResult } from '@metamodels/connectors'
```

```ts
export async function listFlockModelsAction(flockId: string): Promise<ModelListResult> {
  const actor = await requireUser()
  requireCapability(actor, 'read')
  return listFlockModels(registry, getDb(), actor, flockId)
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm -w exec tsc -b` → clean.

```bash
git add apps/control-plane/src/server/flock-health.ts apps/control-plane/src/server/flock-health.test.ts "apps/control-plane/src/app/(app)/flocks/actions.ts"
git commit -m "feat(control-plane): listFlockModels server fn + action (org-scoped read)"
```

---

### Task A3: model-allowlist helper + fence UI control

**Files:**
- Create: `apps/control-plane/src/lib/model-allowlist.ts`
- Test: `apps/control-plane/src/lib/model-allowlist.test.ts`
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/page.tsx` (thread `flockId` prop)
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx` (new control)

**Interfaces:**
- Consumes: `listFlockModelsAction(flockId)`, `ModelListResult`.
- Produces: `partitionAllowlist(saved, live)`, `serializeAllowlist(selected)`.

- [ ] **Step 1: Write the failing helper test**

Create `apps/control-plane/src/lib/model-allowlist.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { partitionAllowlist, serializeAllowlist } from './model-allowlist'

describe('partitionAllowlist', () => {
  test('splits saved names into those present on the server and manual extras', () => {
    const r = partitionAllowlist(['llama3.1:8b', 'not-pulled:70b'], ['llama3.1:8b', 'qwen2.5-coder:0.5b'])
    expect(r).toEqual({ present: ['llama3.1:8b'], manual: ['not-pulled:70b'] })
  })
  test('empty saved ⇒ nothing selected', () => {
    expect(partitionAllowlist([], ['a', 'b'])).toEqual({ present: [], manual: [] })
  })
})

describe('serializeAllowlist', () => {
  test('comma-joins, trims, de-duplicates, drops blanks', () => {
    expect(serializeAllowlist(['a', ' a ', 'b', ''])).toBe('a, b')
  })
  test('empty selection ⇒ empty string (⇒ "any model" on save)', () => {
    expect(serializeAllowlist([])).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/model-allowlist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/control-plane/src/lib/model-allowlist.ts`:

```ts
/** Split saved allowlist entries into those the server currently has ("present", shown as
 *  checked boxes) and those it does not ("manual", e.g. not pulled yet — shown as chips so
 *  a model can be pre-authorized before it exists on the box). */
export function partitionAllowlist(
  saved: string[],
  live: string[],
): { present: string[]; manual: string[] } {
  const liveSet = new Set(live)
  return {
    present: saved.filter((m) => liveSet.has(m)),
    manual: saved.filter((m) => !liveSet.has(m)),
  }
}

/** Serialize a selection to the comma-separated `models` field the save action parses.
 *  Order-stable, trimmed, de-duplicated; empty ⇒ '' which the action reads as "any model". */
export function serializeAllowlist(selected: string[]): string {
  return [...new Set(selected.map((s) => s.trim()).filter(Boolean))].join(', ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/model-allowlist.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Thread `flockId` into the fence page props**

In `apps/control-plane/src/app/(app)/paddocks/[id]/fence/page.tsx`, the page already computes the flock. Pass its id to the client. Change the `paddock` prop to include `flockId`:

```tsx
  const flockRow = flocks.find((f) => f.id === paddock.flockId)
  const breed = flockRow?.breed ?? 'ollama'
```

```tsx
      paddock={{ id: paddock.id, name: paddock.name, slug: paddock.slug, breed, flockId: paddock.flockId }}
```

- [ ] **Step 6: Build the model-allowlist control into `fence-client.tsx`**

Update the `paddock` prop type to include `flockId: string`. Replace the single free-text model input (the block around the `id="models"` `<Input>`) with a client control. It must keep a hidden field `name="models"` whose value is `serializeAllowlist(selected)`.

Add near the top of `fence-client.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { listFlockModelsAction } from '../../../flocks/actions'
import { partitionAllowlist, serializeAllowlist } from '../../../../../lib/model-allowlist'
```

(Verify the relative import depths against the file's location; adjust `../` counts to resolve to `app/(app)/flocks/actions` and `src/lib/model-allowlist`.)

Inside the component, before the return, add state seeded from the saved allowlist (`c.allowedModels ?? []`):

```tsx
  const savedModels = (c.allowedModels ?? []) as string[]
  const [live, setLive] = useState<string[] | null>(null)   // null = still loading
  const [failed, setFailed] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>(savedModels)
  const [manual, setManual] = useState<string[]>([])
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let alive = true
    listFlockModelsAction(paddock.flockId).then((r) => {
      if (!alive) return
      if (r.ok) {
        setLive(r.models)
        const { manual } = partitionAllowlist(savedModels, r.models)
        setManual(manual)
      } else {
        setFailed(r.detail ?? 'unreachable')
      }
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paddock.flockId])

  function toggle(model: string, on: boolean) {
    setSelected((s) => (on ? [...new Set([...s, model])] : s.filter((m) => m !== model)))
  }
  function addManual() {
    const name = draft.trim()
    if (!name) return
    setManual((m) => [...new Set([...m, name])])
    setSelected((s) => [...new Set([...s, name])])
    setDraft('')
  }
```

Render, replacing the old model `<Input>` block:

```tsx
          <div className="mt-4">
            <Label>Model allowlist</Label>
            <input type="hidden" name="models" value={serializeAllowlist(selected)} />
            {failed ? (
              // Escape hatch: upstream unreachable — never block editing the fence.
              <div>
                <Input
                  name="modelsFallback"
                  defaultValue={savedModels.join(', ')}
                  placeholder="llama3, mistral"
                  onChange={(e) =>
                    setSelected(e.target.value.split(',').map((m) => m.trim()).filter(Boolean))
                  }
                />
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  Couldn’t reach {paddock.name}’s server ({failed}). Enter model names manually,
                  comma-separated. Blank = any model.
                </p>
              </div>
            ) : live === null ? (
              <p className="text-sm text-[var(--color-muted)]">Loading models…</p>
            ) : (
              <div className="flex flex-col gap-2">
                {live.length === 0 && (
                  <p className="text-xs text-[var(--color-muted)]">No models found on the server.</p>
                )}
                {live.map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(m)}
                      onChange={(e) => toggle(m, e.target.checked)}
                    />
                    <span className="font-mono">{m}</span>
                  </label>
                ))}
                {manual.map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm text-[var(--color-comfyui)]">
                    <input
                      type="checkbox"
                      checked={selected.includes(m)}
                      onChange={(e) => toggle(m, e.target.checked)}
                    />
                    <span className="font-mono">{m}</span>
                    <span className="text-xs">(not on server)</span>
                  </label>
                ))}
                <div className="flex gap-2">
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="add another (e.g. mistral:7b)"
                  />
                  <Button type="button" variant="ghost" onClick={addManual}>Add</Button>
                </div>
                <p className="text-xs text-[var(--color-muted)]">Blank selection = any model.</p>
              </div>
            )}
          </div>
```

- [ ] **Step 7: Build the control-plane image and verify in a real browser**

```bash
cd /home/carmelo/Projects/metamodels
docker compose up -d --build control-plane
```

Then, with the stack up (login `admin@example.com` / `change-me` at `http://localhost:3200`): open a paddock bound to an Ollama flock → **Fence**. Confirm the model list loads from the real box (checkboxes for `qwen2.5-coder:0.5b` etc.), check one, add a manual name, Save, reopen, and confirm the selection round-tripped. Confirm no CSP violations in the console. (This UI wiring has no vitest test by design — it is verified here and in Task A4.)

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm -w exec tsc -b` → clean.

```bash
git add apps/control-plane/src/lib/model-allowlist.ts apps/control-plane/src/lib/model-allowlist.test.ts "apps/control-plane/src/app/(app)/paddocks/[id]/fence/page.tsx" "apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx"
git commit -m "feat(fence): live Ollama model picker with free-text escape hatch"
```

---

### Task A4: update the e2e walkthrough to drive the picker

**Files:**
- Modify: `apps/e2e/specs/acceptance.spec.ts` (step 4)

**Interfaces:**
- Consumes: the running stack + real Ollama (`OLLAMA_TEST_URL`).

- [ ] **Step 1: Update step 4 to select from the live list**

In `apps/e2e/specs/acceptance.spec.ts`, in test "4. fence it…", replace the free-text fill:

```ts
    await page.getByLabel('Model allowlist (comma-separated; blank = any)').fill(OLLAMA_MODEL)
```

with selecting the model's live checkbox (the list is fetched from the real flock):

```ts
    // The model list is fetched live from the flock; wait for our model's checkbox, then tick it.
    const modelBox = page.getByRole('checkbox', { name: OLLAMA_MODEL })
    await expect(modelBox).toBeVisible({ timeout: 20_000 })
    await modelBox.check()
```

- [ ] **Step 2: Run the full walkthrough against the real stack**

```bash
cd /home/carmelo/Projects/metamodels/apps/e2e
E2E_BASE_URL=http://localhost:3200 OLLAMA_TEST_URL=http://192.168.1.140:11434 OLLAMA_TEST_MODEL=qwen2.5-coder:0.5b pnpm exec playwright test
```

Expected: **8/8 pass** — step 4 now proves the picker works end to end, and step 6 still proves the fence (built via the picker) is enforced (allowed 200, disallowed 403, `/api/pull` 403, no-key 401, burst 429).

- [ ] **Step 3: Regenerate screenshots + clear leftover keys**

```bash
cd /home/carmelo/Projects/metamodels
docker compose exec -T postgres psql -U metamodels -d metamodels -c "DELETE FROM api_key WHERE name LIKE 'e2e-key-%';"
cd apps/e2e && rm -f ../../docs/screenshots/*.png
E2E_BASE_URL=http://localhost:3200 OLLAMA_TEST_URL=http://192.168.1.140:11434 pnpm exec playwright test
```

Confirm `docs/screenshots/04-fence-policy.png` now shows the checkbox picker, and the key is still masked in `05-*`.

- [ ] **Step 4: Commit**

```bash
git add apps/e2e/specs/acceptance.spec.ts docs/screenshots
git commit -m "test(e2e): drive the live model picker in the fence walkthrough"
```

---

# GROUP B — GHCR images + Portainer deploy

### Task B1: `runtime` Docker stage

**Files:**
- Modify: `docker/Dockerfile` (add `runtime` stage)

**Interfaces:**
- Produces: build targets `control-plane` (existing) and `runtime` (new), both buildable standalone.

- [ ] **Step 1: Add the stage**

Append to `docker/Dockerfile`:

```dockerfile
# --- runtime: all workspace TS source + tsx in one image. The deploy compose runs
#     data-plane / worker / migrate from it via per-service working_dir + command. ---
FROM deps AS runtime
WORKDIR /app
ENV NODE_ENV=production
```

- [ ] **Step 2: Build both images locally (real build, our system)**

```bash
cd /home/carmelo/Projects/metamodels
docker build -f docker/Dockerfile --target control-plane -t ghcr.io/carmelosantana/metamodels-control-plane:local .
docker build -f docker/Dockerfile --target runtime -t ghcr.io/carmelosantana/metamodels-runtime:local .
```

Expected: both builds succeed (exit 0).

- [ ] **Step 3: Verify the runtime image can actually run a tsx app**

```bash
docker run --rm -w /app/apps/migrate ghcr.io/carmelosantana/metamodels-runtime:local pnpm exec tsx --version
docker run --rm -w /app/apps/data-plane ghcr.io/carmelosantana/metamodels-runtime:local node -e "require('fs').accessSync('src/server.ts'); console.log('data-plane source present')"
```

Expected: a tsx version prints; `data-plane source present` prints. Proves one image carries every tsx app's source.

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile
git commit -m "build(docker): add generic runtime stage for registry images"
```

---

### Task B2: `docker-compose.deploy.yml`

**Files:**
- Create: `docker-compose.deploy.yml`

**Interfaces:**
- Consumes: the two images from B1 (`ghcr.io/carmelosantana/metamodels-{control-plane,runtime}:${TAG}`).

- [ ] **Step 1: Write the deploy compose**

Create `docker-compose.deploy.yml` (mirror the service env + health-gating of `docker-compose.yml`, but with `image:` and per-service commands — every `environment:` block lists its vars explicitly):

```yaml
# Portainer deploy stack: pulls pre-built GHCR images. Set stack env (DATABASE_URL, REDIS_URL,
# SESSION_SECRET, LICENSE_KEY_SECRET, OPERATOR_EMAIL, OPERATOR_PASSWORD) and TAG in Portainer.
services:
  postgres:
    image: postgres:16-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55
    environment:
      POSTGRES_USER: metamodels
      POSTGRES_PASSWORD: metamodels
      POSTGRES_DB: metamodels
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "metamodels", "-d", "metamodels"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-bookworm@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  migrate:
    image: ghcr.io/carmelosantana/metamodels-runtime:${TAG:-latest}
    working_dir: /app/apps/migrate
    command: ["pnpm", "start"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      postgres:
        condition: service_healthy

  control-plane:
    image: ghcr.io/carmelosantana/metamodels-control-plane:${TAG:-latest}
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      SESSION_SECRET: ${SESSION_SECRET}
      LICENSE_KEY_SECRET: ${LICENSE_KEY_SECRET}
      OPERATOR_EMAIL: ${OPERATOR_EMAIL}
      OPERATOR_PASSWORD: ${OPERATOR_PASSWORD}
      NODE_ENV: production
    ports:
      - "${CONTROL_PLANE_PORT:-3000}:3000"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5

  data-plane:
    image: ghcr.io/carmelosantana/metamodels-runtime:${TAG:-latest}
    working_dir: /app/apps/data-plane
    command: ["pnpm", "start"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      PORT: ${PORT:-8787}
    ports:
      - "${DATA_PLANE_PORT:-8787}:8787"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    image: ghcr.io/carmelosantana/metamodels-runtime:${TAG:-latest}
    working_dir: /app/apps/worker
    command: ["pnpm", "start"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      WORKER_NAME: ${WORKER_NAME:-worker-1}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  scheduler:
    image: ghcr.io/carmelosantana/metamodels-control-plane:${TAG:-latest}
    command: ["pnpm", "scheduler"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      LICENSE_KEY_SECRET: ${LICENSE_KEY_SECRET}
      SCHEDULER_INTERVAL_MS: ${SCHEDULER_INTERVAL_MS:-43200000}
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully

volumes:
  pgdata:
```

- [ ] **Step 2: Validate the compose parses**

```bash
cd /home/carmelo/Projects/metamodels
cp .env.example .env.deploy 2>/dev/null || true
TAG=local docker compose --env-file .env -f docker-compose.deploy.yml config -q && echo "compose OK"
```

Expected: `compose OK` (no schema/interpolation errors).

- [ ] **Step 3: Real boot against locally-built images (our system)**

Uses the `:local` images from B1 so nothing needs GHCR yet. Run on non-default ports to avoid the already-running dev stack:

```bash
cd /home/carmelo/Projects/metamodels
TAG=local CONTROL_PLANE_PORT=3210 DATA_PLANE_PORT=8797 \
  docker compose --env-file .env -p mm-deploy -f docker-compose.deploy.yml up -d
sleep 20
docker compose -p mm-deploy -f docker-compose.deploy.yml ps
curl -s -o /dev/null -w 'deploy UI -> %{http_code}\n' http://localhost:3210/login
curl -s http://localhost:8797/healthz
docker compose -p mm-deploy -f docker-compose.deploy.yml logs scheduler | tail -2
```

Expected: all services up/healthy, UI → 307/200, `/healthz` → `{"status":"ok"}`, scheduler logs its interval line.

- [ ] **Step 4: Tear the deploy stack down (keep the dev stack)**

```bash
docker compose -p mm-deploy -f docker-compose.deploy.yml down -v
rm -f .env.deploy
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.deploy.yml
git commit -m "build(deploy): Portainer docker-compose.deploy.yml pulling GHCR images"
```

---

### Task B3: GHCR release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Produces: images at `ghcr.io/carmelosantana/metamodels-{control-plane,runtime}` on `v*` tags (semver + `latest`) and `main` (`edge`).

- [ ] **Step 1: Resolve and pin action SHAs**

Each third-party action must be pinned to a 40-char commit SHA (repo policy; zizmor enforces it). Resolve the current release commit for each with `gh` and record it:

```bash
for a in docker/login-action docker/metadata-action docker/build-push-action docker/setup-buildx-action actions/attest-build-provenance; do
  tag=$(gh api repos/$a/releases/latest --jq .tag_name)
  sha=$(gh api repos/$a/git/refs/tags/$tag --jq '.object.sha // empty')
  [ -z "$sha" ] && sha=$(gh api repos/$a/commits/$tag --jq .sha)
  echo "$a  $tag  $sha"
done
```

Reuse the already-pinned `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (v4) from the existing workflows. Substitute the resolved SHAs into the `uses:` lines below (the `# vX` comment records the human-readable tag).

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: release

on:
  push:
    tags: ['v*']
    branches: [main]

# Least privilege. packages:write to push to GHCR; id-token + attestations for provenance.
permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  images:
    name: images
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      packages: write
      id-token: write
      attestations: write
    strategy:
      matrix:
        include:
          - target: control-plane
            image: ghcr.io/carmelosantana/metamodels-control-plane
          - target: runtime
            image: ghcr.io/carmelosantana/metamodels-runtime
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          persist-credentials: false
      - uses: docker/setup-buildx-action@<SHA> # v3
      - uses: docker/login-action@<SHA> # v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@<SHA> # v5
        with:
          images: ${{ matrix.image }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=raw,value=edge,enable={{is_default_branch}}
            type=sha
      - id: build
        uses: docker/build-push-action@<SHA> # v6
        with:
          context: .
          file: docker/Dockerfile
          target: ${{ matrix.target }}
          platforms: linux/amd64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          provenance: true
      - uses: actions/attest-build-provenance@<SHA> # v1
        with:
          subject-name: ${{ matrix.image }}
          subject-digest: ${{ steps.build.outputs.digest }}
          push-to-registry: true
```

- [ ] **Step 3: Lint the workflow with zizmor**

```bash
cd /home/carmelo/Projects/metamodels
docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/zizmorcore/zizmor:latest --pedantic .github/workflows/
```

Expected: "No findings to report." If `unpinned-uses` fires, a `<SHA>` was left unresolved — fix Step 1.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): publish control-plane + runtime images to GHCR on tag/main"
```

---

### Task B4: deploy docs + release runbook

**Files:**
- Modify: `docs/DEPLOY.md` (Portainer section)
- Create: `docs/RELEASING.md`
- Modify: `README.md` (one deploy line)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the Portainer section to DEPLOY.md**

Append to `docs/DEPLOY.md`:

```markdown
## Deploy on Portainer (pre-built images)

MetaModels publishes two public images to GHCR:
`ghcr.io/carmelosantana/metamodels-control-plane` and `…-runtime`. A Portainer stack pulls
them — no source checkout, no local build.

1. **Stacks → Add stack → Web editor**, paste `docker-compose.deploy.yml` from the repo.
2. Set the stack **environment variables**: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`,
   `LICENSE_KEY_SECRET`, `OPERATOR_EMAIL`, `OPERATOR_PASSWORD`, and `TAG` (pin `v0.1.0`;
   `latest` tracks the newest release, `edge` the latest `main`). Portainer injects these for
   both compose interpolation and the containers.
3. **Deploy the stack.** The one-shot `migrate` service runs first; the apps start after.
4. **Seed the first operator once** — in Portainer, open the `control-plane` container console
   (or `docker exec`) and run `pnpm seed`. Uses `OPERATOR_EMAIL` / `OPERATOR_PASSWORD`.
5. Open the UI on `CONTROL_PLANE_PORT` (default 3000). Point Flock upstream URLs at your
   Ollama/ComfyUI via `http://host.docker.internal:11434` etc.

Images are single-arch `linux/amd64` and carry build-provenance attestations
(`gh attestation verify`).
```

- [ ] **Step 2: Write the release runbook**

Create `docs/RELEASING.md`:

```markdown
# Releasing MetaModels

Images publish automatically from `.github/workflows/release.yml`.

- **Every push to `main`** → `…:edge` (for test deploys between releases).
- **A pushed tag `vX.Y.Z`** → `…:X.Y.Z`, `…:X.Y`, and `…:latest`.

## Cut a release

1. Ensure `main` is green (CI) and the lock-down reviews are clean.
2. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. Watch the `release` workflow publish both images to GHCR.
4. In Portainer, set the stack’s `TAG=v0.1.0` and redeploy to pull it.

The first release is **v0.1.0** — pre-1.0 while the API and schema may still move.
```

- [ ] **Step 3: One README line**

In `README.md`, under the run instructions, add:

```markdown
**Deploy on Portainer / a server:** pull pre-built images instead of building — see [docs/DEPLOY.md](docs/DEPLOY.md#deploy-on-portainer-pre-built-images) and [docs/RELEASING.md](docs/RELEASING.md).
```

- [ ] **Step 4: Verify env-drift guard still green**

`TAG`, `CONTROL_PLANE_PORT`, `DATA_PLANE_PORT`, `WORKER_NAME`, `SCHEDULER_INTERVAL_MS`, `PORT` are all compose-level or already documented; the deploy compose introduces no new `process.env.*` in source. Confirm:

```bash
cd /home/carmelo/Projects/metamodels && pnpm test 2>&1 | grep -E "env-example|Tests "
```

Expected: env-example completeness test passes; overall root lane green.

- [ ] **Step 5: Commit**

```bash
git add docs/DEPLOY.md docs/RELEASING.md README.md
git commit -m "docs(deploy): Portainer + GHCR release runbook"
```

---

## Final verification (whole branch, before review gate)

- [ ] `pnpm -w exec tsc -b` → clean
- [ ] `pnpm test` → root lane green (196+ pass; new connector + helper + server tests added)
- [ ] `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000` → control-plane lane green
- [ ] e2e: `cd apps/e2e && E2E_BASE_URL=http://localhost:3200 OLLAMA_TEST_URL=http://192.168.1.140:11434 pnpm exec playwright test` → 8/8
- [ ] `docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/zizmorcore/zizmor:latest --pedantic .github/workflows/` → clean
- [ ] `TAG=local docker compose --env-file .env -f docker-compose.deploy.yml config -q` → parses

Then hand off to the lock-down gate: `/security-review` → `/engineering:code-review` → `/supply-chain-risk-mitigation`, then tag `v0.1.0`.

---

## Self-review notes

- **Spec coverage:** A1 (listModels capability) ✓, A2 (action, org-scoped `read`) ✓, A3 (picker + escape hatch + never-block fallback) ✓, A4 (e2e) ✓; B1 (runtime stage → 2 images) ✓, B2 (deploy compose, explicit env, health-gated) ✓, B3 (GHCR workflow, tag+edge, SHA-pinned, attestations, cosign deferred) ✓, B4 (DEPLOY/RELEASING docs, v0.1.0) ✓. Out-of-scope items (ComfyUI models, multi-arch, cosign, private registry) intentionally absent.
- **Capability name** is `'read'` everywhere (not `resource.read`).
- **Type consistency:** `ModelListResult { ok; models; detail? }` defined in A1, consumed unchanged in A2/A3; `listFlockModels(registry, db, actor, flockId)` and `listFlockModelsAction(flockId)` signatures match across A2/A3; `partitionAllowlist`/`serializeAllowlist` names match across A3.
- **No new dependency**; UI verified via e2e + browser, not jsdom.
