/**
 * Provision and verify a governed Ollama paddock (default: timeinvoice) through the admin API, with
 * the `mm` CLI as the only way in: flock → paddock → fence → key, then a real request matrix through
 * the data plane. Idempotent; every write goes through the API, so each keeps its audit entry.
 *
 * Zero dependencies, Node's own TypeScript support. Sign in first (`mm login --scope read,resource.write`),
 * then from the repo root:
 *
 *   node .claude/skills/metamodels-provisioning/scripts/provision.ts \
 *     --ollama-url http://<ollama-host>:11434 --proxy-url http://<data-plane-host>:8787 --models qwen3:8b
 *
 * No host is ever assumed. Every option, with its environment fallback, is in `parseOptions` and
 * `--help`. `mm` itself reads METAMODELS_ISSUER and METAMODELS_CONSOLE_URL (or pass --issuer, --console).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export interface Options {
  ollamaUrl: string
  proxyUrl: string
  models: string[]
  routes: string[]
  rateLimit: { max: number; windowSec: number }
  slug: string
  paddockName: string
  flockName: string
  keyName: string
  rotateKey: boolean
  /** A key minted earlier, to verify with when this run mints none (MM_PROXY_KEY). */
  proxyKey: string | null
  /** Passed through to every `mm` call. */
  mmArgs: string[]
}

/** One `mm` invocation: its argv, after `mm`. */
export type Mm = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>

export const HELP = `Usage: provision.ts [options]

Required (flag or environment):
  --ollama-url URL    MM_OLLAMA_URL   the Ollama server, as the DATA PLANE reaches it (never localhost
                                      unless the data plane runs on the host network)
  --proxy-url URL     MM_PROXY_URL    the data plane, as this machine reaches it (for the verify step)
  --models a,b        MM_MODELS       the models the fence allows; the first is used to verify

Optional:
  --routes a,b        MM_ROUTES       Ollama route classes: chat, generate, embed, read   [chat,read]
  --rate MAX/SEC      MM_RATE         the fence's rate limit                              [60/60]
  --slug S            MM_SLUG         the paddock's /p/<slug>                             [timeinvoice]
  --paddock-name N    MM_PADDOCK_NAME                                                     [TimeInvoice]
  --flock-name N      MM_FLOCK_NAME                                                       [timeinvoice-ollama]
  --key-name N        MM_KEY_NAME                                                         [timeinvoice]
  --rotate-key                        revoke the active key of that name and mint a new one
  --issuer URL, --console URL, --allow-insecure-http   passed to mm unchanged
  MM_PROXY_KEY                        an existing key's secret, to verify when none is minted
  MM_CLI                              the mm command to run, e.g. "mm" (default: this repo's apps/cli)
`

const ROUTES = ['chat', 'generate', 'embed', 'read']

function httpUrl(raw: string | undefined, flag: string): string {
  if (!raw) throw new Error(`${flag} is required (see --help)`)
  let u: URL
  try { u = new URL(raw) } catch { throw new Error(`${flag} is not a URL: ${raw}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${flag} must be http or https: ${raw}`)
  return raw.replace(/\/+$/, '')
}

const list = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)

export function parseOptions(argv: string[], env: Record<string, string | undefined>): Options {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      'ollama-url': { type: 'string' }, 'proxy-url': { type: 'string' }, models: { type: 'string' },
      routes: { type: 'string' }, rate: { type: 'string' }, slug: { type: 'string' },
      'paddock-name': { type: 'string' }, 'flock-name': { type: 'string' }, 'key-name': { type: 'string' },
      'rotate-key': { type: 'boolean' }, issuer: { type: 'string' }, console: { type: 'string' },
      'allow-insecure-http': { type: 'boolean' },
    },
  })
  const models = list(v.models ?? env.MM_MODELS)
  if (models.length === 0) throw new Error('--models is required: the fence allows no model by default (see --help)')
  const routes = list(v.routes ?? env.MM_ROUTES)
  for (const r of routes) if (!ROUTES.includes(r)) throw new Error(`--routes: ${r} is not one of ${ROUTES.join(', ')}`)
  const rate = v.rate ?? env.MM_RATE ?? '60/60'
  const m = /^(\d+)\/(\d+)$/.exec(rate)
  if (!m || Number(m[2]) < 1) throw new Error(`--rate must be MAX/SECONDS, e.g. 60/60: ${rate}`)
  const mmArgs = [
    ...(v.issuer ? ['--issuer', v.issuer] : []), ...(v.console ? ['--console', v.console] : []),
    ...(v['allow-insecure-http'] ? ['--allow-insecure-http'] : []),
  ]
  return {
    ollamaUrl: httpUrl(v['ollama-url'] ?? env.MM_OLLAMA_URL, '--ollama-url'),
    proxyUrl: httpUrl(v['proxy-url'] ?? env.MM_PROXY_URL, '--proxy-url'),
    models,
    routes: routes.length ? routes : ['chat', 'read'],
    rateLimit: { max: Number(m[1]), windowSec: Number(m[2]) },
    slug: v.slug ?? env.MM_SLUG ?? 'timeinvoice',
    paddockName: v['paddock-name'] ?? env.MM_PADDOCK_NAME ?? 'TimeInvoice',
    flockName: v['flock-name'] ?? env.MM_FLOCK_NAME ?? 'timeinvoice-ollama',
    keyName: v['key-name'] ?? env.MM_KEY_NAME ?? 'timeinvoice',
    rotateKey: v['rotate-key'] ?? false,
    proxyKey: env.MM_PROXY_KEY || null,
    mmArgs,
  }
}

