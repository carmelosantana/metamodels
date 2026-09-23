import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  credentialsPath, deleteCredentials, readCredentials, withCredentialsLock, writeCredentials, type StoredCredential,
} from '../src/credentials.js'

function tempStore(): string {
  return join(mkdtempSync(join(tmpdir(), 'mm-cli-')), 'metamodels', 'credentials.json')
}

function cred(issuer: string, accessToken: string, refreshToken?: string): StoredCredential {
  return {
    issuer, resource: `${issuer}/api/admin`, scope: 'read', accessToken, accessExpiresAt: 1, obtainedAt: 0,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('credentialsPath', () => {
  test('honours XDG_CONFIG_HOME', () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: '/x' } as never)).toBe('/x/metamodels/credentials.json')
  })
  test('falls back to ~/.config', () => {
    expect(credentialsPath({ HOME: '/home/op' } as never)).toBe('/home/op/.config/metamodels/credentials.json')
  })
  test('an empty XDG_CONFIG_HOME is unset, per the XDG spec', () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: '', HOME: '/home/op' } as never))
      .toBe('/home/op/.config/metamodels/credentials.json')
  })
  test('refuses to guess when neither is set', () => {
    expect(() => credentialsPath({} as never)).toThrow(/HOME/)
  })
})

describe('the store', () => {
  test('writes 0600 in a 0700 directory and round-trips, keyed by issuer', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    writeCredentials(p, cred('https://b.test', 'u', 'r'))
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(statSync(join(p, '..')).mode & 0o777).toBe(0o700)
    expect(readCredentials(p, 'https://a.test')!.accessToken).toBe('t')
    expect(readCredentials(p, 'https://b.test')).toEqual(cred('https://b.test', 'u', 'r'))
  })

  test('a write is atomic: it leaves no temp file beside the store, and the file stays 0600', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't1'))
    writeCredentials(p, cred('https://a.test', 't2'))
    expect(readdirSync(join(p, '..'))).toEqual(['credentials.json'])
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readCredentials(p, 'https://a.test')!.accessToken).toBe('t2')
  })

  test('refuses to read a group- or world-readable file', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    expect(readCredentials(p, 'https://a.test')!.accessToken).toBe('t')
    chmodSync(p, 0o644)
    expect(() => readCredentials(p, 'https://a.test')).toThrow(/0600/)
    chmodSync(p, 0o640)
    expect(() => readCredentials(p, 'https://a.test')).toThrow(/0600/)
  })

  test('refuses to write over a loose file, rather than trust what it holds', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    chmodSync(p, 0o604)
    expect(() => writeCredentials(p, cred('https://b.test', 'u'))).toThrow(/0600/)
  })

  test('refuses a file owned by another user', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    expect(readCredentials(p, 'https://a.test')!.accessToken).toBe('t')
    vi.spyOn(process as Required<NodeJS.Process>, 'getuid').mockReturnValue(statSync(p).uid + 1)
    expect(() => readCredentials(p, 'https://a.test')).toThrow(/owned by/)
  })

  test('a missing file is null, not an error', () => {
    expect(readCredentials('/nope/credentials.json', 'https://a.test')).toBeNull()
  })

  test('an issuer with no entry is null', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    expect(readCredentials(p, 'https://a.test')).not.toBeNull()
    expect(readCredentials(p, 'https://z.test')).toBeNull()
  })

  test('deleteCredentials removes one issuer and keeps the rest', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    writeCredentials(p, cred('https://b.test', 'u'))
    deleteCredentials(p, 'https://a.test')
    expect(readCredentials(p, 'https://a.test')).toBeNull()
    expect(readCredentials(p, 'https://b.test')!.accessToken).toBe('u')
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test('a malformed file is an error that names the path, not a crash on a field', () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    writeFileSync(p, 'not json')
    expect(() => readCredentials(p, 'https://a.test')).toThrow(p)
  })
})

describe('withCredentialsLock', () => {
  test('holds a lock file beside the store while the function runs, and removes it after', async () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    let heldDuring = false
    const out = await withCredentialsLock(p, async () => {
      heldDuring = existsSync(`${p}.lock`)
      return 42
    })
    expect(out).toBe(42)
    expect(heldDuring).toBe(true)
    expect(existsSync(`${p}.lock`)).toBe(false)
  })

  test('releases the lock when the function throws', async () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    await expect(withCredentialsLock(p, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(existsSync(`${p}.lock`)).toBe(false)
  })

  test('a second holder waits for the first', async () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    const order: string[] = []
    let waits = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const first = withCredentialsLock(p, async () => { order.push('a:in'); await gate; order.push('a:out') })
    await new Promise((r) => setTimeout(r, 20))
    const second = withCredentialsLock(p, async () => { order.push('b:in') }, { pollMs: 5, onWait: () => { waits++ } })
    await new Promise((r) => setTimeout(r, 60))
    expect(order).toEqual(['a:in'])
    expect(waits).toBeGreaterThan(0)
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['a:in', 'a:out', 'b:in'])
  })

  test('takes over a stale lock left by a crashed process', async () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    writeFileSync(`${p}.lock`, 'crashed')
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(`${p}.lock`, old, old)
    const out = await withCredentialsLock(p, async () => 'ran', { staleMs: 60_000, pollMs: 5 })
    expect(out).toBe('ran')
    expect(existsSync(`${p}.lock`)).toBe(false)
  })

  test('does not take over a fresh lock', async () => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    writeFileSync(`${p}.lock`, 'someone else')
    let ran = false
    const pending = withCredentialsLock(p, async () => { ran = true }, { staleMs: 60_000, pollMs: 5 })
    await new Promise((r) => setTimeout(r, 60))
    expect(ran).toBe(false)
    // The holder finishes: the waiter proceeds.
    const { unlinkSync } = await import('node:fs')
    unlinkSync(`${p}.lock`)
    await pending
    expect(ran).toBe(true)
  })

  // A lock path holding something other than a regular file is not a lock any process here took:
  // no amount of waiting or takeover clears it. Each case must end — with an error naming the path.
  test.each([
    ['a dangling symlink', (lock: string) => symlinkSync(join(lock, '..', 'nowhere'), lock)],
    ['a directory', (lock: string) => mkdirSync(lock)],
  ])('refuses, rather than spins on, %s at the lock path', async (_name, plant) => {
    const p = tempStore()
    writeCredentials(p, cred('https://a.test', 't'))
    plant(`${p}.lock`)
    let ran = false
    await expect(withCredentialsLock(p, async () => { ran = true }, { staleMs: 10, pollMs: 5 }))
      .rejects.toThrow(`${p}.lock is not a regular file`)
    expect(ran).toBe(false)
    // Left for the operator to look at, not deleted.
    expect(lstatSync(`${p}.lock`)).toBeDefined()
  }, 5_000)
})

