function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Parse a drained upstream text buffer into `{ body, finalFrame }`. Handles
// NDJSON (last non-empty JSON-parseable line), SSE (`data:` prefix stripped,
// `[DONE]` skipped), and whole-body single-JSON (`body = whole ?? finalFrame`).
// This is a generic text convenience; binary breeds (e.g. ComfyUI) can ignore it.
export function extractTextFrames(buffer: string): { body: unknown; finalFrame: unknown } {
  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean)
  let finalFrame: unknown
  for (let i = lines.length - 1; i >= 0; i--) {
    // Strip an optional SSE `data:` prefix (with optional following space) so
    // /v1 Server-Sent Events frames parse; plain NDJSON lines have no prefix.
    let line = lines[i]
    if (line.startsWith('data:')) line = line.slice(5).replace(/^ /, '')
    // Skip the SSE terminal sentinel.
    if (line === '[DONE]') continue
    const parsed = tryParse(line)
    if (parsed !== undefined) {
      finalFrame = parsed
      break
    }
  }
  const whole = tryParse(buffer)
  return { body: whole ?? finalFrame, finalFrame }
}
