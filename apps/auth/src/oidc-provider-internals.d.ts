// Two oidc-provider 9.12 helpers used on purpose. `isValidClientIdUrl` is the library's own CIMD
// client-id check (https, no fragment, no userinfo, no dot-segments); `fetch_request` is the fetch
// its CIMD resolution uses, which installs the SSRF guard. If a minor release moves either file,
// the imports below fail at build time and in `test/cimd.test.ts`, not silently.
declare module 'oidc-provider/lib/helpers/client_id_metadata_document.js' {
  export function isValidClientIdUrl(id: string): boolean
}

declare module 'oidc-provider/lib/helpers/fetch_request.js' {
  import type Provider from 'oidc-provider'
  export default function fetchRequest(provider: Provider, url: string, options: RequestInit): Promise<Response>
  export function isSpecialUseIP(address: string): boolean
}
