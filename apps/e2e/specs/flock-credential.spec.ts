import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type Page } from '@playwright/test'
import { RUN_ID } from './helpers/env.js'
import { login, watchForViolations } from './helpers/console.js'

/**
 * A flock's stored upstream credential, from the console: Replace, Remove and Test (scoping spec
 * D4), and the rebind refusal when a stored credential would follow a changed base URL.
 *
 * The spec runs its own fake upstream, which records the `Authorization` header of every request.
 * That is how it proves what was actually stored and sent: the console never shows the credential,
 * so the only place to observe it is the flock itself.
 *
 * `E2E_UPSTREAM_HOST` opts in. It is this machine as the **control-plane container** reaches it,
 * such as the compose network's gateway address. The spec writes to the stack, so point it at a
 * throwaway one.
 */
const UPSTREAM_HOST = process.env.E2E_UPSTREAM_HOST
test.skip(!UPSTREAM_HOST, 'E2E_UPSTREAM_HOST is not set — no way for the stack to reach the fake upstream')
test.describe.configure({ mode: 'serial' })

const FLOCK = `e2e-cred-${RUN_ID}`
const FIRST = `first-${RUN_ID}`
const SECOND = `second-${RUN_ID}`
const REJECTED = `rejected-${RUN_ID}`

/** Every request the fake upstream received: its path, and the Authorization header or null. */
const seen: Array<{ path: string; auth: string | null }> = []
let upstream: Server
let base = ''

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    const auth = req.headers.authorization ?? null
    seen.push({ path: req.url ?? '', auth })
    res.writeHead(auth ? 200 : 401, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '0.0.0.0', resolve))
  base = `http://${UPSTREAM_HOST}:${(upstream.address() as AddressInfo).port}`
})

test.afterAll(async ({ browser }) => {
  upstream?.close()
  const page = await browser.newPage()
  try {
    await login(page)
    await page.goto('/flocks')
    const row = flockRow(page)
    if (await row.count()) await row.getByRole('button', { name: 'Delete' }).click()
  } catch {
    // Leftover fixtures are cosmetic; never fail the run over them.
  } finally {
    await page.close()
  }
})

let violations: string[] = []
test.beforeEach(async ({ page }) => {
  violations = watchForViolations(page)
  await login(page)
  await page.goto('/flocks')
})
test.afterEach(async () => {
  expect(violations, 'the console must render with no CSP violations or page errors').toEqual([])
})

function flockRow(page: Page) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: FLOCK, exact: true }) })
}

/** Runs the row's Test and returns what the upstream received for it. */
async function rowTest(page: Page) {
  const before = seen.length
  await flockRow(page).getByRole('button', { name: 'Test', exact: true }).click()
  await expect.poll(() => seen.length).toBeGreaterThan(before)
  return seen[seen.length - 1]
}

/** The console's server-rendered HTML, fetched with this page's session. */
async function flocksHtml(page: Page) {
  return (await page.request.get('/flocks')).text()
}

test('connect a flock: Test sends the typed token, and after saving the row shows only that one is stored', async ({ page }) => {
  await page.getByRole('button', { name: 'Connect a flock' }).click()
  await page.getByLabel('Name').fill(FLOCK)
  await page.getByLabel('Base URL').fill(base)
  await page.getByLabel('Upstream bearer token (optional)').fill(FIRST)
  // Before saving, Test sends what is typed: nothing is stored yet.
  const before = seen.length
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Connection OK')).toBeVisible()
  expect(seen.slice(before)).toEqual([{ path: '/api/version', auth: `Bearer ${FIRST}` }])
  await expect(page.getByLabel('Name')).toHaveValue(FLOCK)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(flockRow(page).getByRole('cell', { name: 'Stored' })).toBeVisible()
  expect(await flocksHtml(page)).not.toContain(FIRST)
})

test('Test probes the stored URL with the stored credential, opened on the server', async ({ page }) => {
  expect(await rowTest(page)).toEqual({ path: '/api/version', auth: `Bearer ${FIRST}` })
  await expect(flockRow(page).getByText('Connection OK')).toBeVisible()
})

test('keeping the credential while moving the flock is warned about, then refused in the console\'s words', async ({ page }) => {
  await flockRow(page).getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByRole('radio', { name: 'Keep' })).toBeChecked()
  await page.getByLabel('Base URL').fill(`${base}/moved`)
  await expect(page.getByText('needs the token re-entered')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Re-enter the upstream credential to change the base URL or to trust self-signed TLS.')).toBeVisible()
  await page.goto('/flocks')
  await expect(flockRow(page).getByRole('cell', { name: base, exact: true })).toBeVisible()
})

test('a replacement with a scheme prefix is refused, the refusal does not quote it, and the old one stays', async ({ page }) => {
  await flockRow(page).getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('radio', { name: 'Replace' }).check()
  await page.getByLabel('New upstream bearer token').fill(`Bearer ${REJECTED}`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const refusal = page.getByText('Paste the token only')
  await expect(refusal).toBeVisible()
  expect(await refusal.textContent()).not.toContain(REJECTED)
  await page.goto('/flocks')
  expect((await rowTest(page)).auth).toBe(`Bearer ${FIRST}`)
})

test('the choice survives a Test: Replace, then Test, then Save stores the typed token', async ({ page }) => {
  await flockRow(page).getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('radio', { name: 'Replace' }).check()
  await page.getByLabel('New upstream bearer token').fill(SECOND)
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Connection OK')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Replace' })).toBeChecked()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Edit flock' })).toHaveCount(0)
  expect((await rowTest(page)).auth).toBe(`Bearer ${SECOND}`)
})

test('Replace alongside a new base URL stores the new token for the new URL', async ({ page }) => {
  await flockRow(page).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Base URL').fill(`${base}/moved`)
  await page.getByRole('radio', { name: 'Replace' }).check()
  await page.getByLabel('New upstream bearer token').fill(SECOND)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(flockRow(page).getByRole('cell', { name: `${base}/moved`, exact: true })).toBeVisible()
  expect(await rowTest(page)).toEqual({ path: '/moved/api/version', auth: `Bearer ${SECOND}` })
  const html = await flocksHtml(page)
  expect(html).not.toContain(FIRST)
  expect(html).not.toContain(SECOND)
})

test('the choice survives a Test: Remove, then Test, still removes on save', async ({ page }) => {
  await flockRow(page).getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('radio', { name: 'Remove' }).check()
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByText('Failed:')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Remove' })).toBeChecked()
  await page.getByRole('button', { name: 'Remove token and save' }).click()
  await expect(flockRow(page).getByRole('cell', { name: '—' })).toBeVisible()
})

test('put a credential back for the next step', async ({ page }) => {
  await flockRow(page).getByRole('button', { name: 'Edit' }).click()
  await page.getByLabel('Upstream bearer token (optional)').fill(SECOND)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(flockRow(page).getByRole('cell', { name: 'Stored' })).toBeVisible()
})

test('Remove asks for a deliberate second click, then clears the credential', async ({ page }) => {
  await flockRow(page).getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('radio', { name: 'Remove' }).check()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Remove token and save' }).click()
  await expect(flockRow(page).getByRole('cell', { name: '—' })).toBeVisible()
  expect((await rowTest(page)).auth).toBeNull()
  await expect(flockRow(page).getByText('Failed:')).toBeVisible()
})
