import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { jwtVerify } from 'jose'
import { and, eq } from 'drizzle-orm'
import { adminApiResource, CLI_CLIENT_ID, oidcPayload } from '@metamodels/schema'
import { main } from '../../cli/src/commands.js'
import { credentialsPath, readCredentials } from '../../cli/src/credentials.js'
import {
  deviceLogin, refresh, revokeRefreshToken, SignInAgainError, type OpDeps,
} from '../../cli/src/device.js'
import { seedUser } from './helpers/db.js'
import {
  approveDevice, CONSOLE_URL, CookieJar, opJwks, startTestOp, type DeviceAuthorization, type TestOp,
} from './helpers/flow.js'

/**
 * The admin CLI's OP calls (`apps/cli/src/device.ts`, and `mm login` through `main`) against this
 * real OP, not a stub: the parameters the CLI's own tests pin are the ones that actually get a
 * resource-bound JWT here, and a revocation ends exactly the sign-in it names.
 */

const T = 30_000
const ADMIN = adminApiResource(CONSOLE_URL)
let op: TestOp | undefined
afterEach(async () => {
  await op?.close()
  op = undefined
})

/** The grant a refresh token belongs to, as stored by the OP (an opaque token's value is its id). */
async function grantOf(refreshToken: string): Promise<string | null> {
  const [row] = await op!.db.select().from(oidcPayload)
    .where(and(eq(oidcPayload.model, 'RefreshToken'), eq(oidcPayload.id, refreshToken)))
  expect(row).toBeDefined()
  return row.grantId
}

/** `deviceLogin` deps that approve the login in `jar`'s browser while the CLI waits for its first poll. */
function approvingIn(jar: CookieJar): OpDeps {
  let started: DeviceAuthorization | undefined
  let approved = false
  return {
    fetch: async (input, init) => {
      const res = await fetch(input, init)
      if (String(input).endsWith('/device/auth')) started = (await res.clone().json()) as DeviceAuthorization
      return res
    },
    print: () => {},
    sleep: async () => {
      if (approved) return
      approved = true
      const pages = await approveDevice(op!, started!, { email: 'admin@x.io', password: 'hunter2hunter2', jar })
      expect(pages.final.body).toContain('<h1>Signed in</h1>')
    },
  }
}

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

  // RFC 8628: each device authorization is its own. A browser session that already approved one
  // CLI still gets a new grant for the next, so signing one machine out leaves the other signed in.
  test('two logins approved from one browser get separate grants: revoking the first\'s refresh token leaves the second\'s working', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const issuer = op.issuer
    // One browser for both approvals: its session holds the grant of the first.
    const jar = new CookieJar()
    const login = () => deviceLogin({ issuer, resource: ADMIN, scopes: ['read'] }, approvingIn(jar))
    const first = await login()
    const second = await login()
    expect(await grantOf(second.refreshToken!)).not.toBe(await grantOf(first.refreshToken!))
    // One grant per approval, each saved once at consent: none left empty along the way.
    expect(await op.db.$count(oidcPayload, eq(oidcPayload.model, 'Grant'))).toBe(2)

    // The first machine's chain outlives the second approval...
    const firstRenewed = await refresh({ issuer, resource: ADMIN, refreshToken: first.refreshToken! })
    // ...and signing it out ends only its own.
    expect(await revokeRefreshToken({ issuer, refreshToken: firstRenewed.refreshToken! })).toBe(true)
    const renewed = await refresh({ issuer, resource: ADMIN, refreshToken: second.refreshToken! })
    expect(renewed.refreshToken).not.toBe(second.refreshToken)
    await expect(refresh({ issuer, resource: ADMIN, refreshToken: firstRenewed.refreshToken! }))
      .rejects.toThrow(/invalid_grant/)
  }, T)

  test('`mm login` again in the same browser revokes the sign-in it replaces, and the new one keeps working', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const issuer = op.issuer
    // CONSOLE_URL is plain http to a host that is not loopback, hence the opt-in.
    const env = {
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'mm-cli-')),
      METAMODELS_ISSUER: issuer, METAMODELS_CONSOLE_URL: CONSOLE_URL, METAMODELS_ALLOW_INSECURE_HTTP: '1',
    }
    const path = credentialsPath(env)
    const jar = new CookieJar()
    const err: string[] = []
    const mmLogin = () => main(['login'], { env, stdout: () => {}, stderr: (s) => { err.push(s) }, op: approvingIn(jar) })

    expect(await mmLogin()).toBe(0)
    const replaced = readCredentials(path, issuer)!.refreshToken!
    expect(await mmLogin()).toBe(0)
    const current = readCredentials(path, issuer)!.refreshToken!
    expect(current).not.toBe(replaced)
    expect(err.join('')).not.toMatch(/could not revoke/)

    // The replaced token was revoked at the OP; the new sign-in was not.
    await expect(refresh({ issuer, resource: ADMIN, refreshToken: replaced })).rejects.toThrow(/invalid_grant/)
    const renewed = await refresh({ issuer, resource: ADMIN, refreshToken: current })
    expect(renewed.refreshToken).not.toBe(current)
  }, T)
})

