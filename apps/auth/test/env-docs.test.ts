import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadAuthConfig } from '../src/config.js'

test('.env.example documents every variable the auth service reads', () => {
  const seen = new Set<string>()
  const valid: Record<string, string | undefined> = {
    OIDC_ISSUER: 'https://auth.example.test',
    CONSOLE_URL: 'https://console.example.test',
    CONSOLE_CLIENT_SECRET: 'x'.repeat(16),
    OIDC_COOKIE_KEYS: 'y'.repeat(16),
    OIDC_ALLOW_EPHEMERAL_KEY: 'true',
    DATABASE_URL: 'postgres://x',
  }
  const env = new Proxy(valid, {
    get(target, key: string) { seen.add(key); return target[key] },
  })
  loadAuthConfig(env)

  const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8')
  const documented = new Set(
    example.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0]),
  )
  expect(seen).toContain('OIDC_SIGNING_KEY') // proves the proxy saw the optional reads too
  expect([...seen].filter((k) => !documented.has(k)).sort()).toEqual([])
})
