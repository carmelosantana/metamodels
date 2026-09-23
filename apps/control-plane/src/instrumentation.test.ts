import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test, vi } from 'vitest'

// `seal-keys` caches the keyring, so each case needs a fresh module graph.
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Runs `register()` in a real Node process the way Next 16 does at boot: no injected exit, and a
 * rejection is caught and logged while the server keeps listening (measured: "Failed to prepare
 * server", then 500s). The timer stands in for that listener, so only a real exit ends the child
 * before it prints BOOTED.
 */
async function bootInChild(env: Record<string, string>) {
  const code = [
    "const { register } = await import('./src/instrumentation.ts')",
    "await register().catch((e) => console.error('Failed to prepare server', e?.message))",
    "setTimeout(() => console.log('BOOTED'), 300)",
  ].join('; ')
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code],
      { cwd: appDir, env: { ...process.env, NEXT_RUNTIME: 'nodejs', UPSTREAM_AUTH_PREVIOUS_KEYS: '', ...env }, timeout: 20_000 },
    )
    return { exitCode: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { exitCode: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }
  }
}

describe('register (Next.js instrumentation — runs once at server boot)', () => {
  // Next swallows a rejected register() into an unhandledRejection and keeps serving 500s, so a
  // rejection alone is NOT a refusal to boot. The process has to exit; this proves it does.
  test('a real process with no UPSTREAM_AUTH_KEY exits 1 and names the variable', async () => {
    const r = await bootInChild({ UPSTREAM_AUTH_KEY: '' })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).not.toContain('BOOTED')
    expect(r.stderr).toMatch(/UPSTREAM_AUTH_KEY/)
  }, 30_000)

  test('a real process with a malformed previous key exits 1, without echoing it', async () => {
    const r = await bootInChild({ UPSTREAM_AUTH_KEY: randomBytes(32).toString('base64'), UPSTREAM_AUTH_PREVIOUS_KEYS: 'not-a-key-XYZ' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toMatch(/UPSTREAM_AUTH_PREVIOUS_KEYS/)
    expect(r.stderr).not.toContain('not-a-key-XYZ')
  }, 30_000)

  test('a real process with a valid key boots', async () => {
    const r = await bootInChild({ UPSTREAM_AUTH_KEY: randomBytes(32).toString('base64') })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('BOOTED')
  }, 30_000)

  test('in-process: a bad key calls exit(1) rather than rejecting into the void', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('UPSTREAM_AUTH_KEY', '')
    const exit = vi.fn()
    const { register } = await import('./instrumentation')
    await register(exit as unknown as (code: number) => never)
    expect(exit).toHaveBeenCalledWith(1)
  })

  test('does nothing on the edge runtime, which never touches credentials', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    vi.stubEnv('UPSTREAM_AUTH_KEY', '')
    const exit = vi.fn()
    const { register } = await import('./instrumentation')
    await register(exit as unknown as (code: number) => never)
    expect(exit).not.toHaveBeenCalled()
  })
})
