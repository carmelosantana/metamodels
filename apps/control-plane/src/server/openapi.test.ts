import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import {
  BREED_IDS, CAPABILITIES, KEY_STATUS, METER_DIMS, PADDOCK_STATUS, PADDOCK_THEMES,
  fence, paddock,
} from '@metamodels/schema'
import { GENERATED_REQUEST_SCHEMAS, buildOpenApiDocument, REQUEST_BODY_MIRRORS } from './openapi'
import type { JsonSchema, Method, OpenApiDocument, OperationObject } from './openapi'
import { DEFAULT_LIMIT, MAX_LIMIT } from './page'
import { flockView } from './flocks-service'

/** The one accessor every suite below uses, so no test has to cast its way into the document. */
const opAt = (doc: OpenApiDocument, path: string, method: Method): OperationObject => {
  const op = doc.paths[path]?.[method]
  if (!op) throw new Error(`no documented operation ${method.toUpperCase()} ${path}`)
  return op
}

const paramsOf = (doc: OpenApiDocument, path: string, method: Method = 'get') =>
  opAt(doc, path, method).parameters ?? []

const bodyPropsOf = (doc: OpenApiDocument, path: string, method: Method): Record<string, JsonSchema> => {
  const schema = opAt(doc, path, method).requestBody?.content['application/json']?.schema
  if (!schema?.properties) throw new Error(`no documented request body for ${method.toUpperCase()} ${path}`)
  return schema.properties
}

const bodySchemaOf = (doc: OpenApiDocument, path: string, method: Method): JsonSchema =>
  opAt(doc, path, method).requestBody?.content['application/json']?.schema ?? {}

/** Every `$ref` string anywhere in the document. */
function refsIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((c) => refsIn(c, out))
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$ref' && typeof v === 'string') out.push(v)
    else refsIn(v, out)
  }
  return out
}

/**
 * The two operations whose handlers do NOT go through `withAdmin`. Asserted against the route
 * modules themselves further down — this list is a claim, not an authority.
 */
const UNGUARDED = ['DELETE /keys/{id}', 'GET /openapi.json']

