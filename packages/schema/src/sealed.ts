import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Sealing for secrets the stack must be able to read back — today only `flock.upstream_auth_enc`,
 * the credential sent upstream to a flock. A hash will not do (the data plane has to replay it), so
 * it is AES-256-GCM under a dedicated key held by exactly the services that seal or open it:
 * control-plane, data-plane and migrate.
 *
 * Deliberately NOT `license-crypto.ts`'s scheme, though it is the same cipher:
 *  - a dedicated key, so the data plane never holds the licence secret and one leak is not both;
 *  - a key id in every envelope, so rotation is an overlap window (`UPSTREAM_AUTH_PREVIOUS_KEYS`,
 *    modelled on `OIDC_PREVIOUS_SIGNING_KEYS`) rather than a flag day, and a row sealed under a key
 *    this stack does not hold — a restore from a backup taken under another key — is reported as
 *    exactly that instead of as tampering;
 *  - HKDF with a purpose label rather than a bare SHA-256, so the same bytes reused for another
 *    purpose would not yield the same AES key;
 *  - a strict 32-byte key rather than any string of 16+ characters: a key is generated, not chosen.
 *
 * Envelope: `sealed:v1:<kid>:<iv>:<ciphertext>:<tag>`, each part base64url. The `sealed:v1:<kid>`
 * header is the GCM additional data, so it cannot be relabelled without failing authentication.
 */

const PREFIX = 'sealed:v1:'
const INFO = 'metamodels flock.upstream_auth v1'
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/
const ENVELOPE_RE = /^sealed:v1:([0-9a-f]{16}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]*):([A-Za-z0-9_-]{22})$/

export interface SealKey { readonly kid: string; readonly key: Buffer }
export interface SealKeyring {
  /** Seals every new value. */
  readonly current: SealKey
  /** Every key that may open a value: `current` plus the previous keys of an overlap window. */
  readonly byKid: ReadonlyMap<string, SealKey>
}

export type UnsealReason = 'malformed' | 'unknown-key' | 'tampered'

/** Why a value would not open. Never carries the value, the plaintext or any key material. */
export class UnsealError extends Error {
  constructor(readonly reason: UnsealReason, detail: string) {
    super(`cannot open sealed value: ${detail}`)
    this.name = 'UnsealError'
  }
}

/** One key: base64 of exactly 32 random bytes (`openssl rand -base64 32`). */
export function parseSealKey(b64: string, name = 'key'): SealKey {
  if (!KEY_RE.test(b64)) {
    throw new Error(`${name} must be base64 of exactly 32 bytes — generate one with: openssl rand -base64 32`)
  }
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(b64, 'base64'), Buffer.alloc(0), INFO, 32))
  // A hash of the derived key, not of the input: a 256-bit key cannot be recovered from it, and it
  // lets an envelope name its key without the operator having to label one.
  const kid = createHash('sha256').update('kid\0').update(key).digest('hex').slice(0, 16)
  return { kid, key }
}

export function loadSealKeyring(env: Record<string, string | undefined>): SealKeyring {
  const raw = env.UPSTREAM_AUTH_KEY
  if (!raw) {
    throw new Error('UPSTREAM_AUTH_KEY is required (base64 of 32 bytes: openssl rand -base64 32)')
  }
  const current = parseSealKey(raw, 'UPSTREAM_AUTH_KEY')
  const byKid = new Map<string, SealKey>([[current.kid, current]])
  const previous = (env.UPSTREAM_AUTH_PREVIOUS_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  previous.forEach((p, i) => {
    const key = parseSealKey(p, `UPSTREAM_AUTH_PREVIOUS_KEYS[${i}]`)
    // A repeat is a botched rotation edit, not a harmless duplicate: refuse it at boot, where it is
    // cheap to see, rather than let the overlap window quietly hold one key fewer than intended.
    if (byKid.has(key.kid)) throw new Error('UPSTREAM_AUTH_PREVIOUS_KEYS repeats a key already in the keyring')
    byKid.set(key.kid, key)
  })
  return { current, byKid }
}

export function isSealed(value: string): boolean {
  return ENVELOPE_RE.test(value)
}

export function seal(plaintext: string, ring: SealKeyring): string {
  const { kid, key } = ring.current
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${PREFIX}${kid}`, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const b = (buf: Buffer) => buf.toString('base64url')
  return `${PREFIX}${kid}:${b(iv)}:${b(ct)}:${b(cipher.getAuthTag())}`
}

export function openSealed(envelope: string, ring: SealKeyring): string {
  const m = ENVELOPE_RE.exec(envelope)
  if (!m) throw new UnsealError('malformed', 'not a sealed:v1 envelope')
  const [, kid, iv, ct, tag] = m
  const key = ring.byKid.get(kid)
  if (!key) throw new UnsealError('unknown-key', `sealed under key ${kid}, which this keyring does not hold`)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(`${PREFIX}${kid}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    throw new UnsealError('tampered', `envelope under key ${kid} failed authentication`)
  }
}

/** Legacy plaintext, or sealed under anything but the current key. */
export function needsReseal(value: string, ring: SealKeyring): boolean {
  const m = ENVELOPE_RE.exec(value)
  return !m || m[1] !== ring.current.kid
}
