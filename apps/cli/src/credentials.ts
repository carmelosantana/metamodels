import { randomBytes } from 'node:crypto'
import {
  closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync,
  writeSync, type Stats,
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * One issuer's tokens. Keyed by issuer so several MetaModels boxes coexist in one file (spec §4.4).
 * `resource` is the admin-API resource the tokens are bound to: a refresh must name the same one,
 * and a refresh the OP refuses has already consumed its token (see `session.ts`), so a command
 * pointed at a different console must be stopped before it refreshes, not after.
 */
export interface StoredCredential {
  issuer: string
  resource: string
  /** The capability scopes the OP granted, space-separated, as the token response carried them. */
  scope: string
  accessToken: string
  /** Epoch milliseconds. */
  accessExpiresAt: number
  refreshToken?: string
  /** Epoch milliseconds. */
  obtainedAt: number
}

type Store = Record<string, StoredCredential>

/** `$XDG_CONFIG_HOME/metamodels/credentials.json`, else `~/.config/metamodels/credentials.json`. */
export function credentialsPath(env: NodeJS.ProcessEnv): string {
  // The XDG Base Directory spec: an empty value is treated as unset.
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'metamodels', 'credentials.json')
  if (env.HOME) return join(env.HOME, '.config', 'metamodels', 'credentials.json')
  throw new Error('cannot locate the credentials file: neither XDG_CONFIG_HOME nor HOME is set')
}

/**
 * The whole store, or `{}` when the file does not exist. Throws when the file is readable by
 * anyone but its owner, or owned by someone else: a credentials file anyone on the box can read is
 * a refresh token anyone on the box can use, and one another user owns is one they can swap.
 */
function readStore(path: string): Store {
  let mode: number
  let uid: number
  try {
    ;({ mode, uid } = statSync(path))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw e
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is readable or writable by other users (mode ${(mode & 0o777).toString(8)}); ` +
      'it must be 0600. Run `chmod 600` on it, or delete it and sign in again.',
    )
  }
  if (typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new Error(`${path} is owned by uid ${uid}, not by you; refusing to use it`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is not valid JSON; delete it and sign in again`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a credentials object; delete it and sign in again`)
  }
  return parsed as Store
}

/**
 * Replace the file in one step: a 0600 temp file in the same directory (so the rename cannot cross
 * a filesystem), flushed, then renamed over the target. A crash leaves either the old file or the
 * new one, never a torn one — which matters because a refresh has already consumed the old token by
 * the time its successor is written.
 */
function writeStore(path: string, store: Store): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.credentials.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    // Exact, whatever the umask: openSync's mode is masked by it, fchmod is not.
    fchmodSync(fd, 0o600)
    writeSync(fd, `${JSON.stringify(store, null, 2)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    renameSync(tmp, path)
  } catch (e) {
    try { closeSync(fd) } catch { /* already closed */ }
    try { unlinkSync(tmp) } catch { /* never created, or already renamed */ }
    throw e
  }
}

/** This issuer's credential, or null when there is none (or no file at all). Throws on a loose file. */
export function readCredentials(path: string, issuer: string): StoredCredential | null {
  return readStore(path)[issuer] ?? null
}

/** Store (or replace) this issuer's credential, keeping every other issuer's. */
export function writeCredentials(path: string, cred: StoredCredential): void {
  const store = readStore(path)
  store[cred.issuer] = cred
  writeStore(path, store)
}

/** Forget this issuer's credential, keeping every other issuer's. */
export function deleteCredentials(path: string, issuer: string): void {
  const store = readStore(path)
  if (!(issuer in store)) return
  delete store[issuer]
  writeStore(path, store)
}

export interface LockOptions {
  /**
   * A lock older than this is presumed left by a crashed process and taken over. It must exceed the
   * longest a holder can legitimately keep it: every OP request made under the lock carries a
   * timeout well inside this (see `device.ts`).
   */
  staleMs?: number
  pollMs?: number
  /** Called each time the lock is found held — for tests. */
  onWait?: () => void
}

export const LOCK_STALE_MS = 60_000

/**
 * Run `fn` holding an exclusive lock file beside the store (`<path>.lock`, created with `wx`), and
 * always release it. Zero-dependency and cross-process: two `mm` processes refreshing with the same
 * refresh token would present it twice, and the second presentation is a reuse that revokes the
 * whole grant.
 *
 * Stale-lock takeover is best effort: two waiters that judge the same stale lock in the same instant
 * can both proceed. The cost of losing that race is one "sign in again", never a leaked token.
 */
export async function withCredentialsLock<T>(path: string, fn: () => Promise<T>, o: LockOptions = {}): Promise<T> {
  const staleMs = o.staleMs ?? LOCK_STALE_MS
  const pollMs = o.pollMs ?? 100
  const lock = `${path}.lock`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let ours: number
  for (;;) {
    try {
      const fd = openSync(lock, 'wx', 0o600)
      try {
        writeSync(fd, `${process.pid}\n`)
        ours = fstatSync(fd).ino
      } finally {
        closeSync(fd)
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    // lstat, not stat: a symlink at the lock path is judged as itself, never as what it points to.
    let held: Stats
    try {
      held = lstatSync(lock)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // released between our open and our lstat
      throw e
    }
    if (!held.isFile()) {
      // Not a lock any `mm` took (it only ever creates regular files), so neither waiting nor a
      // takeover would clear it. Left in place for the operator to look at.
      throw new Error(`${lock} is not a regular file; remove it and run the command again`)
    }
    if (Date.now() - held.mtimeMs > staleMs) {
      // Remove the lock we judged stale, not one a faster waiter has since created. Compared by
      // inode, which a filesystem may reuse: best effort, as above.
      try { if (lstatSync(lock).ino === held.ino) unlinkSync(lock) } catch { /* already gone */ }
      continue
    }
    o.onWait?.()
    await new Promise((r) => setTimeout(r, pollMs))
  }
  try {
    return await fn()
  } finally {
    // If we overran staleMs and another process took the lock over, it is theirs now: leave it.
    try { if (lstatSync(lock).ino === ours) unlinkSync(lock) } catch { /* already gone */ }
  }
}
