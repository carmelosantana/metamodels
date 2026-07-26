import type { RewrittenRequest, UpstreamResult } from '@metamodels/connectors'

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export interface ProxyResult {
  response: Response
  metering: Promise<UpstreamResult>
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((value, key) => {
    out[key] = value
  })
  return out
}

async function readOutcome(
  stream: ReadableStream<Uint8Array>,
  status: number,
  headers: Record<string, string>,
): Promise<UpstreamResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) buffer += decoder.decode(value, { stream: true })
  }
  buffer += decoder.decode()

  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean)
  let finalFrame: unknown
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParse(lines[i])
    if (parsed !== undefined) {
      finalFrame = parsed
      break
    }
  }
  const whole = tryParse(buffer)
  return { status, headers, body: whole ?? finalFrame, finalFrame }
}

export async function proxyToUpstream(
  flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust?: boolean },
  req: RewrittenRequest,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<ProxyResult> {
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = flock.baseUrl.replace(/\/$/, '') + req.path

  const headers: Record<string, string> = { ...req.headers }
  if (flock.upstreamAuth) headers['authorization'] = `Bearer ${flock.upstreamAuth}`

  const init: RequestInit = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    init.body = JSON.stringify(req.body)
    headers['content-type'] = headers['content-type'] ?? 'application/json'
  }

  const upstream = await doFetch(url, init)
  const outHeaders = headersToObject(upstream.headers)

  if (!upstream.body) {
    const text = await upstream.text()
    const whole = tryParse(text)
    return {
      response: new Response(text, { status: upstream.status, headers: outHeaders }),
      metering: Promise.resolve({ status: upstream.status, headers: outHeaders, body: whole, finalFrame: whole }),
    }
  }

  const [toClient, toMeter] = upstream.body.tee()
  return {
    response: new Response(toClient, { status: upstream.status, headers: outHeaders }),
    metering: readOutcome(toMeter, upstream.status, outHeaders),
  }
}