describe('buildOpenApiDocument', () => {
  test('declares OpenAPI 3.1', () => {
    expect(buildOpenApiDocument().openapi).toMatch(/^3\.1\./)
  })

  test('is deterministic — two builds serialise identically', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()))
  })

  test('documents DELETE /keys/{id} as 405, not as a delete', () => {
    const op = buildOpenApiDocument().paths['/keys/{id}']?.delete
    expect(Object.keys(op!.responses)).toEqual(['405'])
  })

  test('every path is declared under the v1 server, not with a v1 path prefix', () => {
    const doc = buildOpenApiDocument()
    expect(doc.servers[0].url).toBe('/api/admin/v1')
    for (const p of Object.keys(doc.paths)) expect(p.startsWith('/v1')).toBe(false)
  })

  test('the problem+json schema is a component every error response references', () => {
    expect(buildOpenApiDocument().components.schemas.Problem).toBeDefined()
  })

  test('carries no $schema key — 3.1 schema objects do not take one', () => {
    expect(JSON.stringify(buildOpenApiDocument())).not.toContain('$schema')
  })

  /**
   * `z.toJSONSchema` hoists a schema object reached twice into `$defs` and points `$ref` at
   * `#/$defs/...` — a pointer from the DOCUMENT root, which is only correct when the generated
   * schema IS the document. Embedded under `components.schemas` it resolves to nothing. Every
   * mirror is therefore built so no sub-schema is shared by identity; this is what pins that.
   */
  test('no generated schema smuggles in a root-relative $defs pointer', () => {
    const json = JSON.stringify(buildOpenApiDocument())
    expect(json).not.toContain('$defs')
    expect(json).not.toContain('#/$defs')
  })

  /**
   * There is no OpenAPI validator in this dependency tree and adding one is forbidden, so the
   * structural check this document most needs is done by hand: a `$ref` naming a component that
   * does not exist renders as a blank in every tool that reads it, and nothing else here would
   * catch it.
   */
  test('every $ref resolves to a component that exists', () => {
    const doc = buildOpenApiDocument()
    const components = doc.components as unknown as Record<string, Record<string, unknown>>
    const refs = refsIn(doc)
    const dangling = refs.filter((r) => {
      const m = /^#\/components\/(\w+)\/(.+)$/.exec(r)
      return !m || components[m[1]!]?.[m[2]!] === undefined
    })
    expect(dangling).toEqual([])
    // Positive anchor: an empty document would also have no dangling refs.
    expect(new Set(refs).size).toBeGreaterThan(10)
  })

  /**
   * The other direction, and the one that was wrong: five generated request bodies sat under
   * `components.schemas` with not a single `$ref` pointing at them, because every operation inlines
   * its own annotated copy. Two of them actively contradicted the operations — a published
   * `SavePaddockInput` carrying `id` (which `POST /paddocks` answers 422 on) and a bare `status`
   * (which `PUT /paddocks/{id}` ignores). Most generators emit a model per `components.schemas`
   * entry, so that shipped an SDK type describing the one body shape no operation accepts.
   */
  test('every published component is referenced — no decoy models', () => {
    const doc = buildOpenApiDocument()
    const refs = new Set(refsIn(doc))
    const published = [
      ...Object.keys(doc.components.schemas).map((n) => `#/components/schemas/${n}`),
      ...Object.keys(doc.components.responses).map((n) => `#/components/responses/${n}`),
    ]
    expect(published.filter((p) => !refs.has(p))).toEqual([])
    // Positive anchor: there really are components, so an empty `components` cannot pass this.
    expect(published.length).toBeGreaterThan(20)
  })

  test('only the two request bodies an operation uses VERBATIM are published as components', () => {
    const doc = buildOpenApiDocument()
    const names = Object.keys(doc.components.schemas)
    // Generated, used after `omit`/`annotate`, therefore never published: publishing them would
    // describe a body shape no operation accepts.
    for (const n of ['SaveFlockInput', 'SavePaddockInput', 'SaveFenceInput']) {
      expect({ n, published: names.includes(n) }).toEqual({ n, published: false })
    }
    // …and the two that ARE used verbatim are published AND pointed at, rather than inlined.
    expect(names).toEqual(expect.arrayContaining(['CreateKeyInput', 'TemplateDraft']))
    expect(bodySchemaOf(doc, '/keys', 'post').$ref).toBe('#/components/schemas/CreateKeyInput')
    expect(bodySchemaOf(doc, '/paddocks/{id}/templates', 'post').$ref)
      .toBe('#/components/schemas/TemplateDraft')
  })

  test('the shared enums are imported, not retyped', () => {
    const doc = buildOpenApiDocument()
    // Renaming a capability is a breaking change to every issued token; a literal here would go on
    // publishing the old name silently.
    expect(doc.components.schemas.ForbiddenProblem?.properties?.capability?.enum).toEqual([...CAPABILITIES])
    expect(doc.components.schemas.KeySummary?.properties?.status?.enum).toEqual([...KEY_STATUS])
    expect(doc.components.schemas.Paddock?.properties?.status?.enum).toEqual([...PADDOCK_STATUS])
    expect(doc.components.schemas.Paddock?.properties?.theme?.enum).toEqual([...PADDOCK_THEMES])
    expect(doc.components.schemas.Flock?.properties?.breed?.enum).toEqual([...BREED_IDS])
    expect(doc.components.schemas.QuotaRule?.properties?.dim?.enum).toEqual([...METER_DIMS])
  })

  test('the upstream credential is write-only: no response carries it, and the bodies say so', () => {
    const doc = buildOpenApiDocument()
    expect(doc.components.schemas.Flock?.properties).not.toHaveProperty('upstreamAuth')
    expect(doc.components.schemas.Flock?.properties?.hasUpstreamAuth?.type).toBe('boolean')
    for (const [path, method] of [['/flocks', 'post'], ['/flocks/{id}', 'put']] as const) {
      const field = bodySchemaOf(doc, path, method).properties?.upstreamAuth
      expect(field?.writeOnly, `${method} ${path}`).toBe(true)
    }
    // The PUT consequence of write-only, published where a client doing GET → edit → PUT will read it.
    const put = bodySchemaOf(doc, '/flocks/{id}', 'put').properties?.upstreamAuth?.description ?? ''
    expect(put).toMatch(/omit/i)
    expect(put).toMatch(/left (alone|untouched)|unchanged|keeps/i)
    expect(put).toMatch(/`null`.*clear/i)
  })

  /**
   * `z.toJSONSchema` emits ITS OWN regex beside a `format`, and v4's uuid regex demands an RFC
   * version nibble that the classic-v3 `z.string().uuid()` actually guarding these fields does not.
   * Publishing it would describe an API stricter than the one that runs, so the pattern is dropped
   * wherever a format sits beside it. A `pattern` alone is a real `.regex()` and stays.
   */
  test('no format carries a zod-version-specific pattern beside it', () => {
    const offenders: string[] = []
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) return node.forEach((c, i) => walk(c, `${at}[${i}]`))
      if (node === null || typeof node !== 'object') return
      const obj = node as Record<string, unknown>
      if ('format' in obj && 'pattern' in obj) offenders.push(at)
      for (const [k, v] of Object.entries(obj)) walk(v, `${at}.${k}`)
    }
    walk(buildOpenApiDocument(), '$')
    expect(offenders).toEqual([])
    // The positive anchor: formats really are present, so an empty offender list means something.
    expect(JSON.stringify(buildOpenApiDocument())).toContain('"format":"uuid"')
  })
})

