import {
  JSONRPC_ERRORS, LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS, PROTOCOL_VERSION_META, rpcError,
  SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcId,
} from './jsonrpc.js'

export type Era = 'modern' | 'legacy'

/** A header lookup by lower-case name (Hono's `c.req.header`). */
export type HeaderLookup = (name: string) => string | undefined

export interface HttpRpcError {
  status: 400
  body: ReturnType<typeof rpcError>
}

const SENTINEL_PREFIX = '=?base64?'
const SENTINEL_SUFFIX = '?='

/**
 * A header value as the body would hold it (2026-07-28 streamable-http §Value Encoding): the Base64
 * sentinel `=?base64?…?=` decoded as UTF-8, a plain value as itself. Null for a value with characters
 * RFC 9110 does not allow in a field value, or a sentinel whose payload is not Base64 — both are
 * validation failures.
 */
export function decodeHeaderValue(value: string): string | null {
  if (value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX) && value.length >= SENTINEL_PREFIX.length + SENTINEL_SUFFIX.length) {
    const payload = value.slice(SENTINEL_PREFIX.length, value.length - SENTINEL_SUFFIX.length)
    return /^[A-Za-z0-9+/]*={0,2}$/.test(payload) ? Buffer.from(payload, 'base64').toString('utf8') : null
  }
  return /^[\x20-\x7e\t]*$/.test(value) ? value : null
}

/** `params._meta["io.modelcontextprotocol/protocolVersion"]`, or undefined when there is none. */
export function metaVersion(params: unknown): unknown {
  const meta = (params as { _meta?: unknown } | null | undefined)?._meta
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)[PROTOCOL_VERSION_META] : undefined
}

/**
 * Which era a request belongs to (D9; 2026-07-28 versioning §Backward Compatibility: "A request carrying
 * modern per-request `_meta` is served statelessly according to this revision. An `initialize` request
 * selects legacy semantics"). A request with no `_meta` version is legacy only when its
 * `MCP-Protocol-Version` header names a legacy version this server serves; anything else is held to
 * the modern rules, so a request with neither is refused for the missing header rather than guessed at.
 */
export function eraOf(method: string, params: unknown, headerVersion: string | undefined): Era {
  if (method === 'initialize') return 'legacy'
  if (metaVersion(params) === undefined && headerVersion !== undefined && LEGACY_PROTOCOL_VERSIONS.includes(headerVersion)) return 'legacy'
  return 'modern'
}

/** 2025-11-25 lifecycle §Version Negotiation: the requested version if supported, else the latest this server supports. */
export function legacyNegotiatedVersion(requested: unknown): string {
  return typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0]!
}

/**
 * 2026-07-28 streamable-http §Server Validation, for a modern request: the three standard headers must
 * be present and match the body (`Mcp-Name` only for `tools/call`, the one such method served here),
 * and the version they agree on must be one this server implements. Returns the 400 to send, or null.
 */
export function validateModern(id: JsonRpcId, method: string, params: unknown, header: HeaderLookup): HttpRpcError | null {
  const mismatch = (message: string): HttpRpcError => ({ status: 400, body: rpcError(id, JSONRPC_ERRORS.headerMismatch, `Header mismatch: ${message}`) })

  const version = header('mcp-protocol-version')
  if (version === undefined) return mismatch('the MCP-Protocol-Version header is required')
  const bodyVersion = metaVersion(params)
  if (typeof bodyVersion !== 'string' || bodyVersion !== version) {
    return mismatch(`MCP-Protocol-Version does not match params._meta["${PROTOCOL_VERSION_META}"]`)
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return {
      status: 400,
      body: rpcError(id, JSONRPC_ERRORS.unsupportedProtocolVersion, 'Unsupported protocol version', {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: version,
      }),
    }
  }

  const mcpMethod = header('mcp-method')
  if (mcpMethod === undefined) return mismatch('the Mcp-Method header is required')
  if (mcpMethod !== method) return mismatch('Mcp-Method does not match the body method')

  if (method === 'tools/call') {
    const raw = header('mcp-name')
    if (raw === undefined) return mismatch('the Mcp-Name header is required for tools/call')
    const name = decodeHeaderValue(raw)
    if (name === null || name !== (params as { name?: unknown } | null | undefined)?.name) {
      return mismatch('Mcp-Name does not match params.name')
    }
  }
  return null
}

/**
 * A legacy request. `initialize` carries no header (2025-11-25 transports: the header is sent "on all
 * subsequent requests"), but one it does carry must name a version this server serves (2025-11-25:
 * an unsupported `MCP-Protocol-Version` MUST get 400). Any other legacy request reached here through
 * `eraOf`, so its header already names a supported legacy version.
 */
export function validateLegacy(id: JsonRpcId, method: string, header: HeaderLookup): HttpRpcError | null {
  const version = header('mcp-protocol-version')
  if (method === 'initialize' && version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return { status: 400, body: rpcError(id, JSONRPC_ERRORS.invalidRequest, `unsupported MCP-Protocol-Version; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`) }
  }
  return null
}
