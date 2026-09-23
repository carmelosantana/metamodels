import { z } from 'zod/v4'
import type { z as z3 } from 'zod'
import { BREED_IDS, CAPABILITIES, KEY_STATUS, METER_DIMS, PADDOCK_STATUS, PADDOCK_THEMES } from '@metamodels/schema'
import { saveFlockInput } from '../lib/flock-schema'
import { savePaddockInput } from '../lib/paddock-schema'
import { saveFenceInput } from '../lib/fence-schema'
import { createKeyInput } from '../lib/key-schema'
import { templateDraftSchema } from '../lib/template-schema'
import { DEFAULT_LIMIT, MAX_LIMIT } from './page'

/**
 * The admin API's OpenAPI 3.1 document, built here and nowhere else. Three consumers share it:
 * `scripts/gen-openapi.ts` writes `docs/api/openapi.json` (committed, CI-diffed for staleness), the
 * unauthenticated `GET /api/admin/v1/openapi.json` route serves it, and `openapi.test.ts` checks it
 * against the ROUTE MODULES ON DISK rather than against any plan.
 *
 * **3.1, not 3.0.** OpenAPI 3.1's Schema Object *is* JSON Schema draft-2020-12, which is exactly
 * `z.toJSONSchema()`'s default output. The alternative was 3.0 via `target: 'openapi-3.0'`, and on
 * this repo's `zod@3.25.76` that target is not recognised: it prints `Invalid target: openapi-3.0`
 * to stderr, does NOT throw, and falls through to draft-2020-12 output whose `anyOf: [X, {type:
 * 'null'}]` for a nullable field is illegal in 3.0. A silently-wrong 3.0 document is worse than an
 * honest 3.1 one, so: 3.1, no `target` string, and no `$schema` key (3.1 Schema Objects take none).
 *
 * **Zero new dependencies.** `@asteasolutions/zod-to-openapi` requires `zod@^4` and has never been
 * installable here.
 */

// ---------------------------------------------------------------------------------------------
// Types. Deliberately narrow enough to make the document's own tests type-check, and no narrower —
// this is not an attempt to model OpenAPI 3.1 in TypeScript.
// ---------------------------------------------------------------------------------------------

export interface JsonSchema {
  [key: string]: unknown
  description?: string
  properties?: Record<string, JsonSchema>
}

export interface HeaderObject {
  description?: string
  schema?: JsonSchema
}

export interface ResponseObject {
  description: string
  headers?: Record<string, HeaderObject>
  content?: Record<string, { schema: JsonSchema }>
}

export interface ParameterObject {
  name: string
  in: 'path' | 'query'
  required?: boolean
  description?: string
  schema: JsonSchema
}

export interface OperationObject {
  operationId: string
  summary: string
  description?: string
  tags?: string[]
  /** Present only to OPT OUT of the document-level requirement; `[]` means "no credential". */
  security?: Record<string, string[]>[]
  parameters?: ParameterObject[]
  requestBody?: { required?: boolean; content: Record<string, { schema: JsonSchema }> }
  responses: Record<string, ResponseObject>
}

export type Method = 'get' | 'post' | 'put' | 'delete'
export type PathItemObject = Partial<Record<Method, OperationObject>>

export interface OpenApiDocument {
  openapi: string
  info: Record<string, unknown>
  servers: { url: string; description?: string }[]
  security: Record<string, string[]>[]
  tags: { name: string; description: string }[]
  paths: Record<string, PathItemObject>
  components: {
    securitySchemes: Record<string, JsonSchema>
    schemas: Record<string, JsonSchema>
    responses: Record<string, ResponseObject>
  }
}

// ---------------------------------------------------------------------------------------------
// Request-body schemas: MIRRORS of the schemas the services actually parse.
// ---------------------------------------------------------------------------------------------

/**
 * ⚠ EVERY SCHEMA IN THIS SECTION IS A MIRROR, NOT THE SOURCE.
 *
 * The repo's input schemas are authored against classic `zod` (v3). `z.toJSONSchema` lives only on
 * the `zod/v4` subpath and reads `schema._zod.def` — an internal a v3 schema does not have, so
 * handing it `saveFlockInput` throws `TypeError: Cannot read properties of undefined (reading
 * 'def')`. Verified, not assumed. There is no v3→v4 bridge in `zod@3.25.76` and no converter in the
 * dependency tree, and adding one is forbidden, so the shapes are restated here in v4.
 *
 * A restated shape is a second source of truth, which is exactly the thing that rots. It is tied
 * back to the real schema by `REQUEST_BODY_MIRRORS` below and the parity suite in `openapi.test.ts`:
 * same field names, and the same accept/reject verdict on payloads that probe every constraint. A
 * mirror that drifts from the schema the service parses fails the test lane, not a client.
 *
 * Sub-schemas are built by FACTORY, never shared by reference. `z.toJSONSchema` hoists any schema
 * object it reaches twice into `$defs` and points a `$ref` at `#/$defs/...` — a pointer from the
 * document root, which resolves to nothing once the result is embedded under `components.schemas`.
 */
const rateLimitMirror = () =>
  z.object({
    windowSec: z.number().int().positive(),
    max: z.number().int().nonnegative(),
  })

const quotaMirror = () =>
  z.array(
    z.object({
      dim: z.enum(METER_DIMS),
      max: z.number().int().nonnegative(),
      period: z.enum(['hour', 'day', 'month']),
    }),
  )

const saveFlockMirror = z.object({
  id: z.string().uuid().optional(),
  breed: z.enum(BREED_IDS),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().url(),
  upstreamAuth: z.string().trim().min(1).nullish(),
  tlsTrust: z.boolean(),
})

const savePaddockMirror = z.object({
  id: z.string().uuid().optional(),
  flockId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters, digits, and hyphens'),
  status: z.enum(PADDOCK_STATUS).optional(),
  theme: z.enum(PADDOCK_THEMES).default('plain'),
})

const saveFenceMirror = z.object({
  paddockId: z.string().uuid(),
  constraintJson: z.unknown().optional(),
  rateLimit: rateLimitMirror().nullish(),
  quota: quotaMirror().nullish(),
})

const createKeyMirror = z.object({
  name: z.string().min(1).max(120),
  paddockIds: z.array(z.string().uuid()).min(1),
  expiresAt: z.string().datetime().optional(),
  overrides: z.object({ rateLimit: rateLimitMirror() }).partial().optional(),
})

const targetMirror = () => z.object({ node: z.string().min(1), input: z.string().min(1) })

