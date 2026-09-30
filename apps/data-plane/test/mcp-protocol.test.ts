import { describe, expect, test } from 'vitest'
import { JSONRPC_ERRORS, parseJsonRpc, rpcError, rpcResult, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/jsonrpc.js'
import { decodeHeaderValue, eraOf, legacyNegotiatedVersion, validateLegacy, validateModern } from '../src/mcp/protocol.js'

const META = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }
const headersOf = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()]

describe('parseJsonRpc', () => {
  test('a request, with or without params', () => {
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ kind: 'request', id: 1, method: 'tools/list', params: undefined })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'x' } }))
      .toEqual({ kind: 'request', id: 'a', method: 'tools/call', params: { name: 'x' } })
  })

  test('a notification has no id', () => {
    expect(parseJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ kind: 'notification', method: 'notifications/initialized' })
  })

  test('batches, wrong versions, bad ids, bad methods and bad params are invalid', () => {
    expect(parseJsonRpc([{ jsonrpc: '2.0', id: 1, method: 'x' }])).toEqual({ kind: 'invalid', id: null, message: 'batch requests are not supported' })
    expect(parseJsonRpc({ jsonrpc: '1.0', id: 1, method: 'x' })).toEqual({ kind: 'invalid', id: 1, message: 'jsonrpc must be "2.0"' })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: null, method: 'x' })).toEqual({ kind: 'invalid', id: null, message: 'id must be a string or a number' })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 7 })).toEqual({ kind: 'invalid', id: 1, message: 'method must be a string' })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 'x', params: 'p' })).toEqual({ kind: 'invalid', id: 1, message: 'params must be an object or an array' })
    expect(parseJsonRpc('nope')).toEqual({ kind: 'invalid', id: null, message: 'expected a JSON-RPC 2.0 object' })
  })

  test('responses; an error carries data only when given', () => {
    expect(rpcResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    expect(rpcError(null, JSONRPC_ERRORS.parseError, 'parse error')).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    expect(rpcError(1, -32022, 'x', { a: 1 })).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'x', data: { a: 1 } } })
  })
})

describe('decodeHeaderValue (streamable-http §Value Encoding)', () => {
  test('plain ASCII is itself; the Base64 sentinel is decoded as UTF-8', () => {
    expect(decodeHeaderValue('get_weather')).toBe('get_weather')
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界')
    expect(decodeHeaderValue('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')).toBe('=?base64?literal?=')
  })

  test('a value with invalid characters, or a sentinel that is not Base64, is null', () => {
    expect(decodeHeaderValue('bad\nvalue')).toBeNull()
    expect(decodeHeaderValue('=?base64?not base64!?=')).toBeNull()
  })
})

describe('eraOf (versioning §Backward Compatibility)', () => {
  test('initialize is legacy; a legacy header with no _meta version is legacy; everything else is modern', () => {
    expect(eraOf('initialize', { protocolVersion: '2025-11-25' }, undefined)).toBe('legacy')
    expect(eraOf('tools/list', undefined, '2025-11-25')).toBe('legacy')
    expect(eraOf('tools/list', {}, '2025-06-18')).toBe('legacy')
    expect(eraOf('tools/list', META, '2026-07-28')).toBe('modern')
    expect(eraOf('tools/list', META, '2025-11-25')).toBe('modern')
    expect(eraOf('tools/list', undefined, undefined)).toBe('modern')
    expect(eraOf('tools/list', undefined, '2025-03-26')).toBe('modern')
  })

  test('legacy initialize echoes a supported legacy version, else answers the newest legacy one', () => {
    expect(legacyNegotiatedVersion('2025-06-18')).toBe('2025-06-18')
    expect(legacyNegotiatedVersion('2025-11-25')).toBe('2025-11-25')
    expect(legacyNegotiatedVersion('2024-11-05')).toBe('2025-11-25')
    expect(legacyNegotiatedVersion(undefined)).toBe('2025-11-25')
  })

  test('initialize takes no header, but refuses one naming a version this server does not speak', () => {
    expect(validateLegacy(1, 'initialize', headersOf({}))).toBeNull()
    expect(validateLegacy(1, 'initialize', headersOf({ 'mcp-protocol-version': '2025-11-25' }))).toBeNull()
    expect(validateLegacy(1, 'initialize', headersOf({ 'mcp-protocol-version': '1900-01-01' }))?.status).toBe(400)
    expect(validateLegacy(1, 'tools/list', headersOf({ 'mcp-protocol-version': '2025-11-25' }))).toBeNull()
  })
})

describe('validateModern (streamable-http §Server Validation)', () => {
  const ok = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'chat' }
  const params = { name: 'chat', arguments: {}, ...META }
  const code = (r: ReturnType<typeof validateModern>) => r?.body.error.code

  test('matching headers pass; the Base64 sentinel is decoded before comparing', () => {
    expect(validateModern(1, 'tools/call', params, headersOf(ok))).toBeNull()
    expect(validateModern(1, 'tools/call', params, headersOf({ ...ok, 'mcp-name': `=?base64?${Buffer.from('chat').toString('base64')}?=` }))).toBeNull()
    expect(validateModern(1, 'tools/list', META, headersOf({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }))).toBeNull()
  })

  test('a missing or mismatched header, or a header that disagrees with _meta, is 400 + -32020', () => {
    const cases: Array<Record<string, string>> = [
      { 'mcp-method': 'tools/call', 'mcp-name': 'chat' },
      { ...ok, 'mcp-protocol-version': '2026-07-29' },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-name': 'chat' },
      { ...ok, 'mcp-method': 'tools/list' },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' },
      { ...ok, 'mcp-name': 'embed' },
      { ...ok, 'mcp-name': 'ch\u0001at' },
    ]
    for (const h of cases) {
      const r = validateModern(1, 'tools/call', params, headersOf(h))
      expect(r?.status, JSON.stringify(h)).toBe(400)
      expect(code(r), JSON.stringify(h)).toBe(-32020)
    }
    expect(code(validateModern(1, 'tools/list', {}, headersOf({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' })))).toBe(-32020)
  })

  test('an unsupported version that header and _meta agree on is 400 + -32022 with supported and requested', () => {
    const r = validateModern(1, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
      headersOf({ 'mcp-protocol-version': '1900-01-01', 'mcp-method': 'tools/list' }))
    expect(r).toEqual({
      status: 400,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: '1900-01-01' } } },
    })
  })
})
