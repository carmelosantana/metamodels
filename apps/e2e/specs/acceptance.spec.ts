import { test, expect, type Page } from '@playwright/test'
import {
  OLLAMA_URL,
  OLLAMA_MODEL,
  PROXY_URL,
  RUN_ID,
  skipReason,
} from './helpers/env.js'
import { login, watchForViolations } from './helpers/console.js'
import { shot } from './helpers/shot.js'

/**
 * The v1 acceptance walkthrough.
 *
 * Drives the operator console exactly as a human would — connect a flock, publish a fenced
 * paddock, mint a key — and then proves that the resulting policy is actually enforced by
 * calling the data plane as a consumer would, over HTTP, with no test seam involved. The
 * screenshots it captures are the project's documentation.
 *
 * Requires a running stack (`docker compose up -d`) and a reachable upstream. Skips rather
 * than fails when `OLLAMA_TEST_URL` is unset.
 */
test.skip(!!skipReason, skipReason ?? '')
test.describe.configure({ mode: 'serial' })

const FLOCK_NAME = `e2e-ollama-${RUN_ID}`
const PADDOCK_NAME = `e2e-paddock-${RUN_ID}`
const PADDOCK_SLUG = `e2e-${RUN_ID}`
const KEY_NAME = `e2e-key-${RUN_ID}`
const RATE_MAX = 5
const RATE_WINDOW_SEC = 60

/** Carried between the ordered steps below. */
const state = { apiKey: '' }

/** Every consumer request in this walkthrough goes through the governed proxy. */
function proxyUrl(upstreamPath: string) {
  return `${PROXY_URL}/p/${PADDOCK_SLUG}${upstreamPath}`
}

let violations: string[] = []

/**
 * Remove fixtures a previous *failed* run left behind, so the console the walkthrough
 * documents is never cluttered with debris.
 *
 * Matches only this walkthrough's exact naming shape — `e2e-ollama-<6 chars>` and
 * `e2e-paddock-<6 chars>` — rather than a bare `e2e` prefix, so it cannot delete something
 * an operator named themselves.
 */
test.beforeAll(async ({ browser }) => {
  if (skipReason) return
  const page = await browser.newPage()
  try {
    await login(page)
    await sweep(page, '/paddocks', /^e2e-paddock-[a-z0-9]{6}$/, 'Delete')
    await sweep(page, '/flocks', /^e2e-ollama-[a-z0-9]{6}$/, 'Delete')
  } catch {
    // A dirty console is a cosmetic problem; never fail the run over it.
  } finally {
    await page.close()
  }
})

async function sweep(page: Page, url: string, pattern: RegExp, button: string) {
  // Re-query after each delete: removing a row invalidates the previous handles.
  for (let guard = 0; guard < 20; guard++) {
    await page.goto(url)
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: pattern }) }).first()
    if ((await row.count()) === 0) return
    await row.getByRole('button', { name: button }).click()
    await page.waitForLoadState('networkidle').catch(() => {})
  }
}

test.beforeEach(async ({ page }) => {
  violations = watchForViolations(page)
})

test.afterEach(async () => {
  expect(violations, 'the console must render with no CSP violations or page errors').toEqual([])
})

