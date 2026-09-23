import { afterEach, describe, expect, test } from 'vitest'
import { jwtVerify } from 'jose'
import { adminApiResource, CLI_CLIENT_ID } from '@metamodels/schema'
import { deviceLogin, refresh, revokeRefreshToken, SignInAgainError } from '../../cli/src/device.js'
import { seedUser } from './helpers/db.js'
import {
  approveDevice, CONSOLE_URL, CookieJar, opJwks, startTestOp, type DeviceAuthorization, type TestOp,
} from './helpers/flow.js'

/**
 * The admin CLI's OP calls (`apps/cli/src/device.ts`) against this real OP, not a stub: the
 * parameters the CLI's own tests pin are the ones that actually get a resource-bound JWT here.
 */

const T = 30_000
const ADMIN = adminApiResource(CONSOLE_URL)
let op: TestOp | undefined
afterEach(async () => {
  await op?.close()
  op = undefined
})

describe('the CLI against the OP', () => {
  test('device login, refresh, revoke: JWTs for the admin API, rotation, and a dead token after logout', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const issuer = op.issuer

    // Capture the device authorization the CLI receives, and approve it in the "browser" while the
    // CLI waits for its first poll.
    let started: DeviceAuthorization | undefined
    let approved = false
    const capture: typeof fetch = async (input, init) => {
      const res = await fetch(input, init)
      if (String(input).endsWith('/device/auth')) started = (await res.clone().json()) as DeviceAuthorization
      return res
    }
    const cred = await deviceLogin({ issuer, resource: ADMIN, scopes: ['read', 'resource.write'] }, {
      fetch: capture,
      print: () => {},
      sleep: async () => {
        if (approved) return
        approved = true
        const pages = await approveDevice(op!, started!, { email: 'admin@x.io', password: 'hunter2hunter2' })
        expect(pages.final.body).toContain('<h1>Signed in</h1>')
      },
    })

    const jwks = await opJwks(op)
    const first = await jwtVerify(cred.accessToken, jwks, { issuer, audience: ADMIN, typ: 'at+jwt' })
    expect(first.payload.client_id).toBe(CLI_CLIENT_ID)
    expect(first.payload.scope).toBe('read resource.write')
    expect(cred.scope).toBe('read resource.write')
    expect(typeof cred.refreshToken).toBe('string')

    const next = await refresh({ issuer, resource: ADMIN, refreshToken: cred.refreshToken! })
    expect(next.refreshToken).not.toBe(cred.refreshToken)
    const second = await jwtVerify(next.accessToken, jwks, { issuer, audience: ADMIN, typ: 'at+jwt' })
    expect(second.payload.aud).toBe(ADMIN)

    expect(await revokeRefreshToken({ issuer, refreshToken: next.refreshToken! })).toBe(true)
    await expect(refresh({ issuer, resource: ADMIN, refreshToken: next.refreshToken! })).rejects.toBeInstanceOf(SignInAgainError)
  }, T)

  // Why `mm login` does not revoke the refresh token it replaces: oidc-provider's default
  // loadExistingGrant takes the grant the browser session already holds for the client, so two
  // device logins approved from one browser share one grant, and revocation ends the grant.
  test('two logins approved from one browser share a grant: revoking the first\'s refresh token ends the second\'s', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const issuer = op.issuer
    // One browser for both approvals: its session remembers the grant of the first.
    const jar = new CookieJar()
    const login = async () => {
      let started: DeviceAuthorization | undefined
      let approved = false
      const capture: typeof fetch = async (input, init) => {
        const res = await fetch(input, init)
        if (String(input).endsWith('/device/auth')) started = (await res.clone().json()) as DeviceAuthorization
        return res
      }
      return deviceLogin({ issuer, resource: ADMIN, scopes: ['read'] }, {
        fetch: capture,
        print: () => {},
        sleep: async () => {
          if (approved) return
          approved = true
          const pages = await approveDevice(op!, started!, { email: 'admin@x.io', password: 'hunter2hunter2', jar })
          expect(pages.final.body).toContain('<h1>Signed in</h1>')
        },
      })
    }
    const first = await login()
    const second = await login()
    expect(second.refreshToken).not.toBe(first.refreshToken)
    // The second login's token works before the first's is revoked...
    const renewed = await refresh({ issuer, resource: ADMIN, refreshToken: second.refreshToken! })
    expect(renewed.refreshToken).not.toBe(second.refreshToken)

    expect(await revokeRefreshToken({ issuer, refreshToken: first.refreshToken! })).toBe(true)
    // ...and not after.
    await expect(refresh({ issuer, resource: ADMIN, refreshToken: renewed.refreshToken! })).rejects.toBeInstanceOf(SignInAgainError)
  }, T)
})

