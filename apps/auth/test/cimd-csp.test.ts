import { afterEach, describe, expect, test } from 'vitest'
import { mcpResource } from '@metamodels/schema'
import { authCsp } from '../src/views.js'
import { seedUser } from './helpers/db.js'
import {
  authorize, CIMD_CLIENT_ID, CIMD_REDIRECT_URI, cimdDocument, CONSOLE_URL, DATA_PLANE_URL, startTestOp, type TestOp,
} from './helpers/flow.js'
import * as schema from '@metamodels/schema'
import { eq } from 'drizzle-orm'

const T = 30_000
const STATIC = authCsp([CONSOLE_URL])
const WIDENED = authCsp([CONSOLE_URL, new URL(CIMD_REDIRECT_URI).origin])
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

async function mcpOp() {
  op = await startTestOp({
    cimdDocuments: { [CIMD_CLIENT_ID]: cimdDocument() },
    providerOptions: { consentApi: { preflight: async () => ({ allowed: true }), mint: async () => ({ ok: false, kind: 'error', detail: 'unused' }) } },
    extraClients: [{
      client_id: 'third-party', client_secret: 'third-party-secret-0123', redirect_uris: ['http://third.test/cb'],
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic',
    }],
  })
  const userId = await seedUser(op.db, { email: 'm@x.io', password: 'hunter2hunter2', role: 'member' })
  const [u] = await op.db.select().from(schema.user).where(eq(schema.user.id, userId))
  const [f] = await op.db.insert(schema.flock).values({ orgId: u.orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  await op.db.insert(schema.paddock).values({ orgId: u.orgId, flockId: f.id, slug: 'small', name: 'Small models' })
}

const mcpRequest = { clientId: CIMD_CLIENT_ID, redirectUri: CIMD_REDIRECT_URI, scope: 'openid mcp', extra: { resource: mcpResource(DATA_PLANE_URL, 'small') } }

describe('cimdCspMiddleware (M4 D5)', () => {
  test('a CIMD client\'s login page and consent screen allow form-action to its redirect origin', async () => {
    await mcpOp()
    const login = await authorize(op!, mcpRequest)
    if (login.kind !== 'page') throw new Error('expected the login page')
    expect(login.csp).toBe(WIDENED)
    const consent = await authorize(op!, { ...mcpRequest, email: 'm@x.io', password: 'hunter2hunter2' })
    if (consent.kind !== 'page') throw new Error('expected the consent screen')
    expect(consent.body).toContain('Connect an app to MetaModels?')
    expect(consent.csp).toBe(WIDENED)
    // Only form-action moved: every other directive is the static policy's.
    expect(consent.csp!.split('; ').filter((d) => !d.startsWith('form-action')))
      .toEqual(STATIC.split('; ').filter((d) => !d.startsWith('form-action')))
  }, T)

  test('the console, a static third-party client and the health check keep the static policy', async () => {
    await mcpOp()
    const consoleLogin = await authorize(op!, {})
    if (consoleLogin.kind !== 'page') throw new Error('expected the console login page')
    expect(consoleLogin.csp).toBe(STATIC)
    const thirdParty = await authorize(op!, { clientId: 'third-party', redirectUri: 'http://third.test/cb' })
    if (thirdParty.kind !== 'page') throw new Error('expected the third party\'s login page')
    expect(thirdParty.csp).toBe(STATIC)
    expect((await fetch(`${op!.issuer}/healthz`)).headers.get('content-security-policy')).toBe(STATIC)
  }, T)
})