const templateDraftMirror = z.object({
  id: z.string().min(1),
  graphText: z.string(),
  params: z.array(
    z.discriminatedUnion('type', [
      z.object({ name: z.string().min(1), type: z.literal('text'), target: targetMirror() }),
      z.object({ name: z.string().min(1), type: z.literal('seed'), targets: z.array(targetMirror()).min(1) }),
      z.object({
        name: z.string().min(1),
        type: z.literal('number'),
        target: targetMirror(),
        min: z.number().optional(),
        max: z.number().optional(),
      }),
      z.object({ name: z.string().min(1), type: z.literal('image'), target: targetMirror() }),
    ]),
  ),
  cost: z.number().nonnegative(),
})

/**
 * Each generated component beside the v3 schema the service really parses. Exported ONLY so the
 * parity suite can hold the two against each other — nothing else should reach for a mirror.
 *
 * `PUT /paddocks/{id}/status`'s two-line body schema is absent because it is a module-local const
 * inside the route handler, and a Route Handler may not export arbitrary values. Its one field is
 * built from the same shared `PADDOCK_STATUS` enum the route imports, so the only thing that can
 * drift is the field NAME.
 */
export const REQUEST_BODY_MIRRORS: Record<
  string,
  { source: z3.ZodObject<z3.ZodRawShape>; mirror: z.ZodObject<z.ZodRawShape> }
> = {
  SaveFlockInput: { source: saveFlockInput, mirror: saveFlockMirror },
  SavePaddockInput: { source: savePaddockInput, mirror: savePaddockMirror },
  SaveFenceInput: { source: saveFenceInput, mirror: saveFenceMirror },
  CreateKeyInput: { source: createKeyInput, mirror: createKeyMirror },
  TemplateDraft: { source: templateDraftSchema, mirror: templateDraftMirror },
}

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

/**
 * `format` is the durable, interoperable half of a string constraint; the `pattern` zod emits
 * beside it is that zod version's own regex for the format. Publishing both would describe an API
 * stricter than the one that runs — v4's uuid regex demands an RFC version nibble, and the v3
 * `z.string().uuid()` that actually guards these fields does not. So the format stays and the
 * pattern beside it goes. A `pattern` with NO `format` is a real `.regex()` the schema declares
 * (the paddock slug) and is kept verbatim.
 */
function dropFormatPatterns(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) dropFormatPatterns(child)
    return
  }
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if ('format' in obj && 'pattern' in obj) delete obj.pattern
  for (const value of Object.values(obj)) dropFormatPatterns(value)
}

/**
 * A Zod schema as an OpenAPI 3.1 Schema Object.
 *
 * `io: 'input'` is load-bearing twice over. It puts a `.default()` field in `properties` WITHOUT
 * putting it in `required` — which is what a request body means — and it omits the
 * `additionalProperties: false` the output view emits. That omission is the accurate reading: these
 * objects STRIP unknown keys rather than rejecting them, so declaring extra properties forbidden
 * would promise a 422 the API does not send.
 *
 * No `target` string: see the note at the top of this module.
 */
function schemaOf(s: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(s, { io: 'input' }) as JsonSchema
  delete out.$schema // 3.1 Schema Objects carry no $schema
  dropFormatPatterns(out)
  return out
}

/** A copy of a generated body with per-field prose (and flags) layered on. Never mutates the source. */
function annotate(base: JsonSchema, notes: Record<string, JsonSchema>): JsonSchema {
  const props = { ...(base.properties ?? {}) }
  for (const [field, extra] of Object.entries(notes)) {
    if (!props[field]) throw new Error(`annotate: no such field '${field}' to describe`)
    props[field] = { ...props[field], ...extra }
  }
  return { ...base, properties: props }
}

/** A copy of a generated body without the named fields, dropped from `required` too. */
function omit(base: JsonSchema, ...fields: string[]): JsonSchema {
  const props = { ...(base.properties ?? {}) }
  for (const f of fields) delete props[f]
  const required = (base.required as string[] | undefined)?.filter((r) => !fields.includes(r))
  const out: JsonSchema = { ...base, properties: props }
  if (required === undefined) delete out.required
  else out.required = required
  return out
}

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: JsonSchema) => ({ 'application/json': { schema } })
const arrayOf = (name: string): JsonSchema => ({ type: 'array', items: ref(name) })

/**
 * The five mirrors as JSON Schema, keyed exactly as `REQUEST_BODY_MIRRORS` is so the parity suite
 * can hold each generated schema against the v3 schema it claims to describe.
 *
 * NOT the same thing as `components.schemas`, and deliberately so. Only two of these five are used
 * by an operation verbatim (`POST /keys`, `POST /paddocks/{id}/templates`); those two are published
 * and `$ref`ed. The other three are never referenced, because every operation that uses them first
 * drops a field or layers on the prose that IS the contract — and two of them would actively
 * contradict it: a published `SavePaddockInput` still carries `id`, which `POST /paddocks` answers
 * 422 on, and a bare `status`, which `PUT /paddocks/{id}` ignores. Most generators emit a model for
 * every `components.schemas` entry, so publishing them would ship an SDK type describing the one
 * request body no operation accepts. An unreferenced component is not documentation, it is a decoy.
 */
export const GENERATED_REQUEST_SCHEMAS: Record<string, JsonSchema> = {
  SaveFlockInput: schemaOf(saveFlockMirror),
  SavePaddockInput: schemaOf(savePaddockMirror),
  SaveFenceInput: schemaOf(saveFenceMirror),
  CreateKeyInput: schemaOf(createKeyMirror),
  TemplateDraft: schemaOf(templateDraftMirror),
}

// ---------------------------------------------------------------------------------------------
// Shared parameters
// ---------------------------------------------------------------------------------------------

/**
 * Built fresh per operation rather than shared by reference: `JSON.stringify` would happily emit
 * the same object twice, but a shared literal is one careless mutation away from changing every
 * operation that points at it.
 */
const pathIdParam = (resource: string): ParameterObject => ({
  name: 'id',
  in: 'path',
  required: true,
  description:
    `The ${resource}'s uuid. Validated before the body is even read: a malformed segment is a 422 ` +
    'whose `errors[]` carries `{"path": "id"}` — never a 404, because a value that cannot name a ' +
    'resource is not a resource that is missing.',
  schema: { type: 'string', format: 'uuid' },
})

const pathTidParam = (): ParameterObject => ({
  name: 'tid',
  in: 'path',
  required: true,
  description:
    'The template\'s own id (`txt2img`), chosen by the operator. Deliberately **not a uuid** and ' +
    'deliberately unvalidated beyond `z.string().min(1)`: it lives inside the fence\'s ' +
    '`constraint_json` column and never reaches a uuid cast, so parsing it as one would 422 every ' +
    'legitimate call.',
  schema: { type: 'string', minLength: 1 },
})

