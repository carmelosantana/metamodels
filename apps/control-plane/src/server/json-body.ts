import { z } from 'zod'

/**
 * The request body as a plain JSON object, or a `ZodError` — which `problemForError` already
 * answers 422, the status a malformed body deserves.
 *
 * A bare `await req.json()` in a handler is a 500 waiting to happen: a truncated body throws
 * `SyntaxError`, which matches no arm in `problemForError` and falls through to an opaque
 * `500 Internal Server Error` with no detail — telling a caller the server is broken when the
 * fault is entirely theirs and entirely fixable. A body of `null` is worse still, because it
 * parses cleanly and then throws `TypeError` at the first property read.
 *
 * So the shape is asserted here, once, rather than trusted in five route modules: `null`, arrays
 * and scalars are all valid JSON and none of them is a resource representation.
 */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    // The parser's own message is not echoed: it quotes the offending bytes back, and the body is
    // attacker-controlled input this API has no reason to reflect.
    throw new z.ZodError([{ code: 'custom', path: [], message: 'request body is not valid JSON' }])
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'request body must be a JSON object' }])
  }
  return body as Record<string, unknown>
}
