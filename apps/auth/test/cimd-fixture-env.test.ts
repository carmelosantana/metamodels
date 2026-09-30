import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { cimdFixtureFromEnv } from '../src/cimd.js'
import { CIMD_CLIENT_ID, cimdDocument } from './helpers/flow.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fixtureFile(content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-cimd-'))
  dirs.push(dir)
  const file = path.join(dir, 'clients.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

describe('cimdFixtureFromEnv (M4 §7: e2e only)', () => {
  test('unset is no fixture', () => {
    expect(cimdFixtureFromEnv(undefined, true)).toBeUndefined()
    expect(cimdFixtureFromEnv('', false)).toBeUndefined()
  })

  test('refused outright unless ephemeral keys are allowed, i.e. never in a deployed stack', () => {
    expect(() => cimdFixtureFromEnv(fixtureFile([cimdDocument()]), false)).toThrow(/E2E_CIMD_DOCUMENTS.*OIDC_ALLOW_EPHEMERAL_KEY=true/)
  })

  test('serves each listed document by its client_id', async () => {
    const fetch = cimdFixtureFromEnv(fixtureFile([cimdDocument()]), true)!
    const res = await fetch(CIMD_CLIENT_ID, { method: 'GET' } as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ client_id: CIMD_CLIENT_ID })
  })

  test('a file that is not an array of documents with client_id is refused at boot', () => {
    expect(() => cimdFixtureFromEnv(fixtureFile({ client_id: 'x' }), true)).toThrow(/an array of Client ID Metadata Documents/)
    expect(() => cimdFixtureFromEnv(fixtureFile([{ client_name: 'no id' }]), true)).toThrow(/an array of Client ID Metadata Documents/)
  })
})
