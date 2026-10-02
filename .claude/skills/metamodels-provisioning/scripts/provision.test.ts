import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseOptions, provision, verify, type Mm, type Options } from './provision.ts'

const OPTS: Options = parseOptions([
  '--ollama-url', 'http://ollama.test:11434', '--proxy-url', 'http://dp.test', '--models', 'qwen3:8b',
], {})

/**
 * The admin API as `mm` presents it: JSON on stdout, a next-page hint on stderr, a non-zero exit on
 * an error. Only what provisioning touches. `calls` records every command line it was given.
 */
function fakeMm(pageSize = 50) {
  let n = 0
  const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const flocks: Record<string, unknown>[] = []
  const paddocks: Record<string, unknown>[] = []
  const keys: Record<string, unknown>[] = []
  const fences = new Map<string, unknown>()
  const calls: string[][] = []
  const ok = (body: unknown, stderr = '') => ({ code: 0, stdout: body === undefined ? '' : JSON.stringify(body), stderr })
  const data = (args: string[]) => JSON.parse(args[args.indexOf('--data') + 1]!) as Record<string, unknown>
  const page = (rows: unknown[], args: string[]) => {
    const at = args.includes('--cursor') ? Number(args[args.indexOf('--cursor') + 1]) : 0
    const next = at + pageSize < rows.length ? `More results: repeat with --cursor ${at + pageSize}\n` : ''
    return ok(rows.slice(at, at + pageSize), next)
  }
  const mm: Mm = async (args) => {
    calls.push(args)
    const [group, action, target] = args
    if (group === 'flocks' && action === 'list') return page(flocks, args)
    if (group === 'flocks' && action === 'create') { const f = { id: id(), ...data(args) }; flocks.push(f); return ok(f) }
    if (group === 'flocks' && action === 'replace') {
      const f = flocks.find((x) => x.id === target)!
      Object.assign(f, data(args))
      return ok(f)
    }
    if (group === 'paddocks' && action === 'list') return page(paddocks, args)
    if (group === 'paddocks' && action === 'create') { const p = { id: id(), status: 'active', ...data(args) }; paddocks.push(p); return ok(p) }
    if (group === 'paddocks' && action === 'replace') {
      const p = paddocks.find((x) => x.id === target)!
      Object.assign(p, data(args))
      return ok(p)
    }
    if (group === 'fence' && action === 'set') { fences.set(target!, data(args)); return ok({ paddockId: target, ...data(args) }) }
    if (group === 'keys' && action === 'list') return page(keys, args)
    if (group === 'keys' && action === 'create') {
      const body = data(args)
      const k = { id: id(), name: body.name, status: 'active', kind: 'live', prefix: 'mm_live_abcd' }
      keys.push({ ...k, paddockSlugs: (body.paddockIds as string[]).map((pid) => paddocks.find((p) => p.id === pid)!.slug) })
      return ok({ ...k, plaintext: `mm_live_secret_${n}` })
    }
    if (group === 'keys' && action === 'revoke') { keys.find((k) => k.id === target)!.status = 'revoked'; return ok(undefined) }
    return { code: 2, stdout: '', stderr: `fake mm: unhandled ${args.join(' ')}` }
  }
  return { mm, calls, flocks, paddocks, keys, fences }
}

describe('parseOptions', () => {
  test('the Ollama URL, the data-plane URL and the models are required; nothing names a host by default', () => {
    expect(() => parseOptions(['--proxy-url', 'http://dp.test', '--models', 'm'], {})).toThrow(/--ollama-url/)
    expect(() => parseOptions(['--ollama-url', 'http://o.test:11434', '--models', 'm'], {})).toThrow(/--proxy-url/)
    expect(() => parseOptions(['--ollama-url', 'http://o.test:11434', '--proxy-url', 'http://dp.test'], {})).toThrow(/--models/)
  })

  test('each may come from the environment instead', () => {
    const o = parseOptions([], { MM_OLLAMA_URL: 'http://o.test:11434', MM_PROXY_URL: 'http://dp.test', MM_MODELS: 'a, b' })
    expect(o).toMatchObject({ ollamaUrl: 'http://o.test:11434', proxyUrl: 'http://dp.test', models: ['a', 'b'] })
  })

  test('the defaults describe the timeinvoice paddock', () => {
    expect(OPTS).toMatchObject({
      slug: 'timeinvoice', paddockName: 'TimeInvoice', flockName: 'timeinvoice-ollama', keyName: 'timeinvoice',
      routes: ['chat', 'read'], rateLimit: { max: 60, windowSec: 60 }, rotateKey: false,
    })
  })

  test('a malformed rate or URL is refused before anything is sent', () => {
    expect(() => parseOptions(['--rate', '60'], { MM_OLLAMA_URL: 'http://o.test', MM_PROXY_URL: 'http://dp.test', MM_MODELS: 'm' })).toThrow(/--rate/)
    expect(() => parseOptions(['--ollama-url', 'ollama:11434'], { MM_PROXY_URL: 'http://dp.test', MM_MODELS: 'm' })).toThrow(/--ollama-url/)
  })
})