type Row = Record<string, unknown> & { id: string }

/** Runs `mm`; a non-zero exit stops the run with mm's own error line. */
async function call(mm: Mm, args: string[]): Promise<{ body: unknown; stderr: string }> {
  const r = await mm(args)
  if (r.code !== 0) throw new Error(`mm ${args.slice(0, 2).join(' ')} failed: ${r.stderr.trim()}`)
  return { body: r.stdout.trim() === '' ? null : JSON.parse(r.stdout), stderr: r.stderr }
}

/** Every row of a paginated listing, following mm's `--cursor` hint. */
async function listAll(mm: Mm, group: string, extra: string[]): Promise<Row[]> {
  const rows: Row[] = []
  let cursor: string | undefined
  do {
    const { body, stderr } = await call(mm, [group, 'list', '--limit', '200', ...(cursor ? ['--cursor', cursor] : []), ...extra])
    rows.push(...(body as Row[]))
    cursor = /repeat with --cursor (\S+)/.exec(stderr)?.[1]
  } while (cursor)
  return rows
}

const json = (body: unknown) => ['--data', JSON.stringify(body)]

/** Whether `row` already holds every field of `body`: then a replace would only add an audit entry. */
const holds = (row: Row, body: Record<string, unknown>) => Object.entries(body).every(([k, v]) => row[k] === v)

export interface Provisioned {
  flock: Row
  paddock: Row
  /** `plaintext` only when this run minted the key: it exists nowhere else, ever. */
  key: { id: string; name: string; plaintext: string | null }
}

export async function provision(o: Options, mm: Mm): Promise<Provisioned> {
  const x = o.mmArgs

  // The flock, by name. Replacing it leaves any stored upstream credential alone only while the base
  // URL stays put; the API answers 409 otherwise, and that error is shown as is.
  const flockBody = { breed: 'ollama', name: o.flockName, baseUrl: o.ollamaUrl, tlsTrust: false }
  const existingFlock = (await listAll(mm, 'flocks', x)).find((f) => f.name === o.flockName)
  const flock = existingFlock && holds(existingFlock, flockBody) ? existingFlock : (existingFlock
    ? await call(mm, ['flocks', 'replace', existingFlock.id, ...json(flockBody), ...x])
    : await call(mm, ['flocks', 'create', ...json(flockBody), ...x])).body as Row

  // The paddock, by slug. Slugs are global; one already publishing another flock is not ours to move.
  const paddockBody = { flockId: flock.id, name: o.paddockName, slug: o.slug }
  const existingPaddock = (await listAll(mm, 'paddocks', x)).find((p) => p.slug === o.slug)
  if (existingPaddock && existingPaddock.flockId !== flock.id) {
    throw new Error(`the slug ${o.slug} already publishes another flock (${String(existingPaddock.flockId)}); pick another --slug`)
  }
  const paddock = existingPaddock && holds(existingPaddock, paddockBody) ? existingPaddock : (existingPaddock
    ? await call(mm, ['paddocks', 'replace', existingPaddock.id, ...json(paddockBody), ...x])
    : await call(mm, ['paddocks', 'create', ...json({ ...paddockBody, status: 'active' }), ...x])).body as Row

  // The fence, whole: an omitted rateLimit or quota would be cleared, so both are always sent.
  await call(mm, ['fence', 'set', paddock.id, ...json({
    constraintJson: { allowedRoutes: o.routes, allowedModels: o.models }, rateLimit: o.rateLimit,
  }), ...x])

  // The key, by name: minted once. A key cannot be read back, so an existing one is kept unless rotated.
  const active = (await listAll(mm, 'keys', x)).filter((k) => k.name === o.keyName && k.status === 'active' && k.kind !== 'oauth')
  if (active.length > 0 && !o.rotateKey) return { flock, paddock, key: { id: active[0]!.id, name: o.keyName, plaintext: null } }
  for (const k of active) await call(mm, ['keys', 'revoke', k.id, ...x])
  const created = (await call(mm, ['keys', 'create', ...json({ name: o.keyName, paddockIds: [paddock.id] }), ...x])).body as Row
  return { flock, paddock, key: { id: created.id, name: o.keyName, plaintext: String(created.plaintext) } }
}

