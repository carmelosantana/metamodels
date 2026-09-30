import { expect, type Browser } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchForViolations } from './console.js'

export interface Cli { code: number | null; stdout: string; stderr: string }
export interface Credential { resource: string; scope: string; accessToken: string; refreshToken?: string }

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cli')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The real `mm` CLI against one named stack. `homes` collects every temporary `XDG_CONFIG_HOME` made,
 * for the caller's cleanup: the operator's own `~/.config/metamodels` is never read or written.
 */
export function adminCli(stack: { consoleUrl: string; issuer: string; homes: string[] }) {
  function freshHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), 'mm-e2e-cli-'))
    stack.homes.push(home)
    return home
  }

  function credentialsFile(home: string): string {
    return path.join(home, 'metamodels', 'credentials.json')
  }

  function credential(home: string): Credential {
    const store = JSON.parse(readFileSync(credentialsFile(home), 'utf8')) as Record<string, Credential>
    const cred = store[stack.issuer]
    if (!cred) throw new Error(`no credential for ${stack.issuer} in ${credentialsFile(home)}`)
    return cred
  }

  /** The CLI exactly as an operator runs it (`pnpm --filter @metamodels/cli start`), minus pnpm. */
  function startCli(home: string, args: string[]) {
    const child = spawn(process.execPath, ['--import', './src/ts-resolve.ts', 'src/index.ts', ...args,
      '--issuer', stack.issuer, ...(args[0] === 'logout' ? [] : ['--console', stack.consoleUrl])], {
      cwd: CLI_DIR,
      env: { ...process.env, XDG_CONFIG_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = { stdout: '', stderr: '' }
    child.stdout.on('data', (b: Buffer) => { out.stdout += b.toString('utf8') })
    child.stderr.on('data', (b: Buffer) => { out.stderr += b.toString('utf8') })
    const done = new Promise<Cli>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, ...out }))
    })
    return { out, done }
  }

  async function cli(home: string, ...args: string[]): Promise<Cli> {
    return startCli(home, args).done
  }

  /** Runs a CLI command that must succeed and print JSON (or nothing). */
  async function cliJson(home: string, ...args: string[]): Promise<unknown> {
    const r = await cli(home, ...args)
    expect(r.code, `mm ${args.join(' ')} failed:\n${r.stderr}`).toBe(0)
    return r.stdout.trim() === '' ? null : JSON.parse(r.stdout)
  }

  /**
   * `mm login`, approved in a fresh browser context the way a person would: open the printed link,
   * check the code, check the requesting machine, Approve, then type the password (every device
   * approval asks for it). No CSP violation or page error is tolerated on any of those pages.
   */
  async function deviceLogin(browser: Browser, scope: string, email: string, password: string): Promise<string> {
    const home = freshHome()
    const run = startCli(home, ['login', '--scope', scope])

    let link = ''
    let userCode = ''
    await expect.poll(() => {
      link = /^\s+(https?:\/\/\S+)\s*$/m.exec(run.out.stderr)?.[1] ?? ''
      userCode = /shows the code\s+(\S+)/.exec(run.out.stderr)?.[1] ?? ''
      return link !== '' && userCode !== ''
    }, { message: 'the CLI never printed a verification link' }).toBe(true)
    expect(new URL(link).origin).toBe(new URL(stack.issuer).origin)

    const context = await browser.newContext()
    const page = await context.newPage()
    const problems = watchForViolations(page)
    try {
      await page.goto(link)
      await expect(page.getByRole('heading', { name: 'Connect the MetaModels CLI' })).toBeVisible()
      await page.getByRole('button', { name: 'Continue' }).click()

      await expect(page.getByRole('heading', { name: 'Approve this sign-in?' })).toBeVisible()
      await expect(page.locator('p.code')).toHaveText(userCode)
      // Where the request came from: the requester's address as the OP saw it, and its user agent,
      // which is the CLI's. The address cannot tell the CLI from this browser: on a compose stack
      // reached through its published ports, both arrive from the Docker bridge address. So this spec
      // only asserts that an address is shown, not whose it is.
      const device = page.locator('p.device')
      await expect(device).toContainText(/IP address: (?!unknown)\S+/)
      await expect(device).toContainText(/User agent: metamodels-cli \(/)
      await page.getByRole('button', { name: 'Approve' }).click()

      await expect(page).toHaveURL(new RegExp(`^${escapeRe(stack.issuer)}/interaction/`))
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password').fill(password)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible()
      expect(problems).toEqual([])
    } finally {
      await context.close()
    }

    const r = await run.done
    expect(r.code, `mm login failed:\n${r.stderr}`).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ issuer: stack.issuer, console: stack.consoleUrl })
    return home
  }

  return { freshHome, credentialsFile, credential, startCli, cli, cliJson, deviceLogin }
}
