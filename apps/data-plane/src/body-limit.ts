import type { Context, MiddlewareHandler } from 'hono'

/** Raised by the counted request body once it passes the limit; every read site answers `bodyTooLarge()`. */
export class BodyTooLarge extends Error {
  constructor() {
    super('request body too large')
    this.name = 'BodyTooLarge'
  }
}

export const bodyTooLarge = (c: Context): Response => c.json({ error: 'request body too large' }, 413)

/**
 * A lazy request body limit (follow-up ruling F2). A declared Content-Length over `maxSize` is refused
 * here, unread. Any other body is only wrapped: the handler's authentication runs before a byte is
 * consumed, and the read that crosses `maxSize` fails with `BodyTooLarge`, so an anonymous caller can
 * never make this process hold the body.
 */
export function limitRequestBody(maxSize: number): MiddlewareHandler {
  return async (c, next) => {
    const raw = c.req.raw
    if (!raw.body) return next()
    const declared = raw.headers.get('content-length')
    if (declared !== null && !raw.headers.has('transfer-encoding') && Number(declared) > maxSize) return bodyTooLarge(c)
    let seen = 0
    const counted = raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength
        if (seen > maxSize) throw new BodyTooLarge()
        ctl.enqueue(chunk)
      },
    }))
    c.req.raw = new Request(raw, { body: counted, duplex: 'half' } as RequestInit)
    await next()
  }
}
