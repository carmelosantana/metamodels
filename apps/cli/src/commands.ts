import { readFileSync } from 'node:fs'
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { adminApiResource, CAPABILITIES, type Capability } from '@metamodels/schema'
import { callApi, type ApiSession } from './client.js'
import { resolveConsoleUrl, resolveIssuer, CONSOLE_ENV, ISSUER_ENV } from './config.js'
import {
  credentialsPath, deleteCredentials, readCredentials, withCredentialsLock, writeCredentials, type LockOptions,
} from './credentials.js'
import { deviceLogin, revokeRefreshToken, type OpDeps } from './device.js'
import { loadCredential, refreshStored, type SessionContext } from './session.js'

/**
 * One admin-API command: the operation it calls (method and OpenAPI path template, relative to
 * `/api/admin/v1`), the query parameters it may send, and its body. Path parameters are filled from
 * positionals in template order. `test/openapi-parity.test.ts` checks every entry against
 * `docs/api/openapi.json`.
 */
export interface CommandSpec {
  group: string
  action: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  /** The OpenAPI query parameters it may send; each `name` is the flag `--kebab-case-name`. */
  query: readonly QueryParam[]
  /** `json`: from --data or --file. `{field}`: one more positional, sent as `{[field]: value}`. */
  body: 'none' | 'json' | { field: string; values: string }
}

/**
 * A query parameter. `required` mirrors the operation's `required` (the parity test holds them
 * equal) and only shapes `--help`: a missing one is left for the API's 422 to name.
 */
export interface QueryParam {
  name: string
  required: boolean
}

const opt = (...names: string[]): QueryParam[] => names.map((name) => ({ name, required: false }))
const req = (...names: string[]): QueryParam[] => names.map((name) => ({ name, required: true }))

const PAGE = opt('limit', 'cursor')

/**
 * Exactly the routes that exist (spec §3). There is deliberately no `keys delete`: `DELETE /keys/{id}`
 * answers 405, because deleting a key would cascade away its usage history — a key is revoked.
 */
export const COMMANDS: readonly CommandSpec[] = [
  { group: 'flocks', action: 'list', method: 'GET', path: '/flocks', query: PAGE, body: 'none' },
  { group: 'flocks', action: 'get', method: 'GET', path: '/flocks/{id}', query: [], body: 'none' },
  { group: 'flocks', action: 'create', method: 'POST', path: '/flocks', query: [], body: 'json' },
  { group: 'flocks', action: 'replace', method: 'PUT', path: '/flocks/{id}', query: [], body: 'json' },
  { group: 'flocks', action: 'delete', method: 'DELETE', path: '/flocks/{id}', query: [], body: 'none' },
  { group: 'paddocks', action: 'list', method: 'GET', path: '/paddocks', query: PAGE, body: 'none' },
  { group: 'paddocks', action: 'get', method: 'GET', path: '/paddocks/{id}', query: [], body: 'none' },
  { group: 'paddocks', action: 'create', method: 'POST', path: '/paddocks', query: [], body: 'json' },
  { group: 'paddocks', action: 'replace', method: 'PUT', path: '/paddocks/{id}', query: [], body: 'json' },
  { group: 'paddocks', action: 'delete', method: 'DELETE', path: '/paddocks/{id}', query: [], body: 'none' },
  {
    group: 'paddocks', action: 'status', method: 'PUT', path: '/paddocks/{id}/status', query: [],
    body: { field: 'status', values: 'active|disabled' },
  },
  { group: 'fence', action: 'get', method: 'GET', path: '/paddocks/{id}/fence', query: [], body: 'none' },
  { group: 'fence', action: 'set', method: 'PUT', path: '/paddocks/{id}/fence', query: [], body: 'json' },
  { group: 'templates', action: 'list', method: 'GET', path: '/paddocks/{id}/templates', query: [], body: 'none' },
  { group: 'templates', action: 'add', method: 'POST', path: '/paddocks/{id}/templates', query: [], body: 'json' },
  { group: 'templates', action: 'replace', method: 'PUT', path: '/paddocks/{id}/templates/{tid}', query: [], body: 'json' },
  { group: 'templates', action: 'remove', method: 'DELETE', path: '/paddocks/{id}/templates/{tid}', query: [], body: 'none' },
  { group: 'keys', action: 'list', method: 'GET', path: '/keys', query: PAGE, body: 'none' },
  { group: 'keys', action: 'create', method: 'POST', path: '/keys', query: [], body: 'json' },
  { group: 'keys', action: 'revoke', method: 'POST', path: '/keys/{id}/revoke', query: [], body: 'none' },
  {
    group: 'usage', action: 'matrix', method: 'GET', path: '/usage/matrix',
    query: [...req('startBucket', 'endBucket'), ...opt('keyId', 'paddockId')], body: 'none',
  },
  {
    group: 'usage', action: 'daily', method: 'GET', path: '/usage/daily',
    query: [...req('dim', 'startBucket', 'endBucket'), ...opt('keyId', 'paddockId')], body: 'none',
  },
  {
    group: 'usage', action: 'top-keys', method: 'GET', path: '/usage/top-keys',
    query: [...req('dim', 'startBucket', 'endBucket'), ...opt('limit')], body: 'none',
  },
]

