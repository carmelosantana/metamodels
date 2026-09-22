import { z } from 'zod'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

export interface PageOpts {
  limit: number
  cursor?: string
}

const limitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT)
const uuidSchema = z.string().uuid()

/** Rejects rather than clamps: silently returning fewer rows than asked for is a lie a client acts on. */
export function parsePageOpts(url: URL): PageOpts {
  const raw = url.searchParams.get('limit')
  const limit = raw === null ? DEFAULT_LIMIT : limitSchema.parse(raw)
  const cursor = url.searchParams.get('cursor') ?? undefined
  return cursor === undefined ? { limit } : { limit, cursor }
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new z.ZodError([{ code: 'custom', path: ['cursor'], message: 'cursor is malformed' }])
  }
  return uuidSchema.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
}

/**
 * RFC 8288 `Link`. Pagination metadata rides in a header so the body stays a bare array — which is
 * what makes every later response-shape change non-breaking (spec §3.1).
 */
export function linkHeader(url: URL, nextCursor: string | null): Record<string, string> {
  if (!nextCursor) return {}
  const next = new URL(url)
  next.searchParams.set('cursor', nextCursor)
  return { Link: `<${next.toString()}>; rel="next"` }
}
