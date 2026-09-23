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
 * `features.deviceFlow.userCodeConfirmSource`: the operator checks the code matches their terminal
 * and approves. Approving continues to sign-in; Cancel marks the device code denied.
 */
export function renderDeviceConfirmPage(form: string, clientName: string, userCode: string): string {
  return page('Approve sign-in', `<h1>Approve this sign-in?</h1>
<p><strong>${escapeHtml(clientName)}</strong> is asking to act as you. Approve only if this code matches the one in your terminal:</p>
<p class="code">${escapeHtml(userCode)}</p>
${withoutInlineHandlers(form)}
<button autofocus type="submit" form="op.deviceConfirmForm">Approve</button>
<button class="secondary" type="submit" form="op.deviceConfirmForm" name="abort" value="yes">Cancel</button>`)
}