const kebab = (name: string) => name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

const QUERY_FLAGS = [...new Set(COMMANDS.flatMap((c) => c.query.map((q) => q.name)))].map(kebab)

const OPTIONS: ParseArgsOptionsConfig = {
  issuer: { type: 'string' },
  console: { type: 'string' },
  scope: { type: 'string' },
  data: { type: 'string' },
  file: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  ...Object.fromEntries(QUERY_FLAGS.map((flag) => [flag, { type: 'string' }])),
}

type Values = Record<string, string | boolean | undefined>

export interface MainIo {
  env: NodeJS.ProcessEnv
  stdout: (s: string) => void
  stderr: (s: string) => void
  /** Reads a `--file -` body. */
  readStdin?: () => Promise<string>
  /** OP-call overrides (tests). */
  op?: OpDeps
  /** Admin-API fetch override (tests). */
  fetch?: typeof fetch
}

/** The credentials lock says it is waiting on this run's stderr. */
function lockOptions(io: MainIo): LockOptions {
  return { notify: (line) => io.stderr(`mm: ${line}\n`) }
}

/** Exit 2: the command line is wrong, and nothing was sent. */
class UsageError extends Error {}

function argLabel(spec: CommandSpec, param: string): string {
  if (param === 'tid') return '<template-id>'
  return spec.group === 'fence' || spec.group === 'templates' ? '<paddock-id>' : `<${param}>`
}

function pathParams(spec: CommandSpec): string[] {
  return [...spec.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
}

function usageLine(spec: CommandSpec): string {
  const parts = [`mm ${spec.group} ${spec.action}`, ...pathParams(spec).map((p) => argLabel(spec, p))]
  if (spec.body === 'json') parts.push('(--data JSON | --file PATH)')
  else if (typeof spec.body === 'object') parts.push(`<${spec.body.values}>`)
  for (const q of spec.query) parts.push(q.required ? `--${kebab(q.name)} VALUE` : `[--${kebab(q.name)} VALUE]`)
  return parts.join(' ')
}

export function helpText(): string {
  return [
    'mm — the MetaModels admin CLI',
    '',
    'Usage:',
    '  mm login [--scope read,resource.write]   sign in through the browser (default scope: read)',
    '  mm logout                                revoke this machine\'s sign-in and forget it',
    ...COMMANDS.map((c) => `  ${usageLine(c)}`),
    '',
    `Every command takes --issuer URL (or ${ISSUER_ENV}), the sign-in service, and all but`,
    `logout take --console URL (or ${CONSOLE_ENV}), the console the admin API lives on.`,
    'Output is JSON on stdout; errors go to stderr with a non-zero exit code (2 for usage errors).',
    '--file - reads a JSON body from stdin.',
    '',
  ].join('\n')
}

function unknownCommand(group: string | undefined, action: string | undefined): UsageError {
  if (group === 'keys' && action === 'delete') {
    return new UsageError(
      '`mm keys delete` does not exist: a key is revoked, never deleted (deleting it would erase its ' +
      'usage history). Use `mm keys revoke <id>`.',
    )
  }
  return new UsageError(`unknown command \`mm ${[group, action].filter(Boolean).join(' ')}\`; see \`mm --help\``)
}

function allowOnly(values: Values, allowed: readonly string[], command: string): void {
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && k !== 'help' && !allowed.includes(k)) throw new UsageError(`--${k} does not apply to \`${command}\``)
  }
}

