/** Modern revisions: version, identity and capabilities per request in `_meta` (2026-07-28 versioning §Terminology). */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28']
/** Legacy revisions served statelessly (D9), newest first: `initialize` answers the first when it cannot echo. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18']
/** What `server/discover` and `-32022` advertise: every version this dual-era endpoint serves. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS]

export const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion'
export const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'
export const MCP_SERVER_NAME = 'metamodels'
/**
 * `serverInfo.version`. The stack exposes no version of its own (every package.json says 0.0.0 and
 * nothing reads one), so this is that literal rather than new build plumbing.
 */
export const MCP_SERVER_VERSION = '0.0.0'
/**
 * `ttlMs` on the cacheable modern results (`CacheableResult.ttlMs` is required by the 2026-07-28 schema).
 * 0 = immediately stale: tools are derived from the fence, and a fence edit must show on the next list.
 */
export const MCP_CACHE_TTL_MS = 0

export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** 2026-07-28 `HEADER_MISMATCH`. */
  headerMismatch: -32020,
  /** 2026-07-28 `UNSUPPORTED_PROTOCOL_VERSION`. */
  unsupportedProtocolVersion: -32022,
} as const

export type JsonRpcId = string | number

export type JsonRpcMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string }
  | { kind: 'invalid'; id: JsonRpcId | null; message: string }

const invalid = (id: JsonRpcId | null, message: string): JsonRpcMessage => ({ kind: 'invalid', id, message })

/** One JSON-RPC 2.0 message, already `JSON.parse`d. Arrays (batches) are refused. */
export function parseJsonRpc(raw: unknown): JsonRpcMessage {
  if (Array.isArray(raw)) return invalid(null, 'batch requests are not supported')
  if (typeof raw !== 'object' || raw === null) return invalid(null, 'expected a JSON-RPC 2.0 object')
  const m = raw as Record<string, unknown>
  const id = typeof m.id === 'string' || (typeof m.id === 'number' && Number.isFinite(m.id)) ? m.id : null
  if (m.jsonrpc !== '2.0') return invalid(id, 'jsonrpc must be "2.0"')
  if (typeof m.method !== 'string') return invalid(id, 'method must be a string')
  if (!('id' in m)) return { kind: 'notification', method: m.method }
  if (id === null) return invalid(null, 'id must be a string or a number')
  if (m.params !== undefined && (typeof m.params !== 'object' || m.params === null)) {
    return invalid(id, 'params must be an object or an array')
  }
  return { kind: 'request', id, method: m.method, params: m.params }
}

export function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result }
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}
