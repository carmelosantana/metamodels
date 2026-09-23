import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { COMMANDS } from '../src/commands.js'

/**
 * Ties the CLI to the admin API it drives. `docs/api/openapi.json` is generated from the real
 * routes and CI fails when it is stale, so a command that drifts from the API fails here.
 */

interface Operation { operationId: string; parameters?: Array<{ name: string; in: string; required?: boolean }>; requestBody?: unknown }
const doc = JSON.parse(readFileSync(fileURLToPath(new URL('../../../docs/api/openapi.json', import.meta.url)), 'utf8')) as {
  paths: Record<string, Record<string, Operation>>
}

function operation(method: string, path: string): Operation | undefined {
  return doc.paths[path]?.[method.toLowerCase()]
}

/** Operations no command should reach: the unauthenticated schema, and the refused key delete. */
const NOT_COMMANDS = new Set(['getOpenApiDocument', 'deleteKeyRefused'])

describe('CLI commands against docs/api/openapi.json', () => {
  test('the document is the one we think it is: it holds the refused key delete', () => {
    expect(operation('DELETE', '/keys/{id}')?.operationId).toBe('deleteKeyRefused')
    expect(operation('POST', '/keys/{id}/revoke')?.operationId).toBe('revokeKey')
  })

  test.each(COMMANDS.map((c) => [`${c.group} ${c.action}`, c] as const))('%s matches its operation: path, parameters, required flags and body', (_name, c) => {
    const op = operation(c.method, c.path)
    expect(op, `${c.method} ${c.path} is not in the OpenAPI document`).toBeDefined()
    expect(NOT_COMMANDS.has(op!.operationId)).toBe(false)
    const params = op!.parameters ?? []
    // Every path parameter the command fills is one the operation declares, and vice versa.
    const templated = [...c.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    expect(params.filter((p) => p.in === 'path').map((p) => p.name).sort()).toEqual(templated)
    // Every query parameter the command can send is declared.
    const declared = params.filter((p) => p.in === 'query').map((p) => p.name)
    for (const q of c.query) expect(declared, `${c.group} ${c.action} --${q.name}`).toContain(q.name)
    // The flags --help shows as required are exactly the operation's required query parameters.
    const required = params.filter((p) => p.in === 'query' && p.required === true).map((p) => p.name).sort()
    expect(c.query.filter((q) => q.required).map((q) => q.name).sort(), `${c.group} ${c.action} required`).toEqual(required)
    // A command sends a body exactly when the operation takes one.
    expect(c.body !== 'none', `${c.group} ${c.action} body`).toBe(op!.requestBody !== undefined)
  })

  test('the document does mark some query parameters required, so the check above can fail', () => {
    expect(operation('GET', '/usage/daily')!.parameters!.filter((p) => p.required).map((p) => p.name).sort())
      .toEqual(['dim', 'endBucket', 'startBucket'])
  })

  test('no command reaches a DELETE on the keys path', () => {
    const keyDeletes = COMMANDS.filter((c) => c.method === 'DELETE' && c.path.startsWith('/keys'))
    expect(keyDeletes).toEqual([])
    // ...while DELETE is reachable where it means "gone", so the filter above can match something.
    expect(COMMANDS.some((c) => c.method === 'DELETE' && c.path === '/flocks/{id}')).toBe(true)
    expect(COMMANDS.find((c) => c.group === 'keys' && c.action === 'revoke'))
      .toMatchObject({ method: 'POST', path: '/keys/{id}/revoke' })
  })

  test('every other operation is reached by exactly one command', () => {
    const reached = COMMANDS.map((c) => operation(c.method, c.path)!.operationId).sort()
    const all = Object.values(doc.paths).flatMap((ops) => Object.values(ops).map((o) => o.operationId))
      .filter((id) => !NOT_COMMANDS.has(id)).sort()
    expect(reached).toEqual(all)
  })
})
