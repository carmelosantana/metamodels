import { z } from 'zod'

// Client-safe: imports only zod. The graph type is inlined (structurally identical to the
// connector's WorkflowTemplate['graph']) because @metamodels/connectors depends on this
// package — importing it here, even type-only, would be a cycle.

/** A ComfyUI workflow-API graph: node id → { class_type, inputs }. */
export type WorkflowGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export const graphSchema: z.ZodType<WorkflowGraph> = z.record(
  z.object({ class_type: z.string().min(1), inputs: z.record(z.unknown()) }),
) as z.ZodType<WorkflowGraph>

export type BuildResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Parse pasted workflow-API JSON into a validated graph, or a friendly reason. Never throws. */
export function parseGraphText(text: string): BuildResult<WorkflowGraph> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'graph is not valid JSON' }
  }
  const parsed = graphSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: 'not a valid workflow-API graph (each node needs class_type + inputs)' }
  }
  return { ok: true, value: parsed.data }
}

/** Enumerate selectable binding targets: each node id with its input keys, deterministically sorted. */
export function graphTargets(graph: WorkflowGraph): { node: string; inputs: string[] }[] {
  return Object.keys(graph)
    .sort()
    .map((node) => ({ node, inputs: Object.keys(graph[node].inputs).sort() }))
}
