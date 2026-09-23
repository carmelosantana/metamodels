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

  test('says why a code was refused', () => {
    expect(renderUserCodePage(INPUT_FORM, { name: 'NotFoundError', userCode: 'X' }))
      .toContain('<p class="error" role="alert">That code is not valid. Check your terminal and try again.</p>')
    expect(renderUserCodePage(INPUT_FORM, { name: 'NoCodeError' }))
      .toContain('That code is not valid.')
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
