import { afterEach, describe, expect, test } from 'vitest'
import type { ClientMetadata } from 'oidc-provider'
import { adminApiResource, CLI_CLIENT_ID, CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { seedUser } from './helpers/db.js'
import {
  approveDevice, CONSOLE_SECRET, CONSOLE_URL, deviceAuthorization, deviceToken, refreshGrant, startTestOp,
  type DeviceAuthorization, type TestOp,
} from './helpers/flow.js'

/**
 * RFC 7009 token revocation, so `mm logout` can end its session at the OP rather than only forget
 * the token locally. Only the refresh token matters here: access tokens are JWTs, which the OP
 * cannot revoke (the admin API verifies them offline), and which expire within the hour.
 */

const T = 30_000
const ADMIN = adminApiResource(CONSOLE_URL)
let op: TestOp | undefined
afterEach(async () => {
  await op?.close()
  op = undefined
})

/** Another public device-grant client: a stand-in for any second client presenting the CLI's token. */
const OTHER_PUBLIC: ClientMetadata = {
  client_id: 'other-public-client',
  token_endpoint_auth_method: 'none',
  grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
  response_types: [],
  redirect_uris: [],
  application_type: 'native',
}

async function cliRefreshToken(): Promise<string> {
  op = await startTestOp({ extraClients: [OTHER_PUBLIC] })
  await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
  const auth = await deviceAuthorization(op, { scope: 'openid offline_access read', resource: ADMIN })
  await approveDevice(op, auth.json as unknown as DeviceAuthorization, { email: 'admin@x.io', password: 'hunter2hunter2' })
  const token = await deviceToken(op, String(auth.json.device_code), { resource: ADMIN })
  expect(token.status).toBe(200)
  return String(token.json.refresh_token)
}

async function revoke(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${op!.issuer}/token/revocation`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  return { status: res.status, text: await res.text() }
}

describe('token revocation', () => {
  test('is advertised in discovery, on this issuer', async () => {
    op = await startTestOp()
    const meta = await (await fetch(`${op.issuer}/.well-known/openid-configuration`)).json()
    expect(meta.revocation_endpoint).toBe(`${op.issuer}/token/revocation`)
  }, T)

  test('the CLI revokes its own refresh token, as a public client, and that token is then refused', async () => {
    const first = await cliRefreshToken()
    // The same refresh request works before revocation...
    const used = await refreshGrant(op!, first, { resource: ADMIN })
    expect(used.status).toBe(200)
    const current = String(used.json.refresh_token)

    const res = await revoke({ token: current, token_type_hint: 'refresh_token', client_id: CLI_CLIENT_ID })
    expect(res.status).toBe(200)

    // ...and is refused after it.
    const after = await refreshGrant(op!, current, { resource: ADMIN })
    expect(after.status).toBe(400)
    expect(after.json.error).toBe('invalid_grant')
  }, T)

  test('another public client cannot revoke the CLI\'s token: answered 200, token untouched', async () => {
    const token = await cliRefreshToken()
    const res = await revoke({ token, token_type_hint: 'refresh_token', client_id: OTHER_PUBLIC.client_id })
    // RFC 7009 §2.2: the same answer as a real revocation, so the endpoint is no token oracle.
    expect(res.status).toBe(200)
    const still = await refreshGrant(op!, token, { resource: ADMIN })
    expect(still.status).toBe(200)
    expect(typeof still.json.access_token).toBe('string')
  }, T)

  test('the console, properly authenticated, cannot revoke the CLI\'s token either', async () => {
    const token = await cliRefreshToken()
    const basic = Buffer.from(`${CONSOLE_CLIENT_ID}:${CONSOLE_SECRET}`).toString('base64')
    const res = await revoke({ token, token_type_hint: 'refresh_token' }, { authorization: `Basic ${basic}` })
    expect(res.status).toBe(200)
    const still = await refreshGrant(op!, token, { resource: ADMIN })
    expect(still.status).toBe(200)
    expect(typeof still.json.access_token).toBe('string')
  }, T)
})