test.describe('v1 acceptance walkthrough', () => {
  test('1. operator signs in', async ({ page }) => {
    await login(page)
    await shot(page, '01-dashboard')
  })

  test('2. connect a flock to the upstream server', async ({ page }) => {
    await login(page)
    await page.goto('/flocks')
    await page.getByRole('button', { name: 'Connect a flock' }).click()

    await page.getByLabel('Breed').selectOption('ollama')
    await page.getByLabel('Name').fill(FLOCK_NAME)
    await page.getByLabel('Base URL').fill(OLLAMA_URL!)

    // Prove the console can actually reach the upstream before saving it. If this fails,
    // the address is wrong *from inside the data-plane container* — not from your shell.
    await page.getByRole('button', { name: 'Test connection' }).click()
    await expect(page.getByText('Connection OK')).toBeVisible()

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('cell', { name: FLOCK_NAME })).toBeVisible()
    await shot(page, '02-flock-connected')
  })

  test('3. publish a paddock on that flock', async ({ page }) => {
    await login(page)
    await page.goto('/paddocks')
    await page.getByRole('button', { name: 'New paddock' }).click()

    await page.getByLabel('Flock').selectOption({ label: `${FLOCK_NAME} (ollama)` })
    await page.getByLabel('Name').fill(PADDOCK_NAME)
    await page.getByLabel('Slug').fill(PADDOCK_SLUG)
    await page.getByRole('button', { name: 'Publish paddock' }).click()

    await expect(page.getByRole('cell', { name: PADDOCK_NAME })).toBeVisible()
    await shot(page, '03-paddock-published')
  })

  test('4. fence it: one route class, one model, a rate limit', async ({ page }) => {
    await login(page)
    await page.goto('/paddocks')
    // The fence link sits in this paddock's row, so scope to the row rather than
    // grabbing whichever "Fence" link happens to come first.
    await page
      .getByRole('row')
      .filter({ hasText: PADDOCK_NAME })
      .getByRole('link', { name: 'Fence' })
      .click()

    // Allow inference on /api/chat and nothing else. `mutate` is not offered at all —
    // model management is permanently unexposable.
    await page.getByRole('checkbox', { name: 'chat' }).check()
    await expect(page.getByRole('checkbox', { name: 'mutate' })).toBeDisabled()

    // The model list is fetched live from the flock; wait for our model's checkbox, then tick it.
    const modelBox = page.getByRole('checkbox', { name: OLLAMA_MODEL })
    await expect(modelBox).toBeVisible({ timeout: 20_000 })
    await modelBox.check()
    await page.getByLabel('Max requests').fill(String(RATE_MAX))
    await page.getByLabel('Per window (sec)').fill(String(RATE_WINDOW_SEC))
    await page.getByRole('button', { name: 'Save fence' }).click()

    // Blast Radius is the console's plain-language readback of the policy just saved.
    await expect(page.getByText(OLLAMA_MODEL, { exact: false }).first()).toBeVisible()
    await shot(page, '04-fence-policy')
  })

  test('5. mint a scoped API key', async ({ page }) => {
    await login(page)
    await page.goto('/keys')
    await page.getByRole('button', { name: 'Mint a key' }).click()

    await page.getByLabel('Name').fill(KEY_NAME)
    await page.getByLabel('Scope to paddocks').selectOption({ label: `${PADDOCK_NAME} (${PADDOCK_SLUG})` })
    await page.getByRole('button', { name: 'Create key' }).click()

    // Shown exactly once, at creation — the server only ever stores a prefix and a hash.
    const secret = page.locator('code').first()
    await expect(secret).toBeVisible()
    state.apiKey = ((await secret.textContent()) ?? '').trim()
    expect(state.apiKey).toMatch(/^mm_live_/)

    // The key is real; it must never be readable in a committed screenshot.
    await shot(page, '05-api-key-shown-once', { mask: [secret] })
  })

  test('6. the proxy enforces the fence', async ({ request }) => {
    expect(state.apiKey, 'step 5 must have produced a key').not.toBe('')
    const auth = { Authorization: `Bearer ${state.apiKey}` }

    await test.step('an allowed model on an allowed route reaches the real upstream', async () => {
      const res = await request.post(proxyUrl('/api/chat'), {
        headers: auth,
        data: {
          model: OLLAMA_MODEL,
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
          stream: false,
        },
        timeout: 90_000,
      })
      expect(res.status(), await res.text()).toBe(200)
      const body = await res.json()
      // Proves this went to a real model rather than a stub or a cache.
      expect(body.message?.content ?? '').not.toBe('')
      expect(body.model).toBe(OLLAMA_MODEL)
      // Ollama reports these only for a genuine generation; they are the evidence that a
      // model actually ran, and they are what the meter bills against.
      expect(body.eval_count, 'upstream must report generated tokens').toBeGreaterThan(0)
      await test.info().attach('upstream-reply', {
        body: JSON.stringify(
          { model: body.model, content: body.message?.content, eval_count: body.eval_count },
          null,
          2,
        ),
        contentType: 'application/json',
      })
    })

    await test.step('a model outside the allowlist is refused', async () => {
      const res = await request.post(proxyUrl('/api/chat'), {
        headers: auth,
        data: { model: 'definitely-not-allowed:70b', messages: [{ role: 'user', content: 'hi' }] },
      })
      expect(res.status()).toBe(403)
      expect((await res.json()).error).toContain('model not allowed')
    })

    await test.step('a model-management route is refused even though the key is valid', async () => {
      const res = await request.post(proxyUrl('/api/pull'), {
        headers: auth,
        data: { name: 'llama3' },
      })
      // `mutate` cannot be enabled in the UI at all; this is the enforcement behind it.
      expect(res.status()).toBe(403)
    })

    await test.step('a request with no key never reaches the upstream', async () => {
      const res = await request.post(proxyUrl('/api/chat'), {
        data: { model: OLLAMA_MODEL, messages: [] },
      })
      expect(res.status()).toBe(401)
    })

    await test.step('bursting past the rate limit returns 429', async () => {
      // Deliberately uses the rejected-model body: the limiter runs before the fence, so
      // these cost a token each without spending real inference time.
      const statuses: number[] = []
      for (let i = 0; i < RATE_MAX + 3; i++) {
        const res = await request.post(proxyUrl('/api/chat'), {
          headers: auth,
          data: { model: 'definitely-not-allowed:70b', messages: [] },
        })
        statuses.push(res.status())
      }
      expect(statuses, `expected a 429 among ${statuses.join(',')}`).toContain(429)
    })
  })

  test('7. usage is metered and visible to the operator', async ({ page }) => {
    await login(page)

    // The data plane emits meter events to Redis; the worker rolls them into usage_rollup
    // on its next drain. That is fast but not synchronous, so poll rather than assume.
    await expect(async () => {
      await page.goto('/usage')
      await expect(
        page.getByRole('row').filter({ hasText: `/p/${PADDOCK_SLUG}` }),
      ).toBeVisible()
    }).toPass({ timeout: 30_000, intervals: [1000, 2000, 3000] })

    const row = page.getByRole('row').filter({ hasText: `/p/${PADDOCK_SLUG}` })
    await expect(row).toContainText(KEY_NAME)

    // Read the metric cells specifically. Asserting a digit against the whole row would be
    // vacuous — the run id in the key name contains digits, so it would pass on zero usage.
    const cells = await row.getByRole('cell').allInnerTexts()
    const metrics = cells.slice(2).map((t) => Number(t.replace(/[^0-9.]/g, '')) || 0)
    expect(metrics.length, 'the usage table should expose the meter dimensions').toBeGreaterThan(0)
    expect(
      metrics.some((n) => n > 0),
      `real inference must have metered something, got [${metrics.join(', ')}]`,
    ).toBe(true)
    await shot(page, '06-usage-metered')
  })

  test('8. every configuration change is attributable in the audit log', async ({ page }) => {
    await login(page)
    await page.goto('/audit')

    // Each write this walkthrough performed should have produced its own action type.
    const actions = page.getByLabel('Action')
    for (const action of ['flock.create', 'paddock.create', 'fence.save', 'key.create']) {
      await expect(actions.locator(`option[value="${action}"]`)).toHaveCount(1)
    }

    // Narrow to paddock creations so the newest row is unambiguously this run's.
    await actions.selectOption('paddock.create')
    // Scoped to <main> to exclude the chrome's own buttons, and matched on `paddock:`
    // because hasText tests concatenated textContent — the visible gaps between a row's
    // spans are layout, not characters, so "create paddock:" would never match.
    const newest = page.locator('main').getByRole('button').filter({ hasText: 'paddock:' }).first()
    await expect(newest).toBeVisible()

    // The row header shows an opaque id; the slug lives in the recorded detail, which is
    // what makes the entry attributable to a human-recognisable resource.
    await newest.click()
    await expect(page.locator('pre').first()).toContainText(PADDOCK_SLUG)
    await expect(page.getByText('admin@example.com').first()).toBeVisible()
    await shot(page, '07-audit-log')
  })
})

