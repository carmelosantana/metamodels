import { type Locator, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREENSHOT_DIR } from './env.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', '..', SCREENSHOT_DIR)

/**
 * Capture a documentation screenshot.
 *
 * These are committed and shown in the README, so they must be stable across runs and must
 * never contain a credential. `mask` paints over the given locators before the shot is
 * taken — use it for anything secret-shaped.
 */
export async function shot(page: Page, name: string, opts: { mask?: Locator[] } = {}) {
  // Fonts and any entry transition need to settle, or the same page yields a
  // slightly different image on each run.
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    mask: opts.mask,
    maskColor: '#1f2430',
    animations: 'disabled',
  })
}
