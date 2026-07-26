export type ParamSpec =
  | { name: string; type: 'text'; target: { node: string; input: string } }
  | { name: string; type: 'seed'; targets: { node: string; input: string }[] }
  | { name: string; type: 'number'; target: { node: string; input: string }; min?: number; max?: number }
  | { name: string; type: 'image'; target: { node: string; input: string } }

export interface WorkflowTemplate {
  id: string
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  params: ParamSpec[]
  cost: number
}

type ReconstructResult =
  | { ok: true; graph: WorkflowTemplate['graph'] }
  | { ok: false; reason: string }

/**
 * Validate consumer-supplied `params` against the operator's stored template and
 * rebuild the full node graph server-side. This is the security heart of the
 * ComfyUI connector: a consumer can only touch inputs that a declared `ParamSpec`
 * points at — undeclared params are rejected and can never reach the graph, and
 * raw node graphs are structurally impossible.
 *
 * Pure function, no I/O. The returned graph is a deep clone; the stored template
 * is never mutated.
 */
export function reconstructGraph(
  tpl: WorkflowTemplate,
  params: Record<string, unknown>,
  opts: { uploads?: Record<string, string>; rng?: () => number },
): ReconstructResult {
  // Deep-clone first — never mutate the stored template.
  const graph = structuredClone(tpl.graph)

  const specByName = new Map<string, ParamSpec>()
  for (const spec of tpl.params) specByName.set(spec.name, spec)

  // Core security property: every supplied key must map to a declared spec.
  for (const key of Object.keys(params)) {
    if (!specByName.has(key)) return { ok: false, reason: `unknown param: ${key}` }
  }

  const rng = opts.rng ?? Math.random

  // Helper: resolve a target's inputs object, or fail defensively if the node
  // (or its inputs) is missing from a misconfigured template.
  function inputsFor(
    name: string,
    node: string,
  ): { inputs: Record<string, unknown> } | { err: string } {
    const n = graph[node]
    if (!n || typeof n.inputs !== 'object' || n.inputs === null) {
      return { err: `param '${name}' targets missing node: ${node}` }
    }
    return { inputs: n.inputs }
  }

  for (const spec of tpl.params) {
    const supplied = Object.prototype.hasOwnProperty.call(params, spec.name)

    if (spec.type === 'seed') {
      // Seeds are auto-generated, not user-supplied values: randomize declared
      // seed params on every reconstruct so each run varies.
      const value = Math.floor(rng() * 1e12)
      for (const t of spec.targets) {
        const r = inputsFor(spec.name, t.node)
        if ('err' in r) return { ok: false, reason: r.err }
        r.inputs[t.input] = value
      }
      continue
    }

    // Non-seed params: only act when the consumer supplied a value; otherwise
    // leave the template's existing input as-is.
    if (!supplied) continue

    const raw = params[spec.name]

    if (spec.type === 'text') {
      if (typeof raw !== 'string') {
        return { ok: false, reason: `param '${spec.name}' must be a string` }
      }
      const r = inputsFor(spec.name, spec.target.node)
      if ('err' in r) return { ok: false, reason: r.err }
      r.inputs[spec.target.input] = raw
      continue
    }

    if (spec.type === 'number') {
      if (typeof raw !== 'number' || Number.isNaN(raw)) {
        return { ok: false, reason: `param '${spec.name}' must be a number` }
      }
      if (spec.min !== undefined && raw < spec.min) {
        return { ok: false, reason: `param '${spec.name}' below min ${spec.min}` }
      }
      if (spec.max !== undefined && raw > spec.max) {
        return { ok: false, reason: `param '${spec.name}' above max ${spec.max}` }
      }
      const r = inputsFor(spec.name, spec.target.node)
      if ('err' in r) return { ok: false, reason: r.err }
      r.inputs[spec.target.input] = raw
      continue
    }

    // spec.type === 'image': the raw value is ignored; the trusted filename comes
    // from an upstream /upload/image, keyed by param name in opts.uploads.
    const filename = opts.uploads?.[spec.name]
    if (typeof filename !== 'string') {
      return { ok: false, reason: `param '${spec.name}' requires an uploaded image` }
    }
    const r = inputsFor(spec.name, spec.target.node)
    if ('err' in r) return { ok: false, reason: r.err }
    r.inputs[spec.target.input] = filename
  }

  return { ok: true, graph }
}
