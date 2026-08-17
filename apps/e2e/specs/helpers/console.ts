import { expect, type Page } from '@playwright/test'
import { OPERATOR_EMAIL, OPERATOR_PASSWORD } from './env.js'

/** Sign in as the seeded operator and land on the dashboard. */
export async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(OPERATOR_EMAIL)
  await page.getByLabel('Password').fill(OPERATOR_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The nav only exists once authenticated.
  await expect(page.getByRole('link', { name: 'Paddocks' })).toBeVisible()
}

/**
 * Collects CSP violations and page errors for the lifetime of the page.
 *
 * The console ships a nonce-based Content-Security-Policy, and a policy that silently
 * blocks a script degrades the UI without failing any assertion. Walking the whole app is
 * the cheapest place to notice, so the walkthrough watches while it goes.
 */
export function watchForViolations(page: Page): string[] {
  const problems: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (msg.type() === 'error' && /content security policy|refused to (load|execute|apply)/i.test(text)) {
      problems.push(`CSP: ${text}`)
    }
  })
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
  return problems
}