export interface VerifyRow { check: string; want: number; got: number }

/**
 * Real governed requests through the data plane, on the OpenAI-compatible path a consumer uses.
 * The first call may cold-load the model, so there is no short timeout here.
 */
export async function verify(o: Options, key: string, fetchImpl: typeof fetch = fetch): Promise<VerifyRow[]> {
  const base = `${o.proxyUrl}/p/${o.slug}`
  const chat = (model: string, auth: boolean) => fetchImpl(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], stream: false }),
  })
  const status = async (res: Promise<Response>) => { const r = await res; await r.body?.cancel(); return r.status }
  const rows: VerifyRow[] = [
    { check: 'allowed model', want: 200, got: await status(chat(o.models[0]!, true)) },
    { check: 'model outside the allowlist', want: 403, got: await status(chat('metamodels-verify-not-allowed', true)) },
    {
      check: 'model management (/api/pull)', want: 403, got: await status(fetchImpl(`${base}/api/pull`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model: o.models[0] }),
      })),
    },
    { check: 'no key', want: 401, got: await status(chat(o.models[0]!, false)) },
  ]
  const wrong = rows.filter((r) => r.got !== r.want)
  if (wrong.length) throw new Error(`verify failed: ${wrong.map((r) => `${r.check}: wanted ${r.want}, got ${r.got}`).join('; ')}`)
  return rows
}

/** `mm` from MM_CLI, or this repository's apps/cli run exactly as `pnpm --filter @metamodels/cli start` runs it. */
export function spawnMm(env: NodeJS.ProcessEnv): Mm {
  const cliDir = fileURLToPath(new URL('../../../../apps/cli/', import.meta.url))
  const [cmd, ...pre] = env.MM_CLI
    ? env.MM_CLI.split(' ').filter(Boolean)
    : [process.execPath, '--import', './src/ts-resolve.ts', 'src/index.ts']
  return (args) => new Promise((resolve, reject) => {
    const child = spawn(cmd!, [...pre, ...args], { cwd: env.MM_CLI ? undefined : cliDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function main(): Promise<number> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) { process.stdout.write(HELP); return 0 }
  const o = parseOptions(process.argv.slice(2), process.env)
  const out = await provision(o, spawnMm(process.env))
  const key = out.key.plaintext ?? o.proxyKey
  const contract = {
    flock: { id: out.flock.id, name: out.flock.name, baseUrl: out.flock.baseUrl },
    paddock: { id: out.paddock.id, slug: o.slug },
    key: { id: out.key.id, name: out.key.name, minted: out.key.plaintext !== null },
    openaiBaseUrl: `${o.proxyUrl}/p/${o.slug}/v1`,
    models: o.models,
  }
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`)
  if (out.key.plaintext) process.stderr.write(`\nKEY (shown once, store it now): ${out.key.plaintext}\n\n`)
  if (!key) {
    process.stderr.write('verify skipped: no key was minted and MM_PROXY_KEY is unset. Re-run with --rotate-key, or set MM_PROXY_KEY.\n')
    return 1
  }
  for (const r of await verify(o, key)) process.stderr.write(`verify  ${r.check.padEnd(30)} ${r.got} (wanted ${r.want})\n`)
  process.stderr.write('verify  ok\n')
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code }, (e: unknown) => {
    process.stderr.write(`provision: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exitCode = 1
  })
}
