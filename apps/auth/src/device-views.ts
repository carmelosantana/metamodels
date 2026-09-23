import { escapeHtml, page } from './views.js'

/**
 * The device grant's browser pages (RFC 8628 §3.3), in the same shell and under the same CSP as
 * the sign-in pages: no script, the one stylesheet.
 *
 * `form` is oidc-provider's own form (method, action, xsrf token and user code) — trusted library
 * output, inserted like the logout form, and submitted by the buttons below via its id. Two changes
 * are made to the input form only. Its inline `onfocus` handler is removed: `default-src 'none'`
 * would block it anyway, and removing it keeps the page free of inline script. A code prefilled from
 * `verification_uri_complete` is added, escaped, as the input's value (after the handler is removed,
 * so the removal cannot rewrite the code).
 */
function withoutInlineHandlers(form: string): string {
  return form.replace(/\s+on[a-z]+="[^"]*"/gi, '')
}

/**
 * The error oidc-provider re-renders the entry page with. Its ReRenderErrors are told apart by
 * `name`; `userCode` is set only on those raised while checking a code the browser posted to /device.
 */
export interface UserCodeError {
  name?: string
  userCode?: string
}

function userCodeError(err: UserCodeError | undefined): string | undefined {
  if (!err) return undefined
  switch (err.name) {
    case 'ExpiredError':
      return 'That code has expired. Start the sign-in again from your terminal.'
    // A code already approved, cancelled or refused, or whose approval is already under way.
    case 'AlreadyUsedError':
      return 'That code was already used or cancelled. Start the sign-in again from your terminal.'
    case 'AbortedError':
      return 'The sign-in was cancelled.'
  }
  if (err.userCode !== undefined || err.name === 'NoCodeError' || err.name === 'NotFoundError') {
    return 'That code is not valid. Check your terminal and try again.'
  }
  return 'Something went wrong. Start the sign-in again from your terminal.'
}

/**
 * Put `code` into the provider form's visible user_code input. The code comes from a URL anyone can
 * send, so it is escaped like every other value on these pages. The form is otherwise untouched:
 * its xsrf token and action stay the provider's, so Continue goes through the normal POST.
 */
function withPrefilledCode(form: string, code: string | undefined): string {
  if (!code) return form
  return form.replace(/(<input\s[^>]*?)\bname="user_code"/, `$1name="user_code" value="${escapeHtml(code)}"`)
}

/**
 * `features.deviceFlow.userCodeInputSource`: where the operator types the code the CLI printed.
 * `prefill` is the code from `verification_uri_complete` (`/device?user_code=…`), shown filled in
 * for the operator to check and submit with Continue.
 */
export function renderUserCodePage(form: string, err?: UserCodeError, prefill?: string): string {
  const message = userCodeError(err)
  const error = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>\n` : ''
  return page('Connect the CLI', `<h1>Connect the MetaModels CLI</h1>
<p>Enter the code shown in your terminal.</p>
${error}${withPrefilledCode(withoutInlineHandlers(form), prefill)}
<button type="submit" form="op.deviceInputForm">Continue</button>`)
}

/**
 * Where the device authorization request came from — the machine running the CLI, not the browser
 * approving it. oidc-provider's default `features.deviceFlow.deviceInfo` records these at
 * `/device/auth`: `ctx.ip` (with `provider.proxy = true`, the first X-Forwarded-For hop) and the
 * User-Agent header. Both are sent by the requester, so neither is trusted or proof of anything.
 */
export interface DeviceInfo {
  ip?: unknown
  ua?: unknown
}

function shown(value: unknown): string {
  return typeof value === 'string' && value !== '' ? escapeHtml(value) : 'unknown'
}

/**
 * `features.deviceFlow.userCodeConfirmSource`: the operator checks the code matches their terminal
 * and where the request came from, then approves. Approving continues to sign-in; Cancel marks the
 * device code denied.
 */
export function renderDeviceConfirmPage(form: string, clientName: string, userCode: string, device: DeviceInfo): string {
  return page('Approve sign-in', `<h1>Approve this sign-in?</h1>
<p><strong>${escapeHtml(clientName)}</strong> is asking to act as you. Approve only if this code matches the one in your terminal:</p>
<p class="code">${escapeHtml(userCode)}</p>
<p>The request came from:</p>
<p class="device">IP address: <strong>${shown(device.ip)}</strong><br>User agent: <strong>${shown(device.ua)}</strong></p>
<p>If this is not your machine, or you did not just start this sign-in yourself, press Cancel. Someone may be trying to get into your account.</p>
${withoutInlineHandlers(form)}
<button autofocus type="submit" form="op.deviceConfirmForm">Approve</button>
<button class="secondary" type="submit" form="op.deviceConfirmForm" name="abort" value="yes">Cancel</button>`)
}

/**
 * Shown when a device approval's login is by a different account than the one this browser's OP
 * session holds. oidc-provider handles that case by ending the old session first: the browser posts
 * `logout=yes` and the library's xsrf token to its logout-confirm endpoint, which redirects back to
 * the device flow, now as the new account. The library sends that POST from an auto-submitting
 * script page, which our CSP blocks. This page is the same form, with a button and an explanation.
 */
export function renderSwitchAccountPage(action: string, xsrf: string): string {
  return page('Switch account', `<h1>Switch account?</h1>
<p>This browser is signed in to MetaModels as a different account. Continue to sign that account out here and approve the CLI as the account you just entered.</p>
<form id="op.switchAccountForm" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="xsrf" value="${escapeHtml(xsrf)}"/>
<input type="hidden" name="logout" value="yes"/>
</form>
<button autofocus type="submit" form="op.switchAccountForm">Continue</button>`)
}
