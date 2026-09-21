import { expect, test } from 'vitest'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuthConfig } from '../src/config.js'
import { oidcPayload } from '@metamodels/schema'
import { pgAdapterFactory } from '../src/adapter.js'
import { startAuthServer } from '../src/server.js'
import { makeDb } from './helpers/db.js'

function testConfig(): AuthConfig {
  return {
    issuer: 'http://127.0.0.1:1',
    consoleUrl: 'http://console.test',
    consoleClientSecret: 'console-secret-0123456789',
    cookieKeys: ['cookie-key-0123456789abcdef'],
    signingKeyPem: null,
    allowEphemeralKey: true,
    databaseUrl: 'unused-db-is-injected',
    port: 0,
  }
}

async function close(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
}

test('serves the provider on the configured port and shuts down cleanly', async () => {
  const server = startAuthServer(testConfig(), await makeDb())
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  expect(res.status).toBe(200)
  await close(server)
}, 20_000)

test('sweeps expired rows at startup, not only after the first hourly interval', async () => {
  const db = await makeDb()
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const factory = pgAdapterFactory(db, () => anHourAgo)
  await factory('Session').upsert('stale', { kind: 'Session' }, 60)
  await factory('Session').upsert('live', { kind: 'Session' }, 24 * 60 * 60)

  const server = startAuthServer(testConfig(), db)
  await once(server, 'listening')
  const ids = async () => (await db.select({ id: oidcPayload.id }).from(oidcPayload)).map((r) => r.id)
  const deadline = Date.now() + 5_000
  while ((await ids()).includes('stale') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  expect(await ids()).toEqual(['live'])
  await close(server)
}, 20_000)