/**
 * THE ROUTES ARE THE TRUTH. The plan's route table was written before the handlers existed, so a
 * document checked against the table would reproduce the table's mistakes. This walks the route
 * modules on disk and demands an exact set equality both ways: an operation the document invents
 * fails here, and so does a handler shipped without a description.
 *
 * Read as text rather than imported: a route module runs `buildBreedRegistry()` and resolves
 * `getDb` at import, and this test has no business standing up either to count exported verbs.
 */
const V1_DIR = join(import.meta.dirname, '../app/api/admin/v1')

/** One exported handler: its operation id, and whether its export line goes through `withAdmin`. */
interface DiskOperation {
  id: string
  guarded: boolean
}

function routeOperationsOnDisk(): DiskOperation[] {
  const out: DiskOperation[] = []
  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // `[id]` on disk is `{id}` in a URI template; every other segment is literal.
        const seg = /^\[(.+)\]$/.exec(entry.name)
        walk(join(dir, entry.name), [...segments, seg ? `{${seg[1]}}` : entry.name])
      } else if (entry.name === 'route.ts') {
        const src = readFileSync(join(dir, entry.name), 'utf8')
        for (const verb of ['GET', 'POST', 'PUT', 'DELETE']) {
          // Both spellings the repo uses: `export const GET = withAdmin(...)` and `export function GET`.
          const m = new RegExp(`^export (?:const|async function|function) ${verb}\\b(.*)$`, 'm').exec(src)
          // The wrapper is always applied on the export line itself, so the rest of that line is
          // the whole question: `= withAdmin(` versus a bare `(): Response {`.
          if (m) out.push({ id: `${verb} /${segments.join('/')}`, guarded: m[1]!.includes('withAdmin(') })
        }
      }
    }
  }
  walk(V1_DIR, [])
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

const diskOperationIds = (): string[] => routeOperationsOnDisk().map((o) => o.id)

function documentedOperations(): string[] {
  const doc = buildOpenApiDocument()
  const out: string[] = []
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item)) out.push(`${method.toUpperCase()} ${path}`)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

describe('the document describes the routes, not the plan', () => {
  test('the operation set matches the route modules on disk exactly', () => {
    expect(documentedOperations()).toEqual(diskOperationIds())
  })

  // A positive anchor for the set equality above: an empty walk would make it trivially true.
  test('the disk walk really found the v1 surface', () => {
    const ops = diskOperationIds()
    expect(ops.length).toBeGreaterThanOrEqual(25)
    expect(ops).toContain('DELETE /keys/{id}')
    expect(ops).toContain('GET /openapi.json')
    expect(ops).toContain('PUT /paddocks/{id}/templates/{tid}')
  })

  /**
   * ⚠ THE MOST SECURITY-RELEVANT CLAIM THIS DOCUMENT MAKES, and the one that must NOT be checked
   * against the document.
   *
   * Which operations require a bearer token was previously asserted only from `doc.paths[…].security`
   * — the document agreeing with itself. Under that, wrapping `openapi.json/route.ts` in `withAdmin`
   * left every test green while the document went on publishing "deliberately unauthenticated", and
   * dropping `withAdmin` from any of the other 23 left it going on demanding a bearer. That is the
   * second source of truth this whole task exists to remove, sitting on the one fact where being
   * wrong is a security incident rather than a documentation bug.
   *
   * So the authority is the route module's own export line, and the document is measured against it.
   */
  test('exactly two operations skip withAdmin, and they are the two the document names', () => {
    expect(routeOperationsOnDisk().filter((o) => !o.guarded).map((o) => o.id)).toEqual(UNGUARDED)
    // The positive anchor: the walk can tell the two apart, so an all-false read cannot pass.
    expect(routeOperationsOnDisk().filter((o) => o.guarded).length).toBe(23)
  })

  test('an operation opts out of the bearer requirement iff its handler skips withAdmin', () => {
    const doc = buildOpenApiDocument()
    for (const { id, guarded } of routeOperationsOnDisk()) {
      const [method, path] = id.split(' ') as [string, string]
      const op = opAt(doc, path, method.toLowerCase() as Method)
      // `security` absent = inherits the document-level bearer requirement; `[]` = opts out.
      expect({ id, optsOut: op.security !== undefined }).toEqual({ id, optsOut: !guarded })
      if (!guarded) expect(op.security).toEqual([])
    }
  })
})