const limitParam = (): ParameterObject => ({
  name: 'limit',
  in: 'query',
  required: false,
  description:
    `Page size. Above ${MAX_LIMIT} the request is **rejected with a 422, not clamped**: silently ` +
    'returning fewer rows than asked for is a lie a client acts on.',
  schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
})

const cursorParam = (): ParameterObject => ({
  name: 'cursor',
  in: 'query',
  required: false,
  description:
    'An opaque cursor, taken verbatim from the previous page\'s `Link: rel="next"` header. Never ' +
    'constructed by hand; a malformed one is a 422.',
  schema: { type: 'string' },
})

const pageParams = (): ParameterObject[] => [limitParam(), cursorParam()]

const linkHeaderDoc = (): Record<string, HeaderObject> => ({
  Link: {
    description:
      'RFC 8288. Carries `rel="next"` when this page was full. Pagination metadata rides in a ' +
      'header so the body stays a bare array. The target is a path and query with no scheme or ' +
      'host: resolve it against the URL you requested.',
    schema: { type: 'string' },
  },
})

const TRAVERSAL_NOTE =
  'A full page means "there may be more", not "there is more": the query has no has-more signal, ' +
  'so a traversal whose row count is an exact multiple of `limit` ends on one trailing **empty ' +
  'page**. Deliberate, and cheaper than fetching `limit + 1` rows on every request.'

const bucketParam = (name: 'startBucket' | 'endBucket'): ParameterObject => ({
  name,
  in: 'query',
  required: true,
  description:
    'A UTC hour bucket, `YYYY-MM-DDTHH`. The window must run forwards: `endBucket` earlier than ' +
    '`startBucket` is a 422, not an empty report.',
  schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}$' },
})

const dimParam = (): ParameterObject => ({
  name: 'dim',
  in: 'query',
  required: true,
  description:
    'The meter dimension. Required and **not defaulted** — the five dimensions are not ' +
    'interchangeable, and a default would answer a question the caller did not ask.',
  schema: { type: 'string', enum: [...METER_DIMS] },
})

const usageFilterParams = (): ParameterObject[] => [
  {
    name: 'keyId',
    in: 'query',
    required: false,
    description: 'Restrict the report to one API key.',
    schema: { type: 'string', format: 'uuid' },
  },
  {
    name: 'paddockId',
    in: 'query',
    required: false,
    description: 'Restrict the report to one paddock.',
    schema: { type: 'string', format: 'uuid' },
  },
]

// ---------------------------------------------------------------------------------------------
// Shared error responses
// ---------------------------------------------------------------------------------------------

const ERROR_RESPONSE_NAMES: Record<string, string> = {
  '400': 'BothCredentials',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'NotFound',
  '409': 'Conflict',
  '422': 'ValidationFailed',
  '500': 'InternalError',
  '503': 'KeySetUnavailable',
}

/**
 * Every status a `withAdmin` operation can answer, in ascending order. The four unconditional ones
 * come from the wrapper itself (`400`, `401`, `403`, `422`) plus `problemForError`'s fallbacks
 * (`500`, `503`); `404` and `409` are opted into per operation because not every route can reach
 * `NotFoundError` or `SlugTakenError`.
 */
function adminErrors(...extra: ('404' | '409')[]): Record<string, ResponseObject> {
  const codes = ['400', '401', '403', ...extra, '422', '500', '503'].sort()
  return Object.fromEntries(
    codes.map((c) => [c, { $ref: `#/components/responses/${ERROR_RESPONSE_NAMES[c]}` } as unknown as ResponseObject]),
  )
}

const errorResponse = (description: string, extra?: Partial<ResponseObject>): ResponseObject => ({
  description,
  content: json(ref('Problem')),
  ...extra,
})

const COMPONENT_RESPONSES: Record<string, ResponseObject> = {
  BothCredentials: errorResponse(
    'The request presented **both** a bearer token and a console session cookie. Refused on its ' +
      'shape alone, before any token verification, so nothing about the token is measured or ' +
      'revealed: a request carrying both is the confused-deputy shape a browser produces.',
  ),
  Unauthorized: errorResponse(
    'No bearer token, or one that was rejected. `detail` is **fixed and does not vary with the ' +
      'reason**, deliberately: one internal reason distinguishes a valid token for a deactivated ' +
      'account from a bad token, which would be an account-enumeration oracle. `WWW-Authenticate` ' +
      'is the bare scheme for the same reason — RFC 6750\'s `error=` parameter would restate in a ' +
      'header exactly the distinction the body refuses to make.',
    {
      headers: {
        'WWW-Authenticate': {
          description: 'The bare challenge RFC 9110 §15.5.2 makes mandatory. No `error=` parameter, ever.',
          schema: { type: 'string', const: 'Bearer' },
        },
      },
    },
  ),
  Forbidden: errorResponse(
    'The role matrix intersected with the token\'s granted scopes denied the capability. The body ' +
      'is the only error that carries anything derived from the error — a `capability` member — ' +
      'because a caller cannot fix a 403 without knowing which scope it lacks.',
    { content: json(ref('ForbiddenProblem')) },
  ),
  NotFound: errorResponse(
    'No such resource. A resource belonging to **another org is deliberately indistinguishable ' +
      'from one that never existed**: whether it exists is itself the leak, so a foreign id is ' +
      'never a 403.',
  ),
  Conflict: errorResponse('The paddock slug is already in use. Slugs are globally unique.'),
  ValidationFailed: errorResponse(
    'Validation failed. Three sources reach this status — a malformed JSON body, a malformed path ' +
      'id, and a malformed query parameter — and `detail` is the same generic string for all ' +
      'three. Nothing in the underlying error records which source threw, so `errors[]` is the ' +
      'precise, machine-readable half and `detail`\'s only job is not to lie.',
    { content: json(ref('ValidationProblem')) },
  ),
  InternalError: errorResponse(
    'An unmapped server error. The body carries **no `detail`**: service errors can quote ' +
      'connection strings and upstream URLs, and this surface is reachable by anything holding a ' +
      'token.',
  ),
  KeySetUnavailable: errorResponse(
    'The token could not be judged against a current key set: the OpenID Provider\'s key set ' +
      'could not be fetched, or the token names a signing key missing from a key set fetched less ' +
      'than 30 seconds ago, too recently to fetch again (a key the provider may have just begun ' +
      'publishing). 503 rather than 401 on purpose: a 401 would send the client off to refresh a ' +
      'token that may be fine. A signing key missing from a key set fetched for this request is a ' +
      '401, and so is a token whose `exp` has passed, whatever its signing key.',
    {
      headers: {
        'Retry-After': {
          description:
            'Seconds. The key-set fetch cooldown, after which a signing key missing from the key ' +
            'set makes the server fetch it again. Another request may start a new cooldown first.',
          schema: { type: 'integer' },
        },
      },
    },
  ),
}

