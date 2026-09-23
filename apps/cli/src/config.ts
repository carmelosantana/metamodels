/**
 * Where the CLI points. Every URL comes from a flag or the environment — there is no default host,
 * because the only right one is the operator's own box.
 *
 * The variables are read on the operator's machine by the CLI, not by any MetaModels service.
 */
export const ISSUER_ENV = 'METAMODELS_ISSUER'
export const CONSOLE_ENV = 'METAMODELS_CONSOLE_URL'

/**
 * An http(s) origin, normalised to `URL.origin` (no trailing slash). The issuer must match the OP's
 * `issuer` byte for byte, and the console URL feeds `adminApiResource()`, which must match what the
 * console verifies — so neither may carry a path.
 */
function origin(value: string, what: string): string {
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
  return url.origin
}

function pick(flag: string | undefined, env: NodeJS.ProcessEnv, name: string, flagName: string, what: string): string {
  const value = flag ?? (env[name] || undefined)
  if (value === undefined) throw new Error(`no ${what} configured: pass ${flagName} or set ${name}`)
  return origin(value, what)
}

/** The OP's issuer URL: `--issuer`, else `METAMODELS_ISSUER`. */
export function resolveIssuer(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  return pick(flag, env, ISSUER_ENV, '--issuer', 'issuer')
}

/** The console's public URL: `--console`, else `METAMODELS_CONSOLE_URL`. */
export function resolveConsoleUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  return pick(flag, env, CONSOLE_ENV, '--console', 'console URL')
}
