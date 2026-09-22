import { z } from 'zod'

/** What an id IS in this API. One definition, so a cursor and a path segment cannot disagree. */
export const uuidSchema = z.string().uuid()

/**
 * A path segment that names a resource, or a `ZodError` — which `problemForError` already answers
 * 422, the status a syntactically invalid id deserves.
 *
 * `params.id` straight into a service is a 500 waiting to happen, in exactly the way a bare
 * `await req.json()` was (see `json-body.ts`): every `id` column is a uuid, so `GET /flocks/my-flock`
 * reaches Postgres as an invalid uuid literal and throws a driver error `problemForError` maps to
 * an opaque `500 Internal Server Error` with no detail — blaming the server for input the caller
 * can fix. Spec §2.1 makes problem+json the error contract; a detail-free 500 for client garbage is
 * not honouring it.
 *
 * **422 rather than 404**, deliberately. A 404 answers "no such resource", which invites a client
 * to hunt for a row that was never addressable; `my-flock` is not a resource that is missing, it is
 * a value that cannot name one. That is the same judgement this API already makes about a malformed
 * cursor (`decodeCursor` → `ZodError` → 422) and a malformed body (`readJsonObject` → 422), and the
 * three staying consistent is what lets Task 10 document one rule instead of three.
 *
 * **Parsed BEFORE the body**, in every handler that reads one. A request whose path does not name a
 * resource is not a request about any resource, so there is nothing for a body to be validated
 * against; deciding the path first also keeps the answer independent of what the body happened to
 * contain.
 *
 * **Not folded into `withAdmin`.** The wrapper would have to guess which params are uuids, and
 * `templates/{tid}` proves it cannot: a template id is `txt2img`, lives inside a JSON column and
 * never reaches a uuid cast. So the call is explicit, once per id, and `{tid}` is left alone.
 */
export function parsePathId(value: string): string {
  const parsed = uuidSchema.safeParse(value)
  if (parsed.success) return parsed.data
  // The offending segment is NOT echoed: it is attacker-controlled input this API has no reason to
  // reflect, and the `path: ['id']` tells the caller which segment to fix without quoting it back.
  throw new z.ZodError([{ code: 'custom', path: ['id'], message: 'path id must be a uuid' }])
}
