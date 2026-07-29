export type LsFetch = (url: string, init: RequestInit) => Promise<Response>

/** Bounded per-request timeout so a hanging LS endpoint fails fast (on-login revalidation awaits it). */
const TIMEOUT_MS = 5000

export interface LsResult {
  valid: boolean
  status: string
  instanceId: string | null
  variantName: string | null
}

interface LsBody {
  activated?: boolean
  deactivated?: boolean
  valid?: boolean
  license_key?: { status?: string }
  instance?: { id?: string; name?: string } | null
  meta?: { variant_name?: string }
}

export class LemonSqueezyClient {
  private readonly fetchImpl: LsFetch
  private readonly baseUrl: string

  constructor(opts: { fetchImpl?: LsFetch; baseUrl?: string } = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
    this.baseUrl = opts.baseUrl ?? 'https://api.lemonsqueezy.com'
  }

  private async post(path: string, form: Record<string, string>): Promise<LsBody> {
    const body = new URLSearchParams(form).toString()
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return (await res.json()) as LsBody
  }

  private normalize(b: LsBody): LsResult {
    return {
      valid: b.valid ?? b.activated ?? false,
      status: b.license_key?.status ?? 'unknown',
      instanceId: b.instance?.id ?? null,
      variantName: b.meta?.variant_name ?? null,
    }
  }

  async activate(licenseKey: string, instanceName: string): Promise<LsResult> {
    return this.normalize(await this.post('/v1/licenses/activate', { license_key: licenseKey, instance_name: instanceName }))
  }

  async validate(licenseKey: string, instanceId: string | null): Promise<LsResult> {
    const form: Record<string, string> = { license_key: licenseKey }
    if (instanceId) form.instance_id = instanceId
    return this.normalize(await this.post('/v1/licenses/validate', form))
  }

  async deactivate(licenseKey: string, instanceId: string): Promise<{ deactivated: boolean }> {
    const b = await this.post('/v1/licenses/deactivate', { license_key: licenseKey, instance_id: instanceId })
    return { deactivated: b.deactivated ?? false }
  }
}