// ---------------------------------------------------------------------------------------------
// Response component schemas (hand-written: a drizzle row is not a Zod schema)
// ---------------------------------------------------------------------------------------------

const uuid = (description: string): JsonSchema => ({ type: 'string', format: 'uuid', description })
const timestamp = (description: string): JsonSchema => ({ type: 'string', format: 'date-time', description })

const COMPONENT_SCHEMAS: Record<string, JsonSchema> = {
  Problem: {
    type: 'object',
    description:
      'RFC 9457 Problem Details, served as `application/problem+json`. `type` is always ' +
      '`about:blank` (§4.2.1) because no dereferenceable problem type is published.',
    properties: {
      type: { type: 'string', const: 'about:blank' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string', description: 'Absent on a 500, which carries no detail at all.' },
    },
    required: ['type', 'title', 'status'],
  },
  ForbiddenProblem: {
    allOf: [ref('Problem')],
    type: 'object',
    description: 'A `Problem` naming the capability the credential lacked.',
    properties: {
      capability: {
        type: 'string',
        // `CAPABILITIES`, never a hand-typed copy: these are also the OAuth scope values the
        // resource server accepts, so renaming one is a breaking change to every issued token —
        // and a literal here would go on publishing the old name without a single test noticing.
        enum: [...CAPABILITIES],
        description: 'The capability the role ∩ granted-scope intersection denied.',
      },
    },
    required: ['capability'],
  },
  ValidationProblem: {
    allOf: [ref('Problem')],
    type: 'object',
    description: 'A `Problem` carrying the individual validation issues.',
    properties: {
      detail: {
        type: 'string',
        const: 'request failed validation',
        description: 'Fixed. It names no source, because the error does not record one.',
      },
      errors: {
        type: 'array',
        description:
          'The issues. `path` is dotted; a malformed path id reports `"id"`, a malformed query ' +
          'parameter reports that parameter, and a body that is not a JSON object at all reports ' +
          '`""`.',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, message: { type: 'string' } },
          required: ['path', 'message'],
        },
      },
    },
    required: ['errors'],
  },
  Flock: {
    type: 'object',
    description: 'An upstream inference server. Returned verbatim from the row, `org_id` included.',
    properties: {
      id: uuid('The flock.'),
      orgId: uuid('The owning org. Always the caller\'s own — cross-org rows are 404, never returned.'),
      breed: { type: 'string', enum: [...BREED_IDS], description: 'Which connector drives it.' },
      name: { type: 'string' },
      baseUrl: { type: 'string', format: 'uri' },
      upstreamAuth: {
        type: ['string', 'null'],
        description:
          '⚠ **A secret, returned in plaintext.** The credential this control plane sends upstream ' +
          'to the flock, stored and returned verbatim — not hashed, not redacted, not write-only. ' +
          'Any token holding only `read` can retrieve it from `GET /flocks` or `GET /flocks/{id}`, ' +
          'so the whole listing should be treated as credential material: do not log it, cache it ' +
          'or render it into a page. This is a **known issue, tracked as its own milestone**, and ' +
          'is documented here rather than fixed — a client that has already been told is better ' +
          'off than one that finds out. `null` when the flock needs no upstream credential.\n\n' +
          'Note also that `PUT /flocks/{id}` is a replace: omitting this field writes `null` and ' +
          'clears the stored credential.',
      },
      tlsTrust: { type: 'boolean' },
      healthOk: {
        type: ['boolean', 'null'],
        description: 'Last health probe result; `null` until one has run.',
      },
      createdAt: timestamp('Creation time.'),
    },
    required: ['id', 'orgId', 'breed', 'name', 'baseUrl', 'upstreamAuth', 'tlsTrust', 'healthOk', 'createdAt'],
  },
  Paddock: {
    type: 'object',
    description: 'A published, fenced endpoint onto one flock.',
    properties: {
      id: uuid('The paddock.'),
      orgId: uuid('The owning org.'),
      flockId: uuid('The flock this paddock publishes.'),
      slug: { type: 'string', description: 'The public `/p/{slug}` handle. Globally unique — a clash is a 409.' },
      name: { type: 'string' },
      status: {
        type: 'string',
        enum: [...PADDOCK_STATUS],
        description:
          'Writable on `POST /paddocks` and on `PUT /paddocks/{id}/status`; **read-only on `PUT ' +
          '/paddocks/{id}`**, which accepts the field and ignores it.',
      },
      theme: { type: 'string', enum: [...PADDOCK_THEMES] },
      createdAt: timestamp('Creation time.'),
    },
    required: ['id', 'orgId', 'flockId', 'slug', 'name', 'status', 'theme', 'createdAt'],
  },
  Fence: {
    type: 'object',
    description: 'A paddock\'s single policy row: what may be asked for, how often, and how much.',
    properties: {
      id: uuid('The fence.'),
      orgId: uuid('The owning org.'),
      paddockId: uuid('The paddock this fence guards. Unique — one fence per paddock.'),
      constraintJson: {
        description:
          'The breed-specific allow-list, validated against the paddock\'s breed on write. For a ' +
          'comfyui paddock this is `{"templates": [...]}`, which the template endpoints project.',
      },
      rateLimit: {
        oneOf: [ref('RateLimit'), { type: 'null' }],
        description: '`null` means no per-fence rate limit.',
      },
      quota: {
        oneOf: [arrayOf('QuotaRule'), { type: 'null' }],
        description: '`null` means no per-fence quota.',
      },
      createdAt: timestamp('Creation time.'),
    },
    required: ['id', 'orgId', 'paddockId', 'constraintJson', 'rateLimit', 'quota', 'createdAt'],
  },
  RateLimit: {
    type: 'object',
    description: 'A sliding-window cap. `max: 0` is a deny-all, honoured by both planes.',
    properties: {
      windowSec: { type: 'integer', minimum: 1 },
      max: { type: 'integer', minimum: 0 },
    },
    required: ['windowSec', 'max'],
  },
  QuotaRule: {
    type: 'object',
    description: 'One hard cap on a single meter dimension per period.',
    properties: {
      dim: { type: 'string', enum: [...METER_DIMS] },
      max: { type: 'integer', minimum: 0 },
      period: { type: 'string', enum: ['hour', 'day', 'month'] },
    },
    required: ['dim', 'max', 'period'],
  },
  WorkflowTemplate: {
    type: 'object',
    description:
      'A stored, validated comfyui workflow template — the built form of a `TemplateDraft`, with ' +
      '`graphText` parsed into `graph`.',
    properties: {
      id: { type: 'string', description: 'The operator\'s own id, echoed from the draft. Not a uuid.' },
      graph: { type: 'object', description: 'The parsed ComfyUI prompt graph.' },
      params: { type: 'array', description: 'The declared parameter specs.', items: { type: 'object' } },
      cost: { type: 'number', minimum: 0 },
    },
    required: ['id', 'graph', 'params', 'cost'],
  },
  KeySummary: {
    type: 'object',
    description:
      'An API key as it appears in a listing. There is no column here from which the secret could ' +
      'be reconstructed, and no `GET /keys/{id}` to ask for one.',
    properties: {
      id: uuid('The key.'),
      name: { type: 'string' },
      prefix: { type: 'string', description: 'The key\'s public prefix — enough to recognise it in a log.' },
      status: { type: 'string', enum: [...KEY_STATUS] },
      expiresAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: timestamp('Creation time.'),
      paddockSlugs: {
        type: 'array',
        description: 'The slugs of the paddocks this key is scoped to, sorted.',
        items: { type: 'string' },
      },
    },
    required: ['id', 'name', 'prefix', 'status', 'expiresAt', 'createdAt', 'paddockSlugs'],
  },
  CreatedKey: {
    type: 'object',
    description:
      'The 201 body of `POST /keys`, and the only place the secret ever exists outside the ' +
      'caller\'s hands. Only a sha256 is stored, so it is **never** retrievable again by any ' +
      'means — a client that drops this response has lost the key, not mislaid it.',
    properties: {
      id: uuid('The new key.'),
      name: { type: 'string' },
      prefix: { type: 'string' },
      plaintext: {
        type: 'string',
        description: 'The full secret, returned exactly **once**, here. It appears in no listing.',
      },
    },
    required: ['id', 'name', 'prefix', 'plaintext'],
  },
  UsageMatrixRow: {
    type: 'object',
    description: 'One (key × paddock) cell of the usage pivot, with every meter dimension zero-filled.',
    properties: {
      keyId: uuid('The key.'),
      keyName: { type: 'string' },
      keyPrefix: { type: 'string' },
      paddockId: uuid('The paddock.'),
      paddockSlug: { type: 'string' },
      dims: {
        type: 'object',
        description: 'Every meter dimension, zero-filled — not sparse.',
        properties: Object.fromEntries(METER_DIMS.map((d) => [d, { type: 'integer' }])),
        required: [...METER_DIMS],
      },
    },
    required: ['keyId', 'keyName', 'keyPrefix', 'paddockId', 'paddockSlug', 'dims'],
  },
  DailyPoint: {
    type: 'object',
    description: 'One UTC day\'s total for the requested dimension.',
    properties: {
      day: { type: 'string', description: '`YYYY-MM-DD`, UTC.' },
      value: { type: 'integer' },
    },
    required: ['day', 'value'],
  },
  TopKeyRow: {
    type: 'object',
    description: 'One key\'s total for the requested dimension over the window.',
    properties: {
      keyId: uuid('The key.'),
      keyName: { type: 'string' },
      keyPrefix: { type: 'string' },
      value: { type: 'integer' },
    },
    required: ['keyId', 'keyName', 'keyPrefix', 'value'],
  },
  // The two generated bodies an operation uses VERBATIM are published as components and `$ref`ed.
  // The other three are not — see `GENERATED_REQUEST_SCHEMAS`.
  CreateKeyInput: GENERATED_REQUEST_SCHEMAS.CreateKeyInput!,
  TemplateDraft: GENERATED_REQUEST_SCHEMAS.TemplateDraft!,
}

