import { expect, test } from 'vitest'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuthConfig } from '../src/config.js'
import { startAuthServer } from '../src/server.js'
import { makeDb } from './helpers/db.js'

test('serves the provider on the configured port and shuts down cleanly', async () => {
  const cfg: AuthConfig = {
    issuer: 'http://127.0.0.1:1',
    consoleUrl: 'http://console.test',
    consoleClientSecret: 'console-secret-0123456789',
    cookieKeys: ['cookie-key-0123456789abcdef'],
    signingKeyPem: null,
    allowEphemeralKey: true,
    databaseUrl: 'unused-db-is-injected',
    port: 0,
  }
  const server = startAuthServer(cfg, await makeDb())
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  expect(res.status).toBe(200)
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
}, 20_000)