describe('the authentication and error contract', () => {
  const doc = buildOpenApiDocument()
  const adminOps = Object.entries(doc.paths)
    .flatMap(([path, item]) =>
      (Object.keys(item) as Method[]).map((m) => ({ id: `${m.toUpperCase()} ${path}`, op: opAt(doc, path, m) })),
    )
    .filter((o) => !UNGUARDED.includes(o.id))

  test('every bearer-guarded operation documents the whole withAdmin error surface', () => {
    // 25 operations on disk, less the two that never reach `withAdmin`.
    expect(adminOps.length).toBe(23)
    for (const { id, op } of adminOps) {
      // The id rides in the assertion so a failure names the operation rather than a bare array.
      expect({ id, codes: Object.keys(op.responses) }).toEqual({
        id,
        codes: expect.arrayContaining(['400', '401', '403', '422', '500', '503']),
      })
    }
  })

  test('the 401 carries the bare Bearer challenge, with no error= parameter', () => {
    const res = doc.components.responses.Unauthorized!
    // An exact equality, not a subset match: a `const` of the bare scheme is the whole claim, and
    // `toMatchObject` would pass just as happily against a schema that also allowed a parameter.
    expect(res.headers?.['WWW-Authenticate']?.schema).toEqual({ type: 'string', const: 'Bearer' })
  })

  test('the 401 detail is documented as fixed, and why', () => {
    expect(doc.components.responses.Unauthorized!.description).toMatch(/enumerat/i)
  })

  test('the 503 carries Retry-After', () => {
    expect(doc.components.responses.KeySetUnavailable!.headers).toHaveProperty('Retry-After')
  })

  test('the 404 says a foreign-org resource is indistinguishable from a missing one', () => {
    expect(doc.components.responses.NotFound!.description).toMatch(/another org|foreign/i)
  })

  test('the 400 is the bearer-plus-cookie refusal, decided before verification', () => {
    expect(doc.components.responses.BothCredentials!.description).toMatch(/cookie/i)
    expect(doc.components.responses.BothCredentials!.description).toMatch(/before any token verification/i)
  })

  test('the 422 detail is the generic one, and errors[] is what identifies the source', () => {
    const schema = doc.components.schemas.ValidationProblem!
    expect(schema.properties?.detail).toMatchObject({ const: 'request failed validation' })
    expect(schema.properties?.errors).toBeDefined()
    // All three sources are named, because only `errors[]` tells them apart at runtime.
    expect(doc.components.responses.ValidationFailed!.description).toMatch(/body/)
    expect(doc.components.responses.ValidationFailed!.description).toMatch(/path id/)
    expect(doc.components.responses.ValidationFailed!.description).toMatch(/query/)
  })

  test('the 500 is documented as carrying no detail', () => {
    expect(doc.components.responses.InternalError!.description).toMatch(/no .?detail/i)
  })

  test('every operation but the openapi document itself requires the bearer scheme', () => {
    expect(doc.security).toEqual([{ bearerAuth: [] }])
    expect(opAt(doc, '/openapi.json', 'get').security).toEqual([])
    for (const { op } of adminOps) expect(op.security).toBeUndefined()
  })

  test('DELETE /keys/{id} answers on the method alone — no bearer, no other status', () => {
    const op = opAt(doc, '/keys/{id}', 'delete')
    expect(op.security).toEqual([])
    const r405 = op.responses['405']!
    expect(r405.headers).toHaveProperty('Allow')
    expect(r405.headers?.Allow?.schema).toMatchObject({ const: '' })
    expect(r405.description).toMatch(/revoke/)
  })
})

describe('pagination is documented only where it exists', () => {
  const doc = buildOpenApiDocument()
  const names = (path: string): string[] => paramsOf(doc, path).map((p) => p.name)

  test.each(['/flocks', '/paddocks', '/keys'])('%s is a cursor collection', (path) => {
    expect(names(path)).toEqual(['limit', 'cursor'])
    expect(opAt(doc, path, 'get').responses['200']?.headers).toHaveProperty('Link')
  })

  test('the limit maximum is rejected, not clamped, and says so', () => {
    const limit = paramsOf(doc, '/flocks').find((p) => p.name === 'limit')!
    // Read off `page.ts`'s own constants, so a change there fails here rather than shipping a lie.
    expect(limit.schema).toMatchObject({ default: DEFAULT_LIMIT, maximum: MAX_LIMIT })
    expect(limit.description).toMatch(/reject/i)
  })

  test('a full traversal ends on one empty page, and the collection says so', () => {
    expect(opAt(doc, '/flocks', 'get').description).toMatch(/empty page/i)
  })

  test.each(['/usage/matrix', '/usage/daily', '/usage/top-keys'])(
    '%s is a report: no cursor, no Link',
    (path) => {
      expect(names(path)).not.toContain('cursor')
      // The positive anchor: these really are the usage reports, with their own window params.
      expect(names(path)).toContain('startBucket')
      expect(opAt(doc, path, 'get').responses['200']?.headers).toBeUndefined()
    },
  )

  test('only the two reports that accept them document the keyId/paddockId filters', () => {
    expect(names('/usage/matrix')).toEqual(expect.arrayContaining(['keyId', 'paddockId']))
    expect(names('/usage/daily')).toEqual(expect.arrayContaining(['keyId', 'paddockId']))
    // `topKeys` accepts neither; a parameter parsed and dropped would read as a filter that works.
    expect(names('/usage/top-keys')).not.toContain('keyId')
    expect(names('/usage/top-keys')).not.toContain('paddockId')
  })

  test("top-keys' limit is a ranking N, not a page size, and carries no cursor", () => {
    const limit = paramsOf(doc, '/usage/top-keys').find((p) => p.name === 'limit')!
    expect(limit.schema).toMatchObject({ default: 10, maximum: 100 })
    expect(limit.description).toMatch(/ranking|not pagination/i)
  })
})