// ---------------------------------------------------------------------------------------------
// Per-operation bodies
// ---------------------------------------------------------------------------------------------

const flockBody = GENERATED_REQUEST_SCHEMAS.SaveFlockInput!
const paddockBody = GENERATED_REQUEST_SCHEMAS.SavePaddockInput!

const THEME_NOTE =
  'Defaulted to `plain`. **Omitting it on a PUT therefore RESETS it** — unlike `status`, an absent ' +
  '`theme` is an active write of the default, not "leave it alone".'

const paddockCreateBody = annotate(omit(paddockBody, 'id'), {
  status: {
    description:
      'Honoured on create: a paddock may be created `disabled`. This is the asymmetry — `status` ' +
      'is writable here, ignored on `PUT /paddocks/{id}`, and writable again on ' +
      '`PUT /paddocks/{id}/status`. Omitted, the column\'s own default (`active`) applies.',
  },
  theme: { description: THEME_NOTE },
})

const paddockReplaceBody = annotate(paddockBody, {
  id: { readOnly: true, description: 'Ignored; the path owns the id.' },
  status: {
    readOnly: true,
    description:
      'Accepted and **silently ignored** on this endpoint. It is dropped before the service sees ' +
      'it, so sending one and omitting one take exactly the same path, and a rename cannot flip a ' +
      'deliberately-thrown kill switch back on. Use `PUT /paddocks/{id}/status` to change it. ' +
      'Rejecting it instead would break the natural GET → edit one field → PUT round trip, since ' +
      'GET returns the field.',
  },
  theme: { description: THEME_NOTE },
})

const fenceBody = annotate(omit(GENERATED_REQUEST_SCHEMAS.SaveFenceInput!, 'paddockId'), {
  constraintJson: {
    description:
      'The breed-specific allow-list. **Omitting it PRESERVES the stored constraint** (or, on a ' +
      'fresh fence, applies the breed default) — this field is merged, not replaced. A client ' +
      'trying to clear an allow-list by sending a body without one silently keeps the old one.',
  },
  rateLimit: {
    description:
      '**Omitting it sets the column to `null`.** This field is replaced, not merged — the ' +
      'opposite of `constraintJson` on the same request.',
  },
  quota: {
    description:
      '**Omitting it sets the column to `null`.** Replaced, not merged, exactly like `rateLimit`.',
  },
})

const templateItemBody = annotate(omit(GENERATED_REQUEST_SCHEMAS.TemplateDraft!, 'id'), {
  graphText: { description: 'The ComfyUI prompt graph as JSON text. Parsed and dry-run before storage.' },
})

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

