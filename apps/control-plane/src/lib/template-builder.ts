import type { WorkflowTemplate } from '@metamodels/connectors'
import { graphSchema } from './template-schema'

export type BuildResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Parse pasted workflow-API JSON into a validated graph, or a friendly reason. */
export function parseGraphText(text: string): BuildResult<WorkflowTemplate['graph']> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'graph is not valid JSON' }
  }
  const parsed = graphSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'not a valid workflow-API graph (each node needs class_type + inputs)' }
  return { ok: true, value: parsed.data }
}

/** Enumerate selectable binding targets: each node id with its input keys, deterministically sorted. */
export function graphTargets(graph: WorkflowTemplate['graph']): { node: string; inputs: string[] }[] {
  return Object.keys(graph)
    .sort()
    .map((node) => ({ node, inputs: Object.keys(graph[node].inputs).sort() }))
}
