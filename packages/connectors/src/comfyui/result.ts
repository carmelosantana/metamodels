export interface JobOutcome {
  done: boolean
  images: { filename: string; subfolder: string; type: string }[]
  gpuMs: number
}

/** True for a non-null, non-array plain object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse a ComfyUI `GET /history/{prompt_id}` response into a job outcome.
 *
 * The response is keyed by prompt id:
 *   { [promptId]: { status: {...}, outputs: {...} } }
 *
 * `status` shape:
 *   { status_str, completed: boolean,
 *     messages: [ ["execution_start",   { prompt_id, timestamp }],
 *                 ["execution_success", { prompt_id, timestamp }], ... ] }
 *   (timestamps are epoch milliseconds).
 *
 * `outputs` maps a node id to its produced values, including
 *   outputs[nodeId].images = [{ filename, subfolder, type }, ...].
 *
 * `history` is `unknown`: every access is guarded so a malformed or partial
 * payload yields a safe `JobOutcome` and never throws. Pure function, no I/O.
 */
export function parseHistory(history: unknown, promptId: string): JobOutcome {
  const empty: JobOutcome = { done: false, images: [], gpuMs: 0 }

  if (!isRecord(history)) return empty
  const entry = history[promptId]
  if (!isRecord(entry)) return empty

  const status = isRecord(entry.status) ? entry.status : undefined
  const done = status?.completed === true

  // Collect images from every output node.
  const images: JobOutcome['images'] = []
  const outputs = isRecord(entry.outputs) ? entry.outputs : undefined
  if (outputs) {
    for (const node of Object.values(outputs)) {
      if (!isRecord(node)) continue
      const nodeImages = node.images
      if (!Array.isArray(nodeImages)) continue
      for (const img of nodeImages) {
        if (!isRecord(img)) continue
        if (typeof img.filename !== 'string') continue
        images.push({
          filename: img.filename,
          subfolder: typeof img.subfolder === 'string' ? img.subfolder : '',
          type: typeof img.type === 'string' ? img.type : '',
        })
      }
    }
  }

  // Derive gpuMs from execution_start → execution_success timestamps.
  const gpuMs = deriveGpuMs(status?.messages)

  return { done, images, gpuMs }
}

/** Extract elapsed ms between execution_start and execution_success messages. */
function deriveGpuMs(messages: unknown): number {
  if (!Array.isArray(messages)) return 0

  let start: number | undefined
  let success: number | undefined

  for (const msg of messages) {
    if (!Array.isArray(msg)) continue
    const [kind, payload] = msg
    if (typeof kind !== 'string' || !isRecord(payload)) continue
    const ts = payload.timestamp
    if (typeof ts !== 'number' || Number.isNaN(ts)) continue
    if (kind === 'execution_start') start = ts
    else if (kind === 'execution_success') success = ts
  }

  if (start === undefined || success === undefined) return 0
  return Math.max(0, success - start)
}