describe('the paddock field contract', () => {
  const doc = buildOpenApiDocument()
  const put = () => bodyPropsOf(doc, '/paddocks/{id}', 'put')
  const post = () => bodyPropsOf(doc, '/paddocks', 'post')

  test('status is READ-ONLY on the item PUT — accepted and silently ignored', () => {
    expect(put().status?.readOnly).toBe(true)
    expect(put().status?.description).toMatch(/ignored/i)
    expect(put().status?.description).toMatch(/PUT \/paddocks\/\{id\}\/status/)
  })

  test('status IS writable on POST /paddocks — a paddock can be created disabled', () => {
    expect(post().status?.readOnly).toBeUndefined()
    expect(post().status?.description).toMatch(/disabled/)
    // The asymmetry is the whole point, so the create body must name all three surfaces.
    expect(post().status?.description).toMatch(/PUT \/paddocks\/\{id\}/)
  })

  test('theme is defaulted, so an omitted theme RESETS it — unlike status', () => {
    expect(put().theme?.default).toBe('plain')
    expect(put().theme?.description).toMatch(/reset/i)
    // The two fields on one resource must not read the same way: one is an active write of a
    // default, the other is leave-it-alone.
    expect(put().status?.description).not.toMatch(/reset/i)
    expect(put().theme?.description).not.toMatch(/ignored/i)
  })

  test('POST /paddocks rejects an id in the body rather than updating', () => {
    expect(Object.keys(post())).not.toContain('id')
    // The positive anchor: the create body really is the paddock body, minus the id.
    expect(Object.keys(post()).sort()).toEqual(['flockId', 'name', 'slug', 'status', 'theme'])
    expect(opAt(doc, '/paddocks', 'post').description).toMatch(/422/)
  })

  test('the status sub-resource is the writable path, and names the asymmetry', () => {
    const op = opAt(doc, '/paddocks/{id}/status', 'put')
    expect(Object.keys(op.responses)).toContain('200')
    expect(op.description).toMatch(/POST \/paddocks/)
  })
})

describe('the fence contract', () => {
  const doc = buildOpenApiDocument()
  const op = () => opAt(doc, '/paddocks/{id}/fence', 'put')

  test('PUT is create-or-replace and answers 200 even when it creates', () => {
    expect(Object.keys(op().responses)).toContain('200')
    expect(Object.keys(op().responses)).not.toContain('201')
    expect(op().description).toMatch(/creates/i)
    expect(op().responses['200']?.description).toMatch(/created or replaced/i)
  })

  test('there is no DELETE for a fence, and the document does not invent one', () => {
    expect(doc.paths['/paddocks/{id}/fence']?.delete).toBeUndefined()
    expect(op().description).toMatch(/no DELETE/i)
  })

  test('it is documented as half-merge, not as a uniform full replace', () => {
    const props = bodyPropsOf(doc, '/paddocks/{id}/fence', 'put')
    expect(props.constraintJson?.description).toMatch(/preserv/i)
    expect(props.rateLimit?.description).toMatch(/null/i)
    expect(props.quota?.description).toMatch(/null/i)
    // The two halves must not read alike — that sameness is exactly the wrong documentation.
    expect(props.constraintJson?.description).not.toMatch(/sets the column to/i)
  })

  test('the path owns the paddock id, so the body does not offer one', () => {
    expect(Object.keys(bodyPropsOf(doc, '/paddocks/{id}/fence', 'put')).sort())
      .toEqual(['constraintJson', 'quota', 'rateLimit'])
  })
})

