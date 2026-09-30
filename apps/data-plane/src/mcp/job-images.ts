import type { JobResultImage } from '@metamodels/connectors'

/**
 * The most image bytes one `get_job_result` returns inline (spec M4 §3.8: there was no cap to reuse).
 * Base64 grows it by a third, so one JSON-RPC response stays under ~11 MB.
 */
export const MCP_MAX_IMAGE_BYTES = 8 * 1024 * 1024

type Attached = { ok: true; body: { done: boolean; images: JobResultImage[] } } | { ok: false; error: string }

const tooBig = (cap: number): Attached => ({ ok: false, error: `the job's images exceed the ${cap}-byte limit for one MCP result` })
const unfetchable: Attached = { ok: false, error: 'an output image could not be fetched' }

/** Read a body, giving up (and cancelling) as soon as it passes `remaining` bytes. */
async function readCapped(res: Response, remaining: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > remaining) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Turn the scoped result view's image references into bytes, fetched from the flock's `/view` with
 * its credential. Only for a finished job; all-or-nothing, so a result never silently drops an image.
 */
export async function attachImageBytes(body: unknown, view: (path: string) => Promise<Response>, cap: number): Promise<Attached> {
  const b = body as { done?: unknown; images?: unknown } | null
  const images = (Array.isArray(b?.images) ? b.images : []) as JobResultImage[]
  if (b?.done !== true) return { ok: true, body: { done: false, images } }

  let total = 0
  const out: JobResultImage[] = []
  for (const img of images) {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type })
    let res: Response
    try {
      res = await view(`/view?${q}`)
    } catch {
      return unfetchable
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return unfetchable
    }
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > cap - total) {
      await res.body?.cancel().catch(() => undefined)
      return tooBig(cap)
    }
    const bytes = await readCapped(res, cap - total)
    if (bytes === null) return tooBig(cap)
    total += bytes.length
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
    out.push({ ...img, data: Buffer.from(bytes).toString('base64'), mimeType })
  }
  return { ok: true, body: { done: true, images: out } }
}
