/** Escape text for HTML element content and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The console's palette (apps/control-plane/src/app/globals.css), restated — this service has no bundler. */
export const AUTH_CSS = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141110;color:#ece4d6;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
.card{width:360px;max-width:calc(100vw - 32px);border:1px solid #2e2620;border-radius:9px;background:#1a1614;padding:24px}
.brand{margin-bottom:24px;font:600 18px ui-monospace,monospace;color:#acb965}
h1{margin:0 0 12px;font-size:16px}
p{margin:0 0 16px;color:#9a8b7c}
label{display:block;margin-bottom:6px;font-size:13px}
input{width:100%;margin-bottom:16px;padding:8px 10px;border:1px solid #3a2f28;border-radius:7px;background:#141110;color:#ece4d6;font:inherit}
button{width:100%;padding:9px 12px;border:0;border-radius:7px;background:#acb965;color:#23260f;font:600 14px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
button.secondary{margin-top:8px;background:transparent;color:#9a8b7c;border:1px solid #2e2620}
.error{color:#cf5f4b}
`

/**
 * The auth service's Content-Security-Policy. Static: no page has inline script or style, so no
 * nonce is needed. `form-action` lists every origin a form POST may end up redirecting to,
 * because Chrome enforces form-action across the redirect chain — the login POST ends at the
 * console's /auth/callback, and logout confirmation ends at the console's /login.
 */
export function authCsp(redirectOrigins: readonly string[]): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    ['form-action', "'self'", ...redirectOrigins].join(' '),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · MetaModels</title>
<link rel="stylesheet" href="/assets/auth.css">
</head>
<body>
<main class="card">
<div class="brand">MetaModels</div>
${body}
</main>
</body>
</html>`
}

export function renderLoginPage(opts: { uid: string; email?: string; error?: string }): string {
  const error = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>\n` : ''
  return page('Sign in', `<form method="post" action="/interaction/${encodeURIComponent(opts.uid)}/login">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(opts.email ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
${error}<button type="submit">Sign in</button>
</form>`)
}

export function renderMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`)
}

/**
 * RP-initiated logout confirmation. `form` is oidc-provider's own hidden form (method, action and
 * xsrf token) — trusted library output, inserted verbatim; the buttons submit it by id.
 */
export function renderLogoutPage(form: string): string {
  return page('Sign out', `<h1>Sign out of MetaModels?</h1>
${form}
<button autofocus type="submit" form="op.logoutForm" value="yes" name="logout">Sign out</button>
<button class="secondary" type="submit" form="op.logoutForm">Stay signed in</button>`)
}
