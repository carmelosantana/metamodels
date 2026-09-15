import { byToolName, type JsonSchema, type McpToolDef } from '../mcp.js'
import type { ComfyConstraint } from './breed.js'
import type { ParamSpec, WorkflowTemplate } from './template.js'

export const JOB_RESULT_TOOL = 'get_job_result'
const PREFIX = 'run_'
const MAX_NAME = 128

/** `run_` + the template id, made safe for MCP's tool-name charset and length. */
export function comfyToolName(templateId: string): string {
  const safe = templateId.replace(/[^A-Za-z0-9_.-]/g, '_') || '_'
  return `${PREFIX}${safe}`.slice(0, MAX_NAME)
}

/**
 * Tool name → template id for every reachable template, in template order. Sanitising can make
 * two ids collide (`a b`, `a_b`); later ones get `_2`, `_3`… A repeated id is skipped: the
 * submit flow resolves the first template with that id, so a second tool could never reach its
 * own template. M4 inverts tool calls through this map — never by un-sanitising a name.
 */
export function comfyToolNames(templates: readonly Pick<WorkflowTemplate, 'id'>[]): Map<string, string> {
  const names = new Map<string, string>()
  const seen = new Set<string>()
  for (const { id } of templates) {
    if (seen.has(id)) continue
    seen.add(id)
    const base = comfyToolName(id)
    let name = base
    for (let n = 2; names.has(name); n++) {
      const suffix = `_${n}`
      name = base.slice(0, MAX_NAME - suffix.length) + suffix
    }
    names.set(name, id)
  }
  return names
}

function paramSchema(spec: Exclude<ParamSpec, { type: 'seed' }>): JsonSchema {
  switch (spec.type) {
    case 'text':
      return { type: 'string' }
    case 'number': {
      const s: JsonSchema = { type: 'number' }
      if (spec.min !== undefined) s.minimum = spec.min
      if (spec.max !== undefined) s.maximum = spec.max
      return s
    }
    case 'image':
      return { type: 'string', contentEncoding: 'base64', description: 'Base64-encoded image bytes.' }
  }
}

function runTool(name: string, tpl: WorkflowTemplate): McpToolDef {
  // Seeds are randomised server-side on every run, so they are never a caller input.
  // Object.fromEntries defines own properties, so a param named "__proto__" stays data.
  const properties = Object.fromEntries(
    tpl.params.flatMap((spec) => (spec.type === 'seed' ? [] : [[spec.name, paramSchema(spec)] as const])),
  )
  const units = `${tpl.cost} job unit${tpl.cost === 1 ? '' : 's'}`
  return {
    name,
    title: `Run ${tpl.id}`,
    description:
      `Run the operator-approved ComfyUI workflow "${tpl.id}". Every parameter is optional; an omitted one ` +
      `keeps the template's own value. Returns a job_id: pass it to ${JOB_RESULT_TOOL} for the output. ` +
      `Each run costs ${units}.`,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }
}

function jobResultTool(): McpToolDef {
  return {
    name: JOB_RESULT_TOOL,
    title: 'Get job result',
    description: "Fetch the status and outputs of a job started by one of this paddock's run_ tools. Only the caller's own jobs are visible.",
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', minLength: 1 } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }
}

/**
 * ComfyUI's MCP tools for one paddock (spec §4.4): one `run_<template>` per approved template,
 * plus `get_job_result` whenever there is anything to run. Raw graphs are no more reachable
 * through MCP than through REST — every tool funnels into `handle` → `reconstructGraph`.
 */
export function comfyToMcp(fence: ComfyConstraint): McpToolDef[] {
  const byId = new Map<string, WorkflowTemplate>()
  for (const t of fence.templates) if (!byId.has(t.id)) byId.set(t.id, t)
  const tools = [...comfyToolNames(fence.templates)].map(([name, id]) => runTool(name, byId.get(id)!))
  if (tools.length > 0) tools.push(jobResultTool())
  return tools.sort(byToolName)
}
