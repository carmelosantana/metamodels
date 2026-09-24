import { describe, expect, test } from 'vitest'
import { sharedDb, seedOrg, type TestDb } from '../test/db'
import { flockFormToInput } from '../lib/flock-form'
import { getFlockConnection, saveFlock } from './flocks-service'
import { saveFlockErrorMessage } from './flock-save-error'
import type { Actor } from '../auth/authorize'

/**
 * The console's edit drawer, end to end short of React: the form as the drawer posts it, through
 * `flockFormToInput` and `saveFlock`, and back out through `saveFlockErrorMessage` — the same three
 * calls `saveFlockAction` makes.
 */
const testDb = sharedDb()

async function actorFor(db: TestDb): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: 'admin@x.io', role: 'admin', credential: 'session' }
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

async function submit(db: TestDb, actor: Actor, fields: Record<string, string>) {
  try {
    return { flock: await saveFlock(db, actor, flockFormToInput(form(fields))) }
  } catch (e) {
    return { error: saveFlockErrorMessage(e) }
  }
}

async function storedFlock(db: TestDb, actor: Actor) {
  const f = await saveFlock(db, actor, { breed: 'ollama', name: 'f', baseUrl: 'http://a', tlsTrust: false, upstreamAuth: 'old-s3cr3t' })
  return { id: f.id, breed: 'ollama', name: 'f', baseUrl: 'http://a', tlsTrust: 'false' }
}

describe('the console edit drawer and a stored credential', () => {
  test('Keep, with nothing re-pointed, saves and leaves the credential as it was', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const edit = await storedFlock(db, actor)
    const r = await submit(db, actor, { ...edit, name: 'renamed', credential: 'keep' })
    expect(r.flock).toMatchObject({ name: 'renamed', hasUpstreamAuth: true })
    expect((await getFlockConnection(db, actor, edit.id)).upstreamAuth).toBe('old-s3cr3t')
  })

  test('Replace stores the new token', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const edit = await storedFlock(db, actor)
    await submit(db, actor, { ...edit, credential: 'replace', upstreamAuth: ' new-tok ' })
    expect((await getFlockConnection(db, actor, edit.id)).upstreamAuth).toBe('new-tok')
  })

  test('Remove clears it', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const edit = await storedFlock(db, actor)
    const r = await submit(db, actor, { ...edit, credential: 'remove' })
    expect(r.flock?.hasUpstreamAuth).toBe(false)
    expect((await getFlockConnection(db, actor, edit.id)).upstreamAuth).toBeNull()
  })

  test('Keep with a new base URL, or with TLS trust turned on, gets the console\'s rebind wording', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const edit = await storedFlock(db, actor)
    for (const change of [{ baseUrl: 'http://b' }, { tlsTrust: 'true' }]) {
      const r = await submit(db, actor, { ...edit, ...change, credential: 'keep' })
      expect(r.error).toBe('Re-enter the upstream credential to change the base URL or to trust self-signed TLS.')
    }
    expect((await getFlockConnection(db, actor, edit.id)).baseUrl).toBe('http://a')
  })

  test('Replace or Remove alongside a new base URL goes through', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const edit = await storedFlock(db, actor)
    expect((await submit(db, actor, { ...edit, baseUrl: 'http://b', credential: 'replace', upstreamAuth: 'tok-b' })).flock?.baseUrl).toBe('http://b')
    const conn = await getFlockConnection(db, actor, edit.id)
    expect(conn).toMatchObject({ baseUrl: 'http://b', upstreamAuth: 'tok-b' })
    const removed = await submit(db, actor, { ...edit, baseUrl: 'http://c', tlsTrust: 'true', credential: 'remove' })
    expect(removed.flock).toMatchObject({ baseUrl: 'http://c', hasUpstreamAuth: false })
  })

  test('a malformed replacement is refused, the old one kept, and the message never quotes it', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const edit = await storedFlock(db, actor)
    for (const bad of ['Bearer n3w-s3cr3t', 'n3w s3cr3t', 'n3w-s3cr3t\r\nx: y', '   ']) {
      const r = await submit(db, actor, { ...edit, credential: 'replace', upstreamAuth: bad })
      expect(r.error).toMatch(/^upstreamAuth: /)
      expect(r.error).not.toContain('s3cr3t')
    }
    expect((await getFlockConnection(db, actor, edit.id)).upstreamAuth).toBe('old-s3cr3t')
  })
})
