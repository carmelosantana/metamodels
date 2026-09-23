import { describe, expect, test } from 'vitest'
import { renderDeviceConfirmPage, renderUserCodePage } from '../src/device-views.js'

// The exact markup oidc-provider 9.12 hands the two sources (lib/helpers/user_code_form.js),
// including the inline `onfocus` handler the input form carries.
const INPUT_FORM = `<form id="op.deviceInputForm" novalidate method="post" action="/device">
  <input type="hidden" name="xsrf" value="t0ken"/>
  <input
    type="text" name="user_code" placeholder="Enter code" onfocus="this.select(); this.onfocus = undefined;" autofocus autocomplete="off"></input>
  </form>`
const CONFIRM_FORM = `<form id="op.deviceConfirmForm" method="post" action="/device">
<input type="hidden" name="xsrf" value="t0ken"/>
<input type="hidden" name="user_code" value="BCDF-GHJK"/>
<input type="hidden" name="confirm" value="yes"/>
</form>`

describe('renderUserCodePage', () => {
  test('embeds the provider form and a submit button that targets it', () => {
    const html = renderUserCodePage(INPUT_FORM)
    expect(html).toContain('name="xsrf" value="t0ken"')
    expect(html).toContain('name="user_code"')
    expect(html).toContain('<button type="submit" form="op.deviceInputForm">Continue</button>')
    expect(html).not.toContain('role="alert"')
  })

  test('prefills the code from verification_uri_complete into the provider\'s own input', () => {
    const html = renderUserCodePage(INPUT_FORM, undefined, 'BCDF-GHJK')
    expect(html).toContain('type="text" name="user_code" value="BCDF-GHJK" placeholder="Enter code"')
    // Still the provider's form: its xsrf token rides along, and Continue submits it.
    expect(html).toContain('name="xsrf" value="t0ken"')
    expect(html).toContain('<button type="submit" form="op.deviceInputForm">Continue</button>')
  })

  test('escapes a hostile prefilled code: it comes from a URL anyone can send', () => {
    const hostile = `"><script>alert('x')</script><input value="`
    const html = renderUserCodePage(INPUT_FORM, undefined, hostile)
    expect(html).toContain('name="user_code" value="&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&lt;input value=&quot;" placeholder')
    expect(html).not.toMatch(/<script/i)
    // Exactly one user_code input: nothing broke out of the attribute.
    expect(html.match(/name="user_code"/g)).toHaveLength(1)
  })

  test('a prefilled code that looks like a handler is kept as text, not reshaped by the handler strip', () => {
    const html = renderUserCodePage(INPUT_FORM, undefined, 'x onfocus=')
    expect(html).toContain('name="user_code" value="x onfocus=" placeholder="Enter code" autofocus autocomplete="off">')
  })

  test('without a prefill the input is left empty', () => {
    expect(renderUserCodePage(INPUT_FORM)).toContain('type="text" name="user_code" placeholder="Enter code"')
    expect(renderUserCodePage(INPUT_FORM, undefined, '')).toContain('type="text" name="user_code" placeholder="Enter code"')
  })

  test('says why a code was refused', () => {
    expect(renderUserCodePage(INPUT_FORM, { name: 'NotFoundError', userCode: 'X' }))
      .toContain('<p class="error" role="alert">That code is not valid. Check your terminal and try again.</p>')
    expect(renderUserCodePage(INPUT_FORM, { name: 'NoCodeError' }))
      .toContain('That code is not valid.')
    // oidc-provider's ReRenderErrors, by name (lib/helpers/re_render_errors.js). A dead code is
    // told apart from a mistyped one: retyping the same dead code from the terminal cannot help.
    expect(renderUserCodePage(INPUT_FORM, { name: 'ExpiredError', userCode: 'X' }))
      .toContain('<p class="error" role="alert">That code has expired. Start the sign-in again from your terminal.</p>')
    expect(renderUserCodePage(INPUT_FORM, { name: 'ExpiredError' }))
      .toContain('That code has expired.')
    expect(renderUserCodePage(INPUT_FORM, { name: 'AlreadyUsedError', userCode: 'X' }))
      .toContain('<p class="error" role="alert">That code was already used or cancelled. Start the sign-in again from your terminal.</p>')
    expect(renderUserCodePage(INPUT_FORM, { name: 'AlreadyUsedError' }))
      .toContain('That code was already used or cancelled.')
    expect(renderUserCodePage(INPUT_FORM, { name: 'AbortedError' }))
      .toContain('<p class="error" role="alert">The sign-in was cancelled.</p>')
    expect(renderUserCodePage(INPUT_FORM, { name: 'SomethingElse' }))
      .toContain('<p class="error" role="alert">Something went wrong. Start the sign-in again from your terminal.</p>')
  })
})

describe('renderDeviceConfirmPage', () => {
  test('names the client, shows the code, and approves through the provider form', () => {
    const html = renderDeviceConfirmPage(CONFIRM_FORM, 'MetaModels admin CLI', 'BCDF-GHJK')
    expect(html).toContain(CONFIRM_FORM)
    expect(html).toContain('<strong>MetaModels admin CLI</strong>')
    expect(html).toContain('<p class="code">BCDF-GHJK</p>')
    expect(html).toContain('<button autofocus type="submit" form="op.deviceConfirmForm">Approve</button>')
    expect(html).toContain('<button class="secondary" type="submit" form="op.deviceConfirmForm" name="abort" value="yes">Cancel</button>')
  })

  test('escapes a hostile client name and user code', () => {
    const html = renderDeviceConfirmPage(CONFIRM_FORM, '<img src=x>', '"><script>x</script>')
    expect(html).toContain('<strong>&lt;img src=x&gt;</strong>')
    expect(html).toContain('<p class="code">&quot;&gt;&lt;script&gt;x&lt;/script&gt;</p>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })
})

describe('CSP compatibility', () => {
  const pages = [
    renderUserCodePage(INPUT_FORM),
    renderUserCodePage(INPUT_FORM, { name: 'NotFoundError' }),
    renderDeviceConfirmPage(CONFIRM_FORM, 'MetaModels admin CLI', 'BCDF-GHJK'),
  ]

  test('no device page carries inline script, an inline event handler, or inline style', () => {
    for (const html of pages) {
      expect(html).toContain('<link rel="stylesheet" href="/assets/auth.css">')
      expect(html).not.toMatch(/<script/i)
      expect(html).not.toMatch(/\son[a-z]+=/i)
      expect(html).not.toMatch(/<style/i)
      expect(html).not.toMatch(/\sstyle=/i)
    }
  })

  test('stripping the handler leaves the input itself intact', () => {
    const html = renderUserCodePage(INPUT_FORM)
    expect(INPUT_FORM).toContain('onfocus=')
    expect(html).toContain('type="text" name="user_code" placeholder="Enter code" autofocus autocomplete="off">')
  })
})
