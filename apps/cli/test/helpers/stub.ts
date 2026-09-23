import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  path: string
  headers: IncomingHttpHeaders
  /** The raw request body. */
  body: string
  /** The body parsed as a form, when it is one. */
  form: Record<string, string>
}

export type Reply = { status: number; json?: unknown; headers?: Record<string, string>; text?: string }
export type Handler = (req: Recorded) => Reply | Promise<Reply>

export interface Stub {
  url: string
  requests: Recorded[]
  /** Replace the handler for one exact `METHOD /path` (path without the query string). */
  on(route: string, handler: Handler): void
  close(): Promise<void>
}

/** A scripted HTTP server on 127.0.0.1:0 that records every request it receives. */
export async function startStub(): Promise<Stub> {
  const routes = new Map<string, Handler>()
  const requests: Recorded[] = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const path = (req.url ?? '/').split('?')[0]
    const rec: Recorded = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: req.headers,
      body,
      form: req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')
        ? Object.fromEntries(new URLSearchParams(body))
        : {},
    }
    requests.push(rec)
    const handler = routes.get(`${rec.method} ${path}`)
    const reply: Reply = handler ? await handler(rec) : { status: 404, json: { error: 'no route' } }
    res.statusCode = reply.status
    for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v)
    if (reply.json !== undefined) {
      if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(reply.json))
    } else {
      res.end(reply.text ?? '')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    on: (route, handler) => { routes.set(route, handler) },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** Serve OIDC discovery for `stub` as its own issuer. */
export function serveDiscovery(stub: Stub, extra: Record<string, unknown> = {}): void {
  stub.on('GET /.well-known/openid-configuration', () => ({
    status: 200,
    json: {
      issuer: stub.url,
      token_endpoint: `${stub.url}/token`,
      device_authorization_endpoint: `${stub.url}/device/auth`,
      revocation_endpoint: `${stub.url}/token/revocation`,
      ...extra,
    },
  }))
}