/** Config errors are usage errors: nothing was sent, and the fix is on the command line. */
function config<T>(f: () => T): T {
  try {
    return f()
  } catch (e) {
    throw new UsageError((e as Error).message)
  }
}

async function readJsonBody(values: Values, io: MainIo, command: string): Promise<unknown> {
  const data = values.data as string | undefined
  const file = values.file as string | undefined
  if ((data === undefined) === (file === undefined)) throw new UsageError(`\`${command}\` needs exactly one of --data JSON or --file PATH`)
  const [text, source] = data !== undefined
    ? [data, '--data']
    : file === '-'
      ? [await (io.readStdin ?? (async () => ''))(), 'stdin']
      : [readFileSync(file!, 'utf8'), file!]
  try {
    return JSON.parse(text)
  } catch {
    throw new UsageError(`${source} is not valid JSON`)
  }
}

async function runApi(spec: CommandSpec, rest: string[], values: Values, io: MainIo): Promise<number> {
  const command = `mm ${spec.group} ${spec.action}`
  const params = pathParams(spec)
  const expected = params.length + (typeof spec.body === 'object' ? 1 : 0)
  if (rest.length !== expected) throw new UsageError(`usage: ${usageLine(spec)}`)
  allowOnly(values, [
    'issuer', 'console', ...(spec.body === 'json' ? ['data', 'file'] : []), ...spec.query.map((q) => kebab(q.name)),
  ], command)

  let path = spec.path
  params.forEach((p, i) => { path = path.replace(`{${p}}`, encodeURIComponent(rest[i])) })
  const query: Record<string, string> = {}
  for (const { name } of spec.query) {
    const v = values[kebab(name)]
    if (typeof v === 'string') query[name] = v
  }
  let body: unknown
  if (spec.body === 'json') body = await readJsonBody(values, io, command)
  else if (typeof spec.body === 'object') body = { [spec.body.field]: rest[params.length] }

  const issuer = config(() => resolveIssuer(values.issuer as string | undefined, io.env))
  const consoleUrl = config(() => resolveConsoleUrl(values.console as string | undefined, io.env))
  const ctx: SessionContext = {
    path: credentialsPath(io.env), issuer, resource: adminApiResource(consoleUrl), lock: lockOptions(io),
    ...(io.op ? { deps: io.op } : {}),
  }
  const session: ApiSession = { current: () => loadCredential(ctx), refresh: (stale) => refreshStored(ctx, stale) }
  const res = await callApi(consoleUrl, session, { method: spec.method, path, query, body }, io.fetch)
  if (res.body !== null) io.stdout(`${JSON.stringify(res.body, null, 2)}\n`)
  if (res.next !== undefined) io.stderr(`More results: repeat with --cursor ${res.next}\n`)
  return 0
}

function parseScopes(raw: string): Capability[] {
  const scopes = [...new Set(raw.split(/[\s,]+/).filter(Boolean))]
  if (scopes.length === 0) throw new UsageError('--scope names no capability')
  for (const s of scopes) {
    if (!(CAPABILITIES as readonly string[]).includes(s)) {
      throw new UsageError(`unknown scope "${s}"; choose from ${CAPABILITIES.join(', ')}`)
    }
  }
  return scopes as Capability[]
}