describe('the template contract', () => {
  const doc = buildOpenApiDocument()

  test('PUT with an unknown {tid} CREATES the template and answers 200, not 201', () => {
    const op = opAt(doc, '/paddocks/{id}/templates/{tid}', 'put')
    expect(Object.keys(op.responses)).toContain('200')
    expect(Object.keys(op.responses)).not.toContain('201')
    expect(op.description).toMatch(/creates/i)
  })

  test('POST answers 201 carrying the WHOLE collection, and no Location', () => {
    const op = opAt(doc, '/paddocks/{id}/templates', 'post')
    expect(Object.keys(op.responses)).toContain('201')
    expect(op.responses['201']?.headers).toBeUndefined()
    expect(op.responses['201']?.content?.['application/json']?.schema.type).toBe('array')
  })

  test('an invalid draft is honestly documented as landing on 500, not 422', () => {
    const op = opAt(doc, '/paddocks/{id}/templates', 'post')
    expect(op.description).toMatch(/validateDraft/)
    expect(op.description).toMatch(/500, not 422/)
  })

  test('{id} is a validated uuid; {tid} is deliberately unconstrained', () => {
    const params = paramsOf(doc, '/paddocks/{id}/templates/{tid}', 'put')
    const id = params.find((p) => p.name === 'id')!
    const tid = params.find((p) => p.name === 'tid')!
    expect(id.schema).toMatchObject({ type: 'string', format: 'uuid' })
    expect(id.description).toMatch(/422/)
    expect(tid.schema.format).toBeUndefined()
    expect(tid.schema.pattern).toBeUndefined()
    expect(tid.description).toMatch(/not a uuid/i)
  })
})

describe('the key contract', () => {
  const doc = buildOpenApiDocument()

  test('POST /keys returns the plaintext exactly once and says it is unrecoverable', () => {
    const schema = opAt(doc, '/keys', 'post').responses['201']?.content?.['application/json']?.schema
    expect(schema?.$ref).toBe('#/components/schemas/CreatedKey')
    const created = doc.components.schemas.CreatedKey!
    expect(created.properties?.plaintext?.description).toMatch(/once/i)
    expect(created.description).toMatch(/never/i)
  })

  test('the listing schema cannot even name the plaintext', () => {
    const summary = doc.components.schemas.KeySummary!
    expect(Object.keys(summary.properties ?? {})).not.toContain('plaintext')
    // Positive anchor: this really is the key listing, not an empty object.
    expect(Object.keys(summary.properties ?? {})).toEqual(
      expect.arrayContaining(['id', 'name', 'prefix', 'status', 'paddockSlugs']),
    )
  })

  test('revoke is 204 and documented as idempotent, with no second audit row', () => {
    const op = opAt(doc, '/keys/{id}/revoke', 'post')
    expect(Object.keys(op.responses)).toContain('204')
    expect(Object.keys(op.responses)).toContain('404')
    expect(op.description).toMatch(/idempotent/i)
    expect(op.description).toMatch(/no \*\*second audit row\*\*|no second audit row/i)
  })
})

/**
 * The mirrors exist because `zod/v4`'s `toJSONSchema` cannot read a classic-v3 schema (it reaches
 * for `schema._zod.def`, which a v3 schema has no such thing as). A hand-kept mirror is a second
 * source of truth waiting to drift, so it is tied back to the real schema here: same field names,
 * same optionality, and the same accept/reject verdict on payloads that probe every constraint.
 */