/**
 * Best-effort teardown. Each removal is independent so a failure mid-walkthrough still
 * cleans up what did get created — this runs against a console with real operator data in
 * it, and must leave no `e2e-` fixtures behind.
 */
test.afterAll(async ({ browser }) => {
  if (skipReason) return
  const page = await browser.newPage()
  try {
    await login(page)
    // Independently, so one failure cannot strand the rest. Revoking a key leaves its row
    // in place by design (a revoked key stays auditable), so it is not a row removal —
    // treating it as one used to throw here and skip the deletions below it entirely.
    await settle(() => revokeKey(page))
    await settle(() => removeRow(page, '/paddocks', PADDOCK_NAME))
    await settle(() => removeRow(page, '/flocks', FLOCK_NAME))
  } finally {
    await page.close()
  }
})

/** Teardown must never turn a passing walkthrough red. */
async function settle(fn: () => Promise<void>) {
  await fn().catch(() => {})
}

async function revokeKey(page: Page) {
  await page.goto('/keys')
  const row = page.getByRole('row').filter({ hasText: KEY_NAME })
  if ((await row.count()) === 0) return
  const revoke = row.getByRole('button', { name: 'Revoke' })
  if ((await revoke.count()) === 0) return // already revoked
  await revoke.click()
  // The row persists; what changes is that the key can no longer be revoked again.
  await expect(row.getByRole('button', { name: 'Revoke' })).toHaveCount(0)
}

async function removeRow(page: Page, url: string, rowText: string) {
  await page.goto(url)
  const row = page.getByRole('row').filter({ hasText: rowText })
  if ((await row.count()) === 0) return
  await row.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('row').filter({ hasText: rowText })).toHaveCount(0)
}
