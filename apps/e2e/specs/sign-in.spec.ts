import { expect, test, type Page } from '@playwright/test'
import { watchForViolations } from './helpers/console.js'
import { AUTH_URL, CONTROL_PLANE_URL, OPERATOR_EMAIL, OPERATOR_PASSWORD } from './helpers/env.js'

/**
 * Sign-in through the auth service. Needs only the stack — no upstream model — so unlike the
 * acceptance walkthrough it never skips.
 */
test.describe.configure({ mode: 'serial' })

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ON_AUTH_FORM = new RegExp(`^${escapeRe(AUTH_URL)}/interaction/`)

async function consoleSession(page: Page) {
  return (await page.context().cookies(CONTROL_PLANE_URL)).find((c) => c.name === 'mm_session')
}

test('the console hands sign-in to the auth service and back, then signs out of both', async ({ page }) => {
  const problems = watchForViolations(page)

  await page.goto('/login')
  await expect(page).toHaveURL(ON_AUTH_FORM)
  await page.getByLabel('Email').fill(OPERATOR_EMAIL)
  await page.getByLabel('Password').fill(OPERATOR_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Back on the console, authenticated: the nav only renders for a signed-in operator.
  await expect(page.getByRole('link', { name: 'Paddocks' })).toBeVisible()
  expect(new URL(page.url()).origin).toBe(new URL(CONTROL_PLANE_URL).origin)
  const session = await consoleSession(page)
  expect(session?.httpOnly).toBe(true)
  expect(session?.sameSite).toBe('Lax')

  // RP-initiated logout: the console drops its session, then the OP asks to end its own.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign out of MetaModels?' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()

  // Signed out of the OP too: the console's /login bounces straight to a fresh password form
  // instead of silently signing back in.
  await expect(page).toHaveURL(ON_AUTH_FORM)
  await expect(page.getByLabel('Password')).toBeVisible()
  expect(await consoleSession(page)).toBeUndefined()

  // Both origins' policies held across every redirect, including form-action on the way out.
  expect(problems).toEqual([])
})

test('a wrong password stays on the auth service and mints no console session', async ({ page }) => {
  const problems = watchForViolations(page)

  await page.goto('/login')
  await page.getByLabel('Email').fill(OPERATOR_EMAIL)
  await page.getByLabel('Password').fill(`${OPERATOR_PASSWORD}-wrong`)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByText('Invalid email or password.')).toBeVisible()
  await expect(page).toHaveURL(ON_AUTH_FORM)
  expect(await consoleSession(page)).toBeUndefined()
  expect(problems).toEqual([])
})
