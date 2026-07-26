import { describe, expect, test } from 'vitest'
import { ollamaBreed, ollamaConstraint, routeGroup } from '../src/ollama/index.js'
import type { RequestCtx } from '../src/breed.js'

function ctx(path: string, body: unknown = {}, method = 'POST'): RequestCtx {
  return { method, path, headers: {}, body, paddockSlug: 'p' }
}
const fence = (over = {}) => ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: null, ...over })

describe('routeGroup', () => {
  test.each([
    ['/api/chat', 'chat'], ['/v1/chat/completions', 'chat'],
    ['/api/generate', 'generate'], ['/v1/completions', 'generate'],
    ['/api/embed', 'embed'], ['/api/embeddings', 'embed'], ['/v1/embeddings', 'embed'],
    ['/api/tags', 'read'], ['/api/version', 'read'], ['/v1/models', 'read'],
    ['/api/pull', 'mutate'], ['/api/delete', 'mutate'], ['/api/blobs/sha256:abc', 'mutate'],
    ['/api/nonsense', 'unknown'],
  ])('%s -> %s', (path, group) => {
    expect(routeGroup(path)).toBe(group)
  })
})

describe('ollamaBreed.guard', () => {
  test('denies MUTATE routes with 403 before any upstream call', () => {
    const r = ollamaBreed.guard(ctx('/api/pull', { name: 'llama3' }), fence())
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  test('denies a route group not in allowedRoutes', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'x' }), fence({ allowedRoutes: ['read'] }))
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  test('denies a model not on the allowlist', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'llama3:70b' }), fence({ allowedModels: ['llama3.2:1b'] }))
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  test('allows an allowlisted model and passes the body through', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'llama3.2:1b', messages: [] }), fence({ allowedModels: ['llama3.2:1b'] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.request.body as { model: string }).model).toBe('llama3.2:1b')
  })

  test('allows all models when allowedModels is null', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'anything' }), fence())
    expect(r.ok).toBe(true)
  })

  test('injects stream_options.include_usage on /v1 streaming requests', () => {
    const r = ollamaBreed.guard(ctx('/v1/chat/completions', { model: 'm', stream: true }), fence())
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.request.body as { stream_options: { include_usage: boolean } }).stream_options.include_usage).toBe(true)
  })

  test('read routes need no model and are allowed when "read" is permitted', () => {
    const r = ollamaBreed.guard(ctx('/api/tags', undefined, 'GET'), fence())
    expect(r.ok).toBe(true)
  })
})