const DESCRIPTION = [
  'The MetaModels control-plane admin API.',
  '',
  '### Authentication',
  '',
  'RFC 9068 bearer access tokens only. There is no cookie fallback, and a request presenting a ' +
    'bearer **and** a console session cookie is refused with a 400 before the token is looked at — ' +
    'Route Handlers get none of the Origin-vs-Host checking server actions get, so the CSRF posture ' +
    'is a bearer and no ambient cookie. Authorization is the role matrix intersected with the ' +
    'token\'s granted scopes; a token with no scopes denies rather than inheriting its role\'s power.',
  '',
  '### Errors',
  '',
  'Every error is RFC 9457 `application/problem+json`. A resource in another org answers 404, ' +
    'identically to one that does not exist.',
  '',
  '### Pagination',
  '',
  'The three collections take `limit` and `cursor` and return a **bare array**, with the next page ' +
    'in an RFC 8288 `Link` header, so a later change to the response envelope cannot break clients. ' +
    'The usage endpoints are reports, not collections: no cursor and no `Link`.',
].join('\n')

/**
 * Deterministic by construction: every value here is a literal or a pure function of one, and
 * JavaScript preserves insertion order for the string keys used throughout. `openapi.test.ts` pins
 * it anyway, because "deterministic by construction" is a claim and the diff gate depends on it.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, PathItemObject> = {
    '/flocks': {
      get: {
        operationId: 'listFlocks',
        summary: 'List flocks',
        tags: ['flocks'],
        description: TRAVERSAL_NOTE,
        parameters: pageParams(),
        responses: {
          '200': {
            description: 'A page of flocks, oldest id first.',
            headers: linkHeaderDoc(),
            content: json(arrayOf('Flock')),
          },
          ...adminErrors(),
        },
      },
      post: {
        operationId: 'createFlock',
        summary: 'Create a flock',
        tags: ['flocks'],
        description:
          'Creates. An `id` in the body is a **422** rather than an update — that is what ' +
          '`PUT /flocks/{id}` is for.',
        requestBody: { required: true, content: json(omit(flockBody, 'id')) },
        responses: {
          '201': {
            description: 'Created. `Location` names the new flock.',
            headers: { Location: { description: 'The new flock\'s URI.', schema: { type: 'string' } } },
            content: json(ref('Flock')),
          },
          ...adminErrors(),
        },
      },
    },
    '/flocks/{id}': {
      get: {
        operationId: 'getFlock',
        summary: 'Get a flock',
        tags: ['flocks'],
        parameters: [pathIdParam('flock')],
        responses: { '200': { description: 'The flock.', content: json(ref('Flock')) }, ...adminErrors('404') },
      },
      put: {
        operationId: 'replaceFlock',
        summary: 'Replace a flock',
        tags: ['flocks'],
        description:
          'A **full replace** of every writable field: the service does `set(values)` over all of ' +
          'them, so omitting `upstreamAuth` writes `null` rather than leaving it alone. There is ' +
          'deliberately no PATCH — a partial merge would need a read-modify-write outside the ' +
          'service\'s transaction, where it races. `healthOk` is server-owned and is neither read ' +
          'from the body nor touched by this write.',
        parameters: [pathIdParam('flock')],
        requestBody: {
          required: true,
          content: json(
            annotate(flockBody, {
              id: { readOnly: true, description: 'Ignored; the path owns the id.' },
              upstreamAuth: {
                description:
                  'The credential to send upstream. **Omitting it writes `null`** — this is a ' +
                  'replace, not a merge, so an absent field clears the stored value.',
              },
            }),
          ),
        },
        responses: { '200': { description: 'The replaced flock.', content: json(ref('Flock')) }, ...adminErrors('404') },
      },
      delete: {
        operationId: 'deleteFlock',
        summary: 'Delete a flock',
        tags: ['flocks'],
        description: 'A hard delete. Paddocks on this flock cascade.',
        parameters: [pathIdParam('flock')],
        responses: { '204': { description: 'Deleted. No body.' }, ...adminErrors('404') },
      },
    },
    '/paddocks': {
      get: {
        operationId: 'listPaddocks',
        summary: 'List paddocks',
        tags: ['paddocks'],
        description: TRAVERSAL_NOTE,
        parameters: pageParams(),
        responses: {
          '200': {
            description: 'A page of paddocks, oldest id first.',
            headers: linkHeaderDoc(),
            content: json(arrayOf('Paddock')),
          },
          ...adminErrors(),
        },
      },
      post: {
        operationId: 'createPaddock',
        summary: 'Create a paddock',
        tags: ['paddocks'],
        description:
          'Creates. An `id` in the body is a **422** rather than an update. Unlike the item PUT, ' +
          '`status` IS honoured here — a paddock can be created `disabled`. A slug already in use ' +
          'is a 409; a `flockId` naming no flock in this org is a 404.',
        requestBody: { required: true, content: json(paddockCreateBody) },
        responses: {
          '201': {
            description: 'Created. `Location` names the new paddock.',
            headers: { Location: { description: 'The new paddock\'s URI.', schema: { type: 'string' } } },
            content: json(ref('Paddock')),
          },
          ...adminErrors('404', '409'),
        },
      },
    },
    '/paddocks/{id}': {
      get: {
        operationId: 'getPaddock',
        summary: 'Get a paddock',
        tags: ['paddocks'],
        parameters: [pathIdParam('paddock')],
        responses: {
          '200': { description: 'The paddock.', content: json(ref('Paddock')) },
          ...adminErrors('404'),
        },
      },
      put: {
        operationId: 'replacePaddock',
        summary: 'Replace a paddock',
        tags: ['paddocks'],
        description:
          'A full replace with **one exception**: `status` is read-only here and silently ignored. ' +
          'Note that `theme` is not — it carries a schema default, so omitting it RESETS it. One ' +
          'defaulted field and one leave-it-alone field on the same resource; the field table ' +
          'below says which is which.',
        parameters: [pathIdParam('paddock')],
        requestBody: { required: true, content: json(paddockReplaceBody) },
        responses: {
          '200': { description: 'The replaced paddock.', content: json(ref('Paddock')) },
          ...adminErrors('404', '409'),
        },
      },
      delete: {
        operationId: 'deletePaddock',
        summary: 'Delete a paddock',
        tags: ['paddocks'],
        description: 'A hard delete. The fence, key scopings and usage rows cascade.',
        parameters: [pathIdParam('paddock')],
        responses: { '204': { description: 'Deleted. No body.' }, ...adminErrors('404') },
      },
    },
    '/paddocks/{id}/status': {
      put: {
        operationId: 'setPaddockStatus',
        summary: 'Enable or disable a paddock',
        tags: ['paddocks'],
        description:
          'The **only** way to change a live paddock\'s status over this API: the item PUT ignores ' +
          'the field. A sub-resource rather than a field because flipping a paddock off is the ' +
          'one-field operation an operator reaches for most, and routing it through the full ' +
          'replace would demand the whole representation and audit as `paddock.update` instead of ' +
          '`paddock.status`. (`POST /paddocks` may also set a status, at create time.)',
        parameters: [pathIdParam('paddock')],
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            properties: { status: { type: 'string', enum: [...PADDOCK_STATUS] } },
            required: ['status'],
          }),
        },
        responses: {
          '200': { description: 'The paddock, with its new status.', content: json(ref('Paddock')) },
          ...adminErrors('404'),
        },
      },
    },
    '/paddocks/{id}/fence': {
      get: {
        operationId: 'getFence',
        summary: 'Get a paddock\'s fence',
        tags: ['fences'],
        description:
          'A paddock with no fence has no fence resource, so this is a **404**, not a 200 with a ' +
          '`null` body — the latter would claim the resource exists and is empty, which is a ' +
          'different thing and one a client cannot act on.',
        parameters: [pathIdParam('paddock')],
        responses: {
          '200': { description: 'The fence.', content: json(ref('Fence')) },
          ...adminErrors('404'),
        },
      },
      put: {
        operationId: 'saveFence',
        summary: 'Create or replace a paddock\'s fence',
        tags: ['fences'],
        description:
          'Creates the fence if the paddock has none, replaces it otherwise — and answers **200 ' +
          'either way**, never 201. There is **no DELETE** for a fence: over this API a fence is ' +
          'create-or-replace only.\n\n' +
          '⚠ This is **not a uniform full replace**. `constraintJson` is merged (omitting it ' +
          'preserves what is stored); `rateLimit` and `quota` are replaced (omitting either sets ' +
          'it to `null`). The asymmetry is deliberate and load-bearing — the console\'s fence form ' +
          'omits `constraintJson` precisely so that saving a rate limit does not clobber the ' +
          'templates managed on another screen. The per-field notes below are the contract.',
        parameters: [pathIdParam('paddock')],
        requestBody: { required: true, content: json(fenceBody) },
        responses: {
          '200': { description: 'The saved fence, whether it was created or replaced.', content: json(ref('Fence')) },
          ...adminErrors('404'),
        },
      },
    },
    '/paddocks/{id}/templates': {
      get: {
        operationId: 'listTemplates',
        summary: 'List a comfyui paddock\'s workflow templates',
        tags: ['templates'],
        description:
          'Templates live inside the fence\'s `constraint_json`, so this collection is a ' +
          'projection of one column, not a table. A paddock of any other breed 404s — the same ' +
          'status a paddock in another org gets, which is the point.',
        parameters: [pathIdParam('paddock')],
        responses: {
          '200': { description: 'Every template the paddock allows.', content: json(arrayOf('WorkflowTemplate')) },
          ...adminErrors('404'),
        },
      },
      post: {
        operationId: 'saveTemplate',
        summary: 'Add or replace a workflow template',
        tags: ['templates'],
        description:
          'Keyed on the draft\'s own `id`: a matching template is replaced, a new one appended.\n\n' +
          'The 201 body is the **whole template array**, not the created template, because that is ' +
          'what the service writes — one `constraint_json` column. For the same reason there is no ' +
          '`Location` header: the id is the client\'s own, echoed back inside the array.\n\n' +
          '⚠ A draft that parses as JSON but fails template validation (an unresolvable graph ' +
          'target, a duplicate param name, a failing dry run) currently answers **500, not 422**: ' +
          '`validateDraft`\'s failure is rethrown as a bare `Error`, which is indistinguishable ' +
          'from an internal fault by the time it reaches the problem mapper. Known, and documented ' +
          'rather than papered over.',
        parameters: [pathIdParam('paddock')],
        requestBody: { required: true, content: json(ref('TemplateDraft')) },
        responses: {
          '201': {
            description: 'The full template collection after the write.',
            content: json(arrayOf('WorkflowTemplate')),
          },
          ...adminErrors('404'),
        },
      },
    },
    '/paddocks/{id}/templates/{tid}': {
      put: {
        operationId: 'replaceTemplate',
        summary: 'Replace the template the path names',
        tags: ['templates'],
        description:
          'The path id is forced onto the body last, so a body claiming a different `id` cannot ' +
          'append a second template while answering as though it had replaced the one addressed.\n\n' +
          '⚠ A `{tid}` matching no stored template **creates** it, and still answers **200, not ' +
          '201** — the service appends and returns the collection, and the route does not ' +
          'distinguish the two cases. As on the collection, the body is the whole array.',
        parameters: [pathIdParam('paddock'), pathTidParam()],
        requestBody: { required: true, content: json(templateItemBody) },
        responses: {
          '200': {
            description: 'The full template collection after the write, whether this replaced or created.',
            content: json(arrayOf('WorkflowTemplate')),
          },
          ...adminErrors('404'),
        },
      },
      delete: {
        operationId: 'deleteTemplate',
        summary: 'Remove a workflow template',
        tags: ['templates'],
        description:
          '204 rather than the remaining array, so DELETE means the same thing here as everywhere ' +
          'else in this API. Removing a `{tid}` that is not there is a no-op that still audits; ' +
          'GET the collection to see what is left.',
        parameters: [pathIdParam('paddock'), pathTidParam()],
        responses: { '204': { description: 'Removed. No body.' }, ...adminErrors('404') },
      },
    },
    '/keys': {
      get: {
        operationId: 'listKeys',
        summary: 'List API keys',
        tags: ['keys'],
        description: `${TRAVERSAL_NOTE}\n\nNo column here can reconstruct a key's secret.`,
        parameters: pageParams(),
        responses: {
          '200': {
            description: 'A page of keys, oldest id first.',
            headers: linkHeaderDoc(),
            content: json(arrayOf('KeySummary')),
          },
          ...adminErrors(),
        },
      },
      post: {
        operationId: 'createKey',
        summary: 'Create an API key',
        tags: ['keys'],
        description:
          'Returns the plaintext secret **exactly once**, in this response. Only a sha256 is ' +
          'stored; no listing and no other endpoint can return it again.\n\n' +
          'No `Location` header, deliberately: `/keys/{id}` serves no representation — its only ' +
          'method is a 405 — so a `Location` would send a client to a dead end. A `paddockIds` ' +
          'entry naming a paddock outside this org is a 404, indistinguishable from one that does ' +
          'not exist.',
        requestBody: { required: true, content: json(ref('CreateKeyInput')) },
        responses: {
          '201': { description: 'The new key, including its one and only plaintext.', content: json(ref('CreatedKey')) },
          ...adminErrors('404'),
        },
      },
    },
    '/keys/{id}': {
      delete: {
        operationId: 'deleteKeyRefused',
        summary: 'Refused — keys are revoked, not deleted',
        tags: ['keys'],
        /**
         * The ONLY operation with no error surface at all. Everything else on this document goes
         * through `withAdmin`; this handler does not, so it can answer nothing else.
         */
        security: [],
        description:
          'Always 405. Keys are never hard-deleted — `revoke` flips a status, and three `usage_*` ' +
          'tables cascade off `key_id`, so an honest DELETE would destroy billing history no audit ' +
          'row could reconstruct. Refused rather than quietly re-routed, because answering 204 ' +
          'after merely flipping a status would tell the caller something untrue.\n\n' +
          'Not bearer-guarded and it touches no database: the answer does not depend on who is ' +
          'asking, and nothing is disclosed — no id is echoed or looked up. It answers on the ' +
          'method alone, so a malformed `{id}` is still a 405, not a 422.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Never read. The refusal does not depend on it, so it is not validated.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '405': {
            description: 'Method Not Allowed. The body names `POST /keys/{id}/revoke`, the operation that exists.',
            headers: {
              Allow: {
                description:
                  'Mandatory on a 405 (RFC 9110 §15.5.6) and **empty**, which is the truth about ' +
                  'this URI: it exports no other method, so it supports none (RFC 9110 §10.2.1 ' +
                  'gives an empty field value exactly that meaning).',
                schema: { type: 'string', const: '' },
              },
            },
            content: json(ref('Problem')),
          },
        },
      },
    },
    '/keys/{id}/revoke': {
      post: {
        operationId: 'revokeKey',
        summary: 'Revoke an API key',
        tags: ['keys'],
        description:
          'The only way to retire a key over this API. Flips `status` to `revoked` and writes one ' +
          '`key.revoke` audit row in a single transaction; the key row and its usage history ' +
          'survive.\n\n' +
          '**Idempotent in both halves.** A replayed revoke answers 204 again and writes **no ' +
          'second audit row** — the UPDATE test-and-sets on `status = \'active\'`, so of two ' +
          'concurrent revokes exactly one matches and exactly one audits.\n\n' +
          '204 with no body because a revoked key has no retrievable representation (there is no ' +
          '`GET /keys/{id}`); re-list the collection to see the new status. A key that does not ' +
          'exist, or belongs to another org, is a 404 — the two are indistinguishable on purpose, ' +
          'since letting an already-revoked foreign key take the quiet 204 path would leak another ' +
          'org\'s key status.',
        parameters: [pathIdParam('key')],
        responses: { '204': { description: 'Revoked, or already revoked. No body.' }, ...adminErrors('404') },
      },
    },
    '/usage/matrix': {
      get: {
        operationId: 'usageMatrix',
        summary: 'Usage pivoted by key × paddock',
        tags: ['usage'],
        description:
          'A **report, not a collection**: no `limit`, no `cursor`, no `Link`. A cursor promises a ' +
          'stable total order to resume from, and this body is a pivot recomputed per request over ' +
          'a caller-chosen window — there is nothing for one to point at. Rows are sorted by key ' +
          'name then paddock slug.',
        parameters: [bucketParam('startBucket'), bucketParam('endBucket'), ...usageFilterParams()],
        responses: {
          '200': { description: 'One row per (key, paddock) pair with activity.', content: json(arrayOf('UsageMatrixRow')) },
          ...adminErrors(),
        },
      },
    },
    '/usage/daily': {
      get: {
        operationId: 'usageDaily',
        summary: 'One meter dimension by UTC day',
        tags: ['usage'],
        description:
          'A report, not a collection: no pagination and no `Link`.\n\nThe series is **sparse** — ' +
          'only days with rows appear, so a client wanting a dense axis fills the gaps itself.',
        parameters: [dimParam(), bucketParam('startBucket'), bucketParam('endBucket'), ...usageFilterParams()],
        responses: {
          '200': { description: 'The daily series, ascending.', content: json(arrayOf('DailyPoint')) },
          ...adminErrors(),
        },
      },
    },
    '/usage/top-keys': {
      get: {
        operationId: 'usageTopKeys',
        summary: 'The org\'s keys ranked by one dimension',
        tags: ['usage'],
        description:
          'A report, not a collection: no `cursor` and no `Link`. `keyId` and `paddockId` filters ' +
          'are absent here, unlike the other two reports, because the query accepts neither — a ' +
          'parameter parsed and then dropped would read as a filter that works.',
        parameters: [
          dimParam(),
          bucketParam('startBucket'),
          bucketParam('endBucket'),
          {
            name: 'limit',
            in: 'query',
            required: false,
            description:
              'The **N of a ranking, not pagination**: the query orders by total descending with ' +
              'no tiebreak and no cursor, so there is no next page of a top-10 to follow. Above ' +
              'the maximum the request is rejected, not clamped.',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
          },
        ],
        responses: {
          '200': { description: 'The ranked keys.', content: json(arrayOf('TopKeyRow')) },
          ...adminErrors(),
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiDocument',
        summary: 'This document',
        tags: ['meta'],
        /** Opts out of the document-level bearer requirement. See the route module for why. */
        security: [],
        description:
          'Deliberately **unauthenticated**, and the one operation here that is: the repo is AGPL ' +
          'and public, so the API shape is not a secret, and a client needs the schema to bootstrap ' +
          'before it holds a token.',
        responses: {
          '200': {
            description: 'This OpenAPI 3.1 document.',
            headers: {
              'Cache-Control': { description: 'Public, 5 minutes.', schema: { type: 'string' } },
            },
            content: json({ type: 'object' }),
          },
        },
      },
    },
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'MetaModels admin API',
      /**
       * The API surface's version, not the package's — `@metamodels/control-plane` is private and
       * pinned at 0.0.0, which would say nothing. It moves when this document's contract does.
       */
      version: '1.0.0',
      description: DESCRIPTION,
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    /**
     * Relative, and the only place the `v1` prefix appears: no host is hardcoded, so the document
     * is correct behind any deployment's origin, and every path below is written as the route
     * module names it.
     */
    servers: [{ url: '/api/admin/v1', description: 'Relative to whatever origin serves this document.' }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'flocks', description: 'Upstream inference servers.' },
      { name: 'paddocks', description: 'Published, fenced endpoints onto a flock.' },
      { name: 'fences', description: 'What a paddock allows, how often, and how much.' },
      { name: 'templates', description: 'A comfyui paddock\'s workflow allow-list.' },
      { name: 'keys', description: 'API keys for the data plane.' },
      { name: 'usage', description: 'Read-only usage reports.' },
      { name: 'meta', description: 'The API describing itself.' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'An RFC 9068 `at+jwt` access token. The scheme token is matched case-insensitively ' +
            '(RFC 9110 §11.1), so `bearer <jwt>` is admitted. Presenting this **and** a console ' +
            'session cookie is a 400.',
        },
      },
      schemas: COMPONENT_SCHEMAS,
      responses: COMPONENT_RESPONSES,
    },
  }
}
