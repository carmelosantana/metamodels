import { escapeHtml, page } from './views.js'

/**
 * The device grant's browser pages (RFC 8628 §3.3), in the same shell and under the same CSP as
 * the sign-in pages: no script, the one stylesheet.
 *
 * `form` is oidc-provider's own form (method, action, xsrf token and user code) — trusted library
 * output, inserted verbatim like the logout form, and submitted by the buttons below via its id.
 * One exception: the input form carries an inline `onfocus` handler, which `default-src 'none'`
 * would block anyway; it is removed so the page carries no inline script at all.
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

/** `features.deviceFlow.userCodeInputSource`: where the operator types the code the CLI printed. */
export function renderUserCodePage(form: string, err?: UserCodeError): string {
  const message = userCodeError(err)
  const error = message ? `<p class="error" role="alert">${escapeHtml(message)}</p>\n` : ''
  return page('Connect the CLI', `<h1>Connect the MetaModels CLI</h1>
<p>Enter the code shown in your terminal.</p>
${error}${withoutInlineHandlers(form)}
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
