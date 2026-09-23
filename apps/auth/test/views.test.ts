import { describe, expect, test } from 'vitest'
import {
  AUTH_CSS, authCsp, escapeHtml, renderConsoleSwitchAccountPage, renderLoginPage, renderLogoutPage,
  renderMessagePage, switchAccountPage,
} from '../src/views.js'

function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out[name] = values
  }
  return out
}

const ALL_PAGES = [
  renderLoginPage({ uid: 'u1', email: 'a@x.io', error: 'bad' }),
  renderMessagePage('Title', 'Message'),
  renderLogoutPage('<form id="op.logoutForm" method="post" action="/session/end/confirm"></form>'),
  renderConsoleSwitchAccountPage('/session/end/confirm', 'abc123'),
]

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})

describe('renderLoginPage', () => {
  test('posts credentials to this interaction and keeps the console\'s labels', () => {
    const html = renderLoginPage({ uid: 'abc123' })
    expect(html).toContain('<form method="post" action="/interaction/abc123/login">')
    expect(html).toContain('<label for="email">Email</label>')
    expect(html).toContain('<label for="password">Password</label>')
    expect(html).toContain('<button type="submit">Sign in</button>')
    expect(html).not.toContain('role="alert"')
  })

  test('escapes a hostile prefilled email and error message', () => {
    const html = renderLoginPage({ uid: 'u', email: '"><script>alert(1)</script>', error: '<b>x</b>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
    expect(html).toContain('<p class="error" role="alert">&lt;b&gt;x&lt;/b&gt;</p>')
  })

  test('a hostile uid cannot break out of the form action', () => {
    const html = renderLoginPage({ uid: 'x" onsubmit="evil' })
    expect(html).toContain('action="/interaction/x%22%20onsubmit%3D%22evil/login"')
  })
})

describe('renderMessagePage and renderLogoutPage', () => {
  test('escape title and message', () => {
    const html = renderMessagePage('<T>', '<M>')
    expect(html).toContain('<h1>&lt;T&gt;</h1>')
    expect(html).toContain('<p>&lt;M&gt;</p>')
  })

  test('the logout page embeds the provider\'s form verbatim and targets it', () => {
    const form = '<form id="op.logoutForm" method="post" action="/session/end/confirm"><input type="hidden" name="xsrf" value="t"/></form>'
    const html = renderLogoutPage(form)
    expect(html).toContain(form)
    expect(html).toContain('form="op.logoutForm" value="yes" name="logout">Sign out</button>')
  })
})

describe('switchAccountPage', () => {
  test('explains the switch and posts the logout step with its xsrf token behind a visible button', () => {
    const html = switchAccountPage('http://op.test/session/end/confirm', 'abc123', 'do the next thing')
    expect(html).toContain('<h1>Switch account?</h1>')
    expect(html).toContain('Continue to sign that account out here and do the next thing.</p>')
    expect(html).toContain('<form id="op.switchAccountForm" method="post" action="http://op.test/session/end/confirm">')
    expect(html).toContain('<input type="hidden" name="xsrf" value="abc123"/>')
    expect(html).toContain('<input type="hidden" name="logout" value="yes"/>')
    expect(html).toContain('<button autofocus type="submit" form="op.switchAccountForm">Continue</button>')
  })

  test('escapes every value', () => {
    const html = switchAccountPage('/x"><script>', '"><script>', '<script>')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('action="/x&quot;&gt;&lt;script&gt;"')
  })

  test('the console\'s page continues to the sign-in', () => {
    const html = renderConsoleSwitchAccountPage('/session/end/confirm', 'abc123')
    expect(html).toContain('<h1>Switch account?</h1>')
    expect(html).toContain('Continue to sign that account out here and sign in as the account you just entered.</p>')
    expect(html).toContain('<input type="hidden" name="xsrf" value="abc123"/>')
  })
})

describe('CSP compatibility', () => {
  test('no page carries inline script or inline style', () => {
    for (const html of ALL_PAGES) {
      expect(html).not.toMatch(/<script/i)
      expect(html).not.toMatch(/<style/i)
      expect(html).not.toMatch(/\sstyle=/i)
      expect(html).toContain('<link rel="stylesheet" href="/assets/auth.css">')
    }
  })

  test('the stylesheet loads nothing external', () => {
    expect(AUTH_CSS).not.toMatch(/url\(|@import/)
  })

  test('authCsp is strict and lets forms redirect only to the given origins', () => {
    const d = directives(authCsp(['https://console.example.test']))
    expect(d['default-src']).toEqual(["'none'"])
    expect(d['style-src']).toEqual(["'self'"])
    expect(d['form-action']).toEqual(["'self'", 'https://console.example.test'])
    expect(d['frame-ancestors']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'none'"])
    expect(authCsp([])).not.toContain('unsafe-inline')
  })
})