describe('each generated request body still mirrors the schema the service parses', () => {
  const SAMPLES: Record<string, unknown[]> = {
    SaveFlockInput: [
      {},
      { breed: 'ollama', name: 'f', baseUrl: 'http://o:11434', tlsTrust: true },
      { breed: 'ollama', name: 'f', baseUrl: 'http://o:11434', tlsTrust: true, upstreamAuth: null },
      { breed: 'nope', name: 'f', baseUrl: 'http://o:11434', tlsTrust: true },
      { breed: 'ollama', name: '   ', baseUrl: 'http://o:11434', tlsTrust: true },
      { breed: 'ollama', name: 'x'.repeat(121), baseUrl: 'http://o:11434', tlsTrust: true },
      { breed: 'ollama', name: 'f', baseUrl: 'not-a-url', tlsTrust: true },
      { breed: 'ollama', name: 'f', baseUrl: 'http://o:11434', tlsTrust: 'yes' },
      { id: 'not-a-uuid', breed: 'ollama', name: 'f', baseUrl: 'http://o:11434', tlsTrust: true },
    ],
    SavePaddockInput: [
      {},
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: 'ok-slug' },
      // The `max(120)` boundary, previously unprobed here: 121 sits between the real bound and any
      // plausible wrong one, so widening or narrowing it in one schema alone fails this row.
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'x'.repeat(121), slug: 'ok-slug' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: '   ', slug: 'ok-slug' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: 'ok-slug', status: 'disabled' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: 'ok-slug', status: 'paused' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: '-bad' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: 'Bad' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: 'x'.repeat(65) },
      { flockId: 'nope', name: 'p', slug: 'ok-slug' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: 'ok', theme: 'metaboy' },
      { flockId: '00000000-0000-4000-8000-000000000000', name: 'p', slug: 'ok', theme: 'neon' },
    ],
    SaveFenceInput: [
      {},
      { paddockId: '00000000-0000-4000-8000-000000000000' },
      { paddockId: '00000000-0000-4000-8000-000000000000', rateLimit: null, quota: null },
      { paddockId: '00000000-0000-4000-8000-000000000000', rateLimit: { windowSec: 60, max: 0 } },
      { paddockId: '00000000-0000-4000-8000-000000000000', rateLimit: { windowSec: 0, max: 1 } },
      { paddockId: '00000000-0000-4000-8000-000000000000', quota: [{ dim: 'tokens_in', max: 1, period: 'day' }] },
      { paddockId: '00000000-0000-4000-8000-000000000000', quota: [{ dim: 'nope', max: 1, period: 'day' }] },
      { paddockId: '00000000-0000-4000-8000-000000000000', quota: [{ dim: 'images', max: -1, period: 'week' }] },
      { paddockId: '00000000-0000-4000-8000-000000000000', constraintJson: { templates: [] } },
    ],
    CreateKeyInput: [
      {},
      { name: 'k', paddockIds: ['00000000-0000-4000-8000-000000000000'] },
      { name: 'k', paddockIds: [] },
      { name: '', paddockIds: ['00000000-0000-4000-8000-000000000000'] },
      // The `max(120)` boundary, previously unprobed on this schema too.
      { name: 'x'.repeat(121), paddockIds: ['00000000-0000-4000-8000-000000000000'] },
      { name: 'k', paddockIds: ['nope'] },
      { name: 'k', paddockIds: ['00000000-0000-4000-8000-000000000000'], expiresAt: '2026-01-01T00:00:00Z' },
      { name: 'k', paddockIds: ['00000000-0000-4000-8000-000000000000'], expiresAt: 'tomorrow' },
      {
        name: 'k', paddockIds: ['00000000-0000-4000-8000-000000000000'],
        overrides: { rateLimit: { windowSec: 60, max: 10 } },
      },
      {
        name: 'k', paddockIds: ['00000000-0000-4000-8000-000000000000'],
        overrides: { rateLimit: { windowSec: -1, max: 10 } },
      },
    ],
    TemplateDraft: [
      {},
      { id: 't', graphText: '{}', params: [], cost: 0 },
      { id: '', graphText: '{}', params: [], cost: 0 },
      // `graphText` is a bare `z.string()` with NO minimum — it is the route's job to reject an
      // unparseable graph, not the draft schema's. An empty one must be ACCEPTED by both, so a
      // mirror that helpfully added `.min(1)` fails here rather than publishing a constraint the
      // service does not enforce.
      { id: 't', graphText: '', params: [], cost: 0 },
      { id: 't', graphText: '{}', params: [], cost: -1 },
      { id: 't', graphText: '{}', params: [{ name: 'p', type: 'text', target: { node: '1', input: 'x' } }], cost: 0 },
      { id: 't', graphText: '{}', params: [{ name: 'p', type: 'text', target: { node: '', input: 'x' } }], cost: 0 },
      { id: 't', graphText: '{}', params: [{ name: 'p', type: 'seed', targets: [] }], cost: 0 },
      { id: 't', graphText: '{}', params: [{ name: 'p', type: 'seed', targets: [{ node: '1', input: 'x' }] }], cost: 0 },
      { id: 't', graphText: '{}', params: [{ name: 'p', type: 'wat', target: { node: '1', input: 'x' } }], cost: 0 },
      {
        id: 't', graphText: '{}', cost: 2,
        params: [{ name: 'p', type: 'number', target: { node: '1', input: 'x' }, min: 1, max: 9 }],
      },
    ],
  }

  const MIRROR_NAMES = Object.keys(REQUEST_BODY_MIRRORS)

  /**
   * Optionality, asked of the field itself. Structurally typed rather than reaching for a zod type,
   * because the two halves of each pair are different major versions of zod — a v3 `ZodTypeAny` and
   * a v4 `$ZodType` — and `safeParse(undefined)` is the one question both answer the same way.
   */
  const acceptsUndefined = (field: unknown): boolean =>
    (field as { safeParse: (v: unknown) => { success: boolean } }).safeParse(undefined).success

  /** A classic-v3 field's `.default()` value, if it has one. */
  const v3DefaultOf = (field: unknown): { has: boolean; value?: unknown } => {
    const def = (field as { _def?: { typeName?: string; defaultValue?: () => unknown } })._def
    return def?.typeName === 'ZodDefault' && typeof def.defaultValue === 'function'
      ? { has: true, value: def.defaultValue() }
      : { has: false }
  }

  test.each(MIRROR_NAMES)('%s has the source schema\'s field set, field by field', (name) => {
    const { source, mirror } = REQUEST_BODY_MIRRORS[name]!
    expect(Object.keys(mirror.shape).sort()).toEqual(Object.keys(source.shape).sort())
    /**
     * Names alone are not the shape. `Object.keys` parity plus samples that are mostly
     * all-fields-present is blind to a required field turning optional — measured against
     * `SaveFlockInput.tlsTrust`, which flipped without either half noticing. Optionality is
     * whether the field accepts `undefined`, so ask each field directly.
     */
    for (const key of Object.keys(source.shape)) {
      expect(`${key}: accepts undefined = ${acceptsUndefined(mirror.shape[key])}`)
        .toBe(`${key}: accepts undefined = ${acceptsUndefined(source.shape[key])}`)
    }
  })

  /**
   * ⚠ THE BRIDGE FROM "PARSES THE SAME" TO "DESCRIBES THE SAME".
   *
   * Everything else in this suite compares parse verdicts, which makes it blind by construction to
   * anything that changes the emitted JSON Schema without changing accept/reject. Default VALUES are
   * the live case, and they are load-bearing: the whole documented "omitting `theme` RESETS it"
   * contract rests on the published `"default": "plain"` literal. Change the source default to
   * `'metaboy'` and both schemas go on accepting and rejecting identically while the document keeps
   * publishing `plain` — a client omitting the field would be told the wrong thing about what it
   * just wrote. So the published literal is compared to the v3 schema's own `defaultValue()`.
   */
  test.each(MIRROR_NAMES)('%s publishes the source schema\'s own default values', (name) => {
    const { source } = REQUEST_BODY_MIRRORS[name]!
    const fromSource = Object.entries(source.shape)
      .flatMap(([k, f]) => { const d = v3DefaultOf(f); return d.has ? [[k, d.value] as const] : [] })
    const published = Object.entries(GENERATED_REQUEST_SCHEMAS[name]?.properties ?? {})
      .flatMap(([k, s]) => ('default' in s ? [[k, s.default] as const] : []))
    expect(Object.fromEntries(published)).toEqual(Object.fromEntries(fromSource))
  })

  // The positive anchor for the bridge above: without a single defaulted field anywhere, that
  // table compares two empty objects five times and proves nothing.
  test('the default bridge is exercised — SavePaddockInput.theme really carries one', () => {
    expect(v3DefaultOf(REQUEST_BODY_MIRRORS.SavePaddockInput!.source.shape.theme))
      .toEqual({ has: true, value: 'plain' })
    expect(GENERATED_REQUEST_SCHEMAS.SavePaddockInput?.properties?.theme?.default).toBe('plain')
  })

  /**
   * The same bridge for optionality: what the ARTIFACT publishes as `required`, against what the v3
   * schema actually demands. The field-by-field check above ties the mirror to the source; this ties
   * the emitted JSON Schema to the source, which is what a client reads.
   */
  test.each(MIRROR_NAMES)('%s publishes the source schema\'s own required set', (name) => {
    const { source } = REQUEST_BODY_MIRRORS[name]!
    const requiredInSource = Object.entries(source.shape)
      .filter(([, f]) => !acceptsUndefined(f))
      .map(([k]) => k)
      .sort()
    const published = [...((GENERATED_REQUEST_SCHEMAS[name]?.required as string[] | undefined) ?? [])].sort()
    expect(published).toEqual(requiredInSource)
  })

  test.each(MIRROR_NAMES)('%s accepts and rejects exactly what the source does', (name) => {
    const { source, mirror } = REQUEST_BODY_MIRRORS[name]!
    const samples = SAMPLES[name]!
    // The positive anchor: a mirror and a source that both reject everything would agree perfectly
    // and describe nothing, so the sample set must exercise both verdicts.
    const verdicts = samples.map((s) => source.safeParse(s).success)
    expect(new Set(verdicts).size).toBe(2)
    for (const [i, sample] of samples.entries()) {
      expect(`${i}:${mirror.safeParse(sample).success}`).toBe(`${i}:${verdicts[i]}`)
    }
  })
})

/**
 * The response components are hand-written — a drizzle row is not a Zod schema, so there is nothing
 * to generate from. `db.select().from(t)` returns every column, so the column list IS the response
 * shape, and this is what stops a migration from silently making the document wrong. A flock is the
 * exception: its service selects the `flockView` allowlist, so that is its shape.
 */
describe('resource response schemas match the columns the handlers actually return', () => {
  const doc = buildOpenApiDocument()
  test.each([
    ['Flock', flockView],
    ['Paddock', getTableColumns(paddock)],
    ['Fence', getTableColumns(fence)],
  ])('%s documents every column and invents none', (name, columns) => {
    const documented = Object.keys(doc.components.schemas[name as string]?.properties ?? {}).sort()
    expect(documented).toEqual(Object.keys(columns).sort())
  })
})
