/**
 * MCP tool definitions, per the MCP specification revision 2026-07-28 (server/tools).
 *
 * A breed's `toMcp(fence)` returns these; M4's per-paddock endpoint serves them from `tools/list`.
 * `annotations` are hints for clients and are never read for enforcement: the spec requires
 * clients to treat them as untrusted, and MetaModels enforces in `guard()` / `reconstructGraph()`.
 */

export type JsonSchema = { [keyword: string]: unknown }

export type JsonSchemaObject = JsonSchema & {
  type: 'object'
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolDef {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchemaObject
  annotations?: McpToolAnnotations
}

/** The spec says tool names SHOULD be 1–128 of [A-Za-z0-9_.-]. MetaModels treats that as MUST. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/

/** Sort comparator for tool lists: plain code-unit order, deterministic and locale-independent. */
export function byToolName(a: McpToolDef, b: McpToolDef): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Every invariant a breed's toMcp output must hold, as human-readable problems (empty = valid).
 * Order is plain code-unit order — deterministic and locale-independent.
 */
export function toolDefProblems(defs: readonly McpToolDef[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  defs.forEach((def, i) => {
    if (!MCP_TOOL_NAME.test(def.name)) problems.push(`tool ${i}: invalid name ${JSON.stringify(def.name)}`)
    if (seen.has(def.name)) problems.push(`tool ${i}: duplicate name ${def.name}`)
    else if (i > 0 && !(defs[i - 1].name < def.name)) {
      problems.push(`tools must be sorted by name: ${JSON.stringify(defs[i - 1].name)} before ${JSON.stringify(def.name)}`)
    }
    seen.add(def.name)

    if (!def.description.trim()) problems.push(`${def.name}: empty description`)
    const schema = def.inputSchema
    if (schema?.type !== 'object') {
      problems.push(`${def.name}: inputSchema.type must be "object"`)
      return
    }
    if (schema.additionalProperties !== false) problems.push(`${def.name}: inputSchema must set additionalProperties: false`)
    for (const r of schema.required ?? []) {
      if (!schema.properties || !Object.hasOwn(schema.properties, r)) {
        problems.push(`${def.name}: required ${JSON.stringify(r)} is not a declared property`)
      }
    }
  })
  return problems
}
