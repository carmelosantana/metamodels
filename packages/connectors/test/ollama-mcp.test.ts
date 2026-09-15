import { describe, expect, test } from 'vitest'
import { ollamaBreed, ollamaConstraint, ollamaToMcp, toolDefProblems, type OllamaConstraint } from '../src/index.js'

const fence = (raw: unknown): OllamaConstraint => ollamaConstraint.parse(raw)
const names = (f: OllamaConstraint) => ollamaToMcp(f).map((t) => t.name)
const ALL = ['chat', 'generate', 'embed', 'read']

describe('ollamaToMcp', () => {
  test('the default fence exposes chat with a free-form model', () => {
    const tools = ollamaToMcp(fence({}))
    expect(tools.map((t) => t.name)).toEqual(['chat'])
    expect(tools[0].inputSchema.properties?.model).toEqual({ type: 'string', minLength: 1, description: expect.any(String) })
    expect(tools[0].inputSchema.required).toEqual(['model', 'messages'])
    expect(toolDefProblems(tools)).toEqual([])
  })

  test('one tool per allowed route group, sorted by name', () => {
    const f = fence({ allowedRoutes: ['read', 'generate', 'embed', 'chat'] })
    expect(names(f)).toEqual(['chat', 'embed', 'generate', 'list_models'])
    expect(toolDefProblems(ollamaToMcp(f))).toEqual([])
  })

  test('a model allowlist becomes a sorted, de-duplicated enum on every inference tool', () => {
    const f = fence({ allowedRoutes: ['chat', 'generate', 'embed'], allowedModels: ['qwen3:8b', 'llama3.2', 'qwen3:8b'] })
    const tools = ollamaToMcp(f)
    expect(tools).toHaveLength(3)
    for (const t of tools) expect(t.inputSchema.properties?.model).toMatchObject({ type: 'string', enum: ['llama3.2', 'qwen3:8b'] })
  })

  test('an empty allowlist leaves no inference tool', () => {
    expect(names(fence({ allowedRoutes: ['chat', 'read'], allowedModels: [] }))).toEqual(['list_models'])
    expect(names(fence({ allowedRoutes: ['chat'], allowedModels: [] }))).toEqual([])
  })

  test('never a model-management tool, and a fence cannot ask for one', () => {
    for (const n of names(fence({ allowedRoutes: ALL }))) expect(n).not.toMatch(/pull|push|create|copy|delete|blob/)
    expect(ollamaConstraint.safeParse({ allowedRoutes: ['mutate'] }).success).toBe(false)
  })

  test('every tool is annotated read-only and closed-world', () => {
    for (const t of ollamaToMcp(fence({ allowedRoutes: ALL }))) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
    }
  })

  test('pure: a frozen fence is not mutated and the output is stable', () => {
    const f = fence({ allowedRoutes: ['read', 'chat'], allowedModels: ['b', 'a'] })
    Object.freeze(f.allowedRoutes)
    Object.freeze(f.allowedModels)
    Object.freeze(f)
    expect(ollamaToMcp(f)).toEqual(ollamaToMcp(f))
    expect(f.allowedModels).toEqual(['b', 'a'])
  })

  test('is wired into the breed', () => {
    expect(ollamaBreed.toMcp).toBe(ollamaToMcp)
  })
})
