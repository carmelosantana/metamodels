import { describe, expect, test } from 'vitest'
import { byToolName, toolDefProblems, type McpToolDef } from '../src/mcp.js'

function tool(name: string, over: Partial<McpToolDef> = {}): McpToolDef {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false },
    ...over,
  }
}

describe('toolDefProblems', () => {
  test('accepts a valid, sorted set', () => {
    expect(toolDefProblems([tool('a.b'), tool('chat'), tool('run_x-1')])).toEqual([])
    expect(toolDefProblems([])).toEqual([])
  })

  test('rejects names outside the MCP character set or length', () => {
    expect(toolDefProblems([tool('has space')])).toEqual(['tool 0: invalid name "has space"'])
    expect(toolDefProblems([tool('x'.repeat(129))])[0]).toMatch(/^tool 0: invalid name/)
    expect(toolDefProblems([tool('')])[0]).toMatch(/^tool 0: invalid name/)
  })

  test('rejects duplicates and unsorted output', () => {
    expect(toolDefProblems([tool('a'), tool('a')])).toContain('tool 1: duplicate name a')
    expect(toolDefProblems([tool('b'), tool('a')])).toContain('tools must be sorted by name: "b" before "a"')
  })

  test('rejects an empty description', () => {
    expect(toolDefProblems([tool('a', { description: '  ' })])).toEqual(['a: empty description'])
  })

  test('rejects a non-object input schema', () => {
    const bad = tool('a', { inputSchema: { type: 'string' } as unknown as McpToolDef['inputSchema'] })
    expect(toolDefProblems([bad])).toContain('a: inputSchema.type must be "object"')
  })

  test('rejects a required property that is not declared', () => {
    const bad = tool('a', { inputSchema: { type: 'object', properties: {}, required: ['ghost'], additionalProperties: false } })
    expect(toolDefProblems([bad])).toEqual(['a: required "ghost" is not a declared property'])
  })

  test('rejects an input schema that allows undeclared properties', () => {
    const loose = tool('a', { inputSchema: { type: 'object', properties: {} } })
    expect(toolDefProblems([loose])).toEqual(['a: inputSchema must set additionalProperties: false'])
  })
})

describe('byToolName', () => {
  test('sorts in code-unit order, the order toolDefProblems checks', () => {
    const sorted = [tool('b'), tool('a'), tool('B'), tool('a.b')].sort(byToolName)
    expect(sorted.map((t) => t.name)).toEqual(['B', 'a', 'a.b', 'b'])
    expect(toolDefProblems(sorted)).toEqual([])
  })
})
