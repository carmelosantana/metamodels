/**
 * Where the CLI points. Every URL comes from a flag or the environment — there is no default host,
 * because the only right one is the operator's own box.
 *
 * The variables are read on the operator's machine by the CLI, not by any MetaModels service.
 */
export const ISSUER_ENV = 'METAMODELS_ISSUER'
export const CONSOLE_ENV = 'METAMODELS_CONSOLE_URL'
export const INSECURE_HTTP_ENV = 'METAMODELS_ALLOW_INSECURE_HTTP'
export const INSECURE_HTTP_FLAG = '--allow-insecure-http'

/** The opt-in to plain http beyond loopback: `--allow-insecure-http`, or `METAMODELS_ALLOW_INSECURE_HTTP=1`. */
export function insecureHttpAllowed(flag: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  return flag === true || env[INSECURE_HTTP_ENV] === '1'
}

/** `localhost`, `127.0.0.0/8` or `::1`, as `URL.hostname` spells them (IPv4 forms already normalised). */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * Refuses a URL a credential would travel to — one the CLI sends a token or device code to, or one
 * it sends the operator to, to type their password — unless it is https, or plain http to a
 * loopback host, or plain http with the opt-in. Plain http anywhere else puts that credential on the
 * network in clear text. `exposed` names it in the refusal.
 */
export function requireSecureTransport(
  url: string, what: string, allowInsecureHttp: boolean, exposed = 'tokens sent to it',
): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${what} is not a URL: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol === 'https:') return
  if (parsed.protocol !== 'http:') throw new Error(`${what} must be an http(s) URL, got ${JSON.stringify(url)}`)
  if (isLoopback(parsed.hostname) || allowInsecureHttp) return
  throw new Error(
    `${what} ${url} is plain http to a host that is not loopback: ${exposed} could be read on the ` +
    `network. Use https, or pass ${INSECURE_HTTP_FLAG} (or set ${INSECURE_HTTP_ENV}=1) to allow it.`,
  )
}

/**
 * An http(s) origin, normalised to `URL.origin` (no trailing slash). The issuer must match the OP's
 * `issuer` byte for byte, and the console URL feeds `adminApiResource()`, which must match what the
 * console verifies — so neither may carry a path.
 */
function origin(value: string, what: string, allowInsecureHttp: boolean): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${what} must be an http(s) origin such as https://host:port, got ${JSON.stringify(value)}`)
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search !== '' || url.hash !== '' ||
      url.username !== '' || url.password !== '') {
    throw new Error(`${what} must be an http(s) origin such as https://host:port, with no path, got ${JSON.stringify(value)}`)
  }
  requireSecureTransport(url.origin, `the ${what}`, allowInsecureHttp)
  return url.origin
}

function pick(
  flag: string | undefined, env: NodeJS.ProcessEnv, name: string, flagName: string, what: string, allowInsecureHttp: boolean,
): string {
  const value = flag ?? (env[name] || undefined)
  if (value === undefined) throw new Error(`no ${what} configured: pass ${flagName} or set ${name}`)
  return origin(value, what, allowInsecureHttp)
}

/** The OP's issuer URL: `--issuer`, else `METAMODELS_ISSUER`. */
export function resolveIssuer(flag: string | undefined, env: NodeJS.ProcessEnv, allowInsecureHttp = false): string {
  return pick(flag, env, ISSUER_ENV, '--issuer', 'issuer', allowInsecureHttp)
}

/** The console's public URL: `--console`, else `METAMODELS_CONSOLE_URL`. */
export function resolveConsoleUrl(flag: string | undefined, env: NodeJS.ProcessEnv, allowInsecureHttp = false): string {
  return pick(flag, env, CONSOLE_ENV, '--console', 'console URL', allowInsecureHttp)
}
