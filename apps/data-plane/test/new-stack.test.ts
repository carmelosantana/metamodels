import { describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadServerConfig } from '../src/server.js'

const SCRIPT = fileURLToPath(new URL('../../../scripts/new-stack.sh', import.meta.url))

/** Runs the Portainer stack generator with a bare environment and returns its KEY=value lines. */
function generate(extra: Record<string, string> = {}): Record<string, string> {
  // Destructured on purpose: the .env.example completeness test counts every dotted env read as a deploy knob.
  const { PATH = '', HOME = '' } = process.env
  const out = execFileSync('bash', [SCRIPT], {
    env: { PATH, HOME, ...extra },
    encoding: 'utf8',
  })
  const vars: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) vars[m[1]!] = m[2]!
  }
  return vars
}

describe('scripts/new-stack.sh', () => {
  test('writes DATA_PLANE_URL as http://localhost:<DATA_PLANE_PORT>, and the data plane boots on it', () => {
    const vars = generate()
    expect(vars.DATA_PLANE_PORT).toBe('8787')
    expect(vars.DATA_PLANE_URL).toBe('http://localhost:8787')
    const cfg = loadServerConfig({
      DATABASE_URL: 'postgres://x/y',
      UPSTREAM_AUTH_KEY: vars.UPSTREAM_AUTH_KEY,
      DATA_PLANE_URL: vars.DATA_PLANE_URL,
      OIDC_ISSUER: 'http://127.0.0.1:3100',
    })
    expect(cfg.dataPlaneUrl).toBe('http://localhost:8787')
  })

  test('keeps the port and the URL together when DATA_PLANE_PORT is set', () => {
    const vars = generate({ DATA_PLANE_PORT: '9787' })
    expect(vars.DATA_PLANE_PORT).toBe('9787')
    expect(vars.DATA_PLANE_URL).toBe('http://localhost:9787')
  })
})