async function login(rest: string[], values: Values, io: MainIo): Promise<number> {
  if (rest.length) throw new UsageError('usage: mm login [--scope read,resource.write]')
  allowOnly(values, ['issuer', 'console', 'scope'], 'mm login')
  const scopes = parseScopes((values.scope as string | undefined) ?? 'read')
  const issuer = config(() => resolveIssuer(values.issuer as string | undefined, io.env))
  const consoleUrl = config(() => resolveConsoleUrl(values.console as string | undefined, io.env))
  const cred = await deviceLogin(
    { issuer, resource: adminApiResource(consoleUrl), scopes },
    { ...io.op, print: (line) => io.stderr(`${line}\n`) },
  )
  const path = credentialsPath(io.env)
  // Under the lock, so a refresh running in another process cannot interleave with this write.
  await withCredentialsLock(path, async () => writeCredentials(path, cred), lockOptions(io))
  io.stderr(`Signed in to ${issuer}.\n`)
  io.stdout(`${JSON.stringify({ issuer, console: consoleUrl, scope: cred.scope }, null, 2)}\n`)
  return 0
}

async function logout(rest: string[], values: Values, io: MainIo): Promise<number> {
  if (rest.length) throw new UsageError('usage: mm logout')
  allowOnly(values, ['issuer'], 'mm logout')
  const issuer = config(() => resolveIssuer(values.issuer as string | undefined, io.env))
  const path = credentialsPath(io.env)
  return withCredentialsLock(path, async () => {
    const cred = readCredentials(path, issuer)
    if (cred === null) {
      io.stderr(`Not signed in to ${issuer}; nothing to do.\n`)
      return 0
    }
    const revoked = cred.refreshToken === undefined
      ? null
      : await revokeRefreshToken({ issuer, refreshToken: cred.refreshToken }, io.op)
    // Forget it whatever the OP said: the operator asked for this machine to stop holding it.
    deleteCredentials(path, issuer)
    io.stdout(`${JSON.stringify({ issuer, revoked: revoked === true }, null, 2)}\n`)
    const accessNote = cred.accessExpiresAt > Date.now()
      ? ` The last access token stays valid until ${new Date(cred.accessExpiresAt).toISOString()}; access tokens cannot be revoked.`
      : ''
    if (revoked === false) {
      io.stderr(
        `Removed the sign-in for ${issuer} from this machine, but could not revoke it at the sign-in service: ` +
        `its refresh token stays valid there until it expires.${accessNote}\n`,
      )
      return 1
    }
    io.stderr(`Signed out of ${issuer}.${accessNote}\n`)
    return 0
  }, lockOptions(io))
}

/** The CLI. Returns the exit code: 0 success, 1 failure, 2 usage error (nothing sent). */
export async function main(argv: string[], io: MainIo): Promise<number> {
  // `pnpm start -- <args>` can pass the separator through.
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let values: Values
  let positionals: string[]
  try {
    const parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true })
    values = parsed.values as Values
    positionals = parsed.positionals
  } catch (e) {
    io.stderr(`mm: ${(e as Error).message}\nSee \`mm --help\`.\n`)
    return 2
  }
  if (values.help) {
    io.stdout(helpText())
    return 0
  }
  if (positionals.length === 0) {
    io.stderr(helpText())
    return 2
  }
  try {
    const [group, action, ...rest] = positionals
    if (group === 'login') return await login(positionals.slice(1), values, io)
    if (group === 'logout') return await logout(positionals.slice(1), values, io)
    const spec = COMMANDS.find((c) => c.group === group && c.action === action)
    if (spec === undefined) throw unknownCommand(group, action)
    return await runApi(spec, rest, values, io)
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`mm: ${e.message}\n`)
      return 2
    }
    io.stderr(`mm: ${oneLine(e)}\n`)
    return 1
  }
}

/** An error as one line, with a network failure's cause (`fetch failed` alone says nothing). */
function oneLine(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause instanceof Error ? `: ${e.cause.message}` : ''
  return `${e.message}${cause}`
}
