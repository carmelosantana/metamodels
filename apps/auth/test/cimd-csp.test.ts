import { afterEach, describe, expect, test } from 'vitest'
import type { Provider } from 'oidc-provider'
import { mcpResource } from '@metamodels/schema'
import { cimdCspMiddleware } from '../src/cimd-csp.js'
import type { Preflight } from '../src/consent-api.js'
import { authCsp } from '../src/views.js'
import { seedUser } from './helpers/db.js'
import {
  authorize, CIMD_CLIENT_ID, CIMD_REDIRECT_URI, cimdDocument, CONSOLE_URL, DATA_PLANE_URL, startTestOp, type TestOp,
} from './helpers/flow.js'
import { quiet } from './helpers/quiet.js'
import * as schema from '@metamodels/schema'
import { eq } from 'drizzle-orm'

const T = 30_000
const STATIC = authCsp([CONSOLE_URL])
const WIDENED = authCsp([CONSOLE_URL, new URL(CIMD_REDIRECT_URI).origin])
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

async function mcpOp(preflight: Preflight = { allowed: true }) {
  op = await startTestOp({
    cimdDocuments: { [CIMD_CLIENT_ID]: cimdDocument() },
    providerOptions: { consentApi: { preflight: async () => preflight, mint: async () => ({ ok: false, kind: 'error', detail: 'unused' }) } },
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

  test('the refusal screen a viewer sees allows the same form-action, so Close can hand back', async () => {
    await mcpOp({ allowed: false, reason: 'Your role cannot approve apps.' })
    const refused = await authorize(op!, { ...mcpRequest, email: 'm@x.io', password: 'hunter2hunter2' })
    if (refused.kind !== 'page') throw new Error('expected the refusal screen')
    expect(refused.body).toContain('You cannot approve this app')
    expect(refused.csp).toBe(WIDENED)
  }, T)

  test('the switch-account step, reached from the consent screen\'s link, allows the same form-action', async () => {
    await mcpOp()
    await seedUser(op!.db, { email: 'b@x.io', password: 'hunter3hunter3', role: 'member' })
    const consent = await authorize(op!, { ...mcpRequest, email: 'm@x.io', password: 'hunter2hunter2' })
    if (consent.kind !== 'page') throw new Error('expected the consent screen')
    expect(consent.body).toContain('prompt=login+consent')
    // The link's own request: the same authorization request with prompt=login consent, as the other account.
    const switched = await authorize(op!, {
      ...mcpRequest, jar: consent.jar, email: 'b@x.io', password: 'hunter3hunter3',
      extra: { ...mcpRequest.extra, prompt: 'login consent' },
    })
    if (switched.kind !== 'page') throw new Error('expected the switch-account step')
    expect(switched.body).toContain('<h1>Switch account?</h1>')
    expect(switched.csp).toBe(WIDENED)
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

describe('cimdCspMiddleware when a lookup fails (follow-up ruling F4)', () => {
  const cimdClient = { clientIdMetadataDocument: true, redirectUriAllowed: (u: string) => u === CIMD_REDIRECT_URI }
  const interaction = { params: { client_id: CIMD_CLIENT_ID, redirect_uri: CIMD_REDIRECT_URI } }

  /** Just the provider surface the middleware reads. */
  function fakeProvider(o: { interaction?: () => Promise<unknown>; client?: () => Promise<unknown> } = {}): Provider {
    return {
      Interaction: { find: o.interaction ?? (async () => interaction) },
      Client: { find: o.client ?? (async () => cimdClient) },
    } as unknown as Provider
  }

  /** Run the middleware over an HTML interaction page; the CSP it set, if any. */
  async function cspAfter(provider: Provider): Promise<string | undefined> {
    const headers = new Map<string, string>()
    const ctx = {
      path: '/interaction/abc123',
      response: { is: (t: string) => (t === 'html' ? 'html' : false) },
      set: (k: string, v: string) => { headers.set(k, v) },
    }
    await cimdCspMiddleware({ provider, consoleOrigin: CONSOLE_URL })(ctx as never, async () => {})
    return headers.get('Content-Security-Policy')
  }

  test('with both lookups answering, the fake reaches the widening', async () => {
    expect(await cspAfter(fakeProvider())).toBe(WIDENED)
  })

  test('Interaction.find failing leaves the static policy in place, logs why, and does not throw', async () => {
    const warn = quiet('warn')
    expect(await cspAfter(fakeProvider({ interaction: async () => { throw new Error('adapter down') } }))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[auth] form-action not widened for /interaction/abc123: adapter down')
  })

  test('Client.find failing does the same', async () => {
    const warn = quiet('warn')
    expect(await cspAfter(fakeProvider({ client: async () => { throw new Error('document refetch failed') } }))).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[auth] form-action not widened for /interaction/abc123: document refetch failed')
  })
})