describe('provision', () => {
  test('creates the flock, paddock, fence and key through mm, and returns the key once', async () => {
    const f = fakeMm()
    const out = await provision(OPTS, f.mm)
    expect(f.flocks).toEqual([expect.objectContaining({ name: 'timeinvoice-ollama', breed: 'ollama', baseUrl: 'http://ollama.test:11434', tlsTrust: false })])
    expect(f.paddocks).toEqual([expect.objectContaining({ slug: 'timeinvoice', name: 'TimeInvoice', flockId: out.flock.id })])
    expect(f.fences.get(out.paddock.id)).toEqual({
      constraintJson: { allowedRoutes: ['chat', 'read'], allowedModels: ['qwen3:8b'] }, rateLimit: { max: 60, windowSec: 60 },
    })
    expect(out.key).toMatchObject({ name: 'timeinvoice', plaintext: expect.stringMatching(/^mm_live_/) })
  })

  test('a second run changes nothing it does not own, replaces in place, and mints no second key', async () => {
    const f = fakeMm()
    const first = await provision(OPTS, f.mm)
    const again = await provision({ ...OPTS, ollamaUrl: 'http://other.test:11434' }, f.mm)
    expect(f.flocks).toHaveLength(1)
    expect(f.flocks[0]!.baseUrl).toBe('http://other.test:11434')
    expect(f.paddocks).toHaveLength(1)
    expect(again.paddock.id).toBe(first.paddock.id)
    expect(f.keys).toHaveLength(1)
    expect(again.key).toEqual({ id: first.key.id, name: 'timeinvoice', plaintext: null })
    expect(f.calls.filter((c) => c[0] === 'keys' && c[1] === 'create')).toHaveLength(1)
  })

  test('an unchanged flock or paddock is left alone, so a re-run adds no audit entry for them', async () => {
    const f = fakeMm()
    await provision(OPTS, f.mm)
    f.calls.length = 0
    await provision(OPTS, f.mm)
    expect(f.calls.map((c) => c.slice(0, 2).join(' ')).filter((c) => c.endsWith('replace') || c.endsWith('create'))).toEqual([])
  })

  test('--rotate-key revokes the active key of that name and mints a fresh one', async () => {
    const f = fakeMm()
    const first = await provision(OPTS, f.mm)
    const rotated = await provision({ ...OPTS, rotateKey: true }, f.mm)
    expect(f.keys.map((k) => [k.id, k.status])).toEqual([[first.key.id, 'revoked'], [rotated.key.id, 'active']])
    expect(rotated.key.plaintext).toMatch(/^mm_live_/)
  })

  test('finds existing objects past the first page', async () => {
    const f = fakeMm(1)
    for (let i = 0; i < 3; i++) f.flocks.push({ id: `other-${i}`, name: `other-${i}` })
    await provision(OPTS, f.mm)
    await provision(OPTS, f.mm)
    expect(f.flocks.filter((x) => x.name === 'timeinvoice-ollama')).toHaveLength(1)
  })

  test('a paddock slug taken by another flock is refused, not silently re-pointed', async () => {
    const f = fakeMm()
    f.paddocks.push({ id: 'p-other', slug: 'timeinvoice', name: 'Someone else', flockId: 'f-other', status: 'active' })
    await expect(provision(OPTS, f.mm)).rejects.toThrow(/timeinvoice.*another flock/)
  })

  test('an mm failure stops the run with its stderr', async () => {
    const mm: Mm = async () => ({ code: 1, stdout: '', stderr: '403 Forbidden: capability resource.write' })
    await expect(provision(OPTS, mm)).rejects.toThrow(/resource\.write/)
  })
})

describe('verify', () => {
  /** A data plane that enforces the fence it was given, with a request log. */
  function fakeProxy(key: string, models: string[]) {
    const seen: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const auth = new Headers(init?.headers).get('authorization')
      seen.push(`${init?.method ?? 'GET'} ${u}`)
      if (auth !== `Bearer ${key}`) return new Response('{"error":"unauthorized"}', { status: 401 })
      if (u.endsWith('/api/pull')) return new Response('{}', { status: 403 })
      const model = JSON.parse(String(init?.body)).model as string
      if (!models.includes(model)) return new Response('{}', { status: 403 })
      return Response.json({ choices: [{ message: { content: 'pong' } }] })
    }) as typeof fetch
    return { fetchImpl, seen }
  }

  test('proves the matrix with real requests: allowed 200, stray model 403, pull 403, no key 401', async () => {
    const p = fakeProxy('mm_live_k', ['qwen3:8b'])
    const rows = await verify(OPTS, 'mm_live_k', p.fetchImpl)
    expect(rows.map((r) => [r.check, r.want, r.got])).toEqual([
      ['allowed model', 200, 200], ['model outside the allowlist', 403, 403], ['model management (/api/pull)', 403, 403], ['no key', 401, 401],
    ])
    expect(p.seen[0]).toBe('POST http://dp.test/p/timeinvoice/v1/chat/completions')
  })

  test('any cell that does not match fails the verify, naming it', async () => {
    const open = (async () => Response.json({ choices: [] })) as unknown as typeof fetch
    await expect(verify(OPTS, 'mm_live_k', open)).rejects.toThrow(/model outside the allowlist: wanted 403, got 200/)
  })
})

describe('the skill ships no host of anyone\'s network (Kanboard #4561)', () => {
  test('no private IPv4 address appears in any file of the skill', () => {
    const dir = join(import.meta.dirname, '..')
    const files: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else files.push(p)
      }
    }
    walk(dir)
    expect(files.length).toBeGreaterThan(2)
    const privateIp = /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/
    // Built so this file does not match itself.
    for (const f of files) expect(readFileSync(f, 'utf8').match(privateIp)?.[0], f).toBeUndefined()
  })
})
