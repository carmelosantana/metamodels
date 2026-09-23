# The admin API and the `mm` CLI

Everything the console does to flocks, paddocks, fences, workflow templates and API keys can also
be done over HTTP, from a script or from the `mm` command-line tool. This page is for operators:
how to sign in, what a token may do, what each route is, and how to rotate the key that signs the
tokens.

The machine-readable contract is [`docs/api/openapi.json`](api/openapi.json). A running console also
serves it, without a token, at `$CONSOLE_URL/api/admin/v1/openapi.json`.

Below, `$CONSOLE_URL` is your console's public URL and `$OIDC_ISSUER` is your sign-in service's
public URL: the same values as the stack's `CONSOLE_URL` and `OIDC_ISSUER` (see
[DEPLOY.md](DEPLOY.md)).

## Base URL and versioning

Every route lives under **`$CONSOLE_URL/api/admin/v1`**. The admin API is served by the console
itself, so publishing one publishes the other.

The `v1` path segment is the major version: a breaking change would need a new one, `/api/admin/v2`.
Adding things (a route, an optional query parameter, a response field) is not breaking and happens
within `v1`, so clients should ignore fields they do not know. The OpenAPI document's
`info.version` tracks the release, independently of the path's major version.

Access tokens are issued for the resource `$CONSOLE_URL/api/admin` (no version). That value is the
`aud` of every admin-API token, and it covers every version under it.

## Signing in with the CLI

`mm` is the CLI in `apps/cli`. From a checkout of this repository (Node 24 or newer):

```bash
pnpm --filter @metamodels/cli start -- login \
  --issuer "$OIDC_ISSUER" --console "$CONSOLE_URL" --scope read,resource.write
```

Instead of the flags you can set `METAMODELS_ISSUER` and `METAMODELS_CONSOLE_URL`. There is no
default host. `--scope` defaults to `read`.

Signing in uses the OAuth device flow. It never asks you to paste a token:

1. `mm login` prints a link to the sign-in service and a code, then waits.
2. Open the link in any browser. It shows the code filled in. Check that it matches the code in
   your terminal, and press **Continue**.
3. The next page shows the **IP address and user agent of the machine that asked to sign in**.
   The user agent reads `metamodels-cli (<platform>; <arch>)`. If the machine is not yours, or you
   did not just run `mm login`, press **Cancel**: someone may be trying to get you to approve their
   sign-in. Otherwise press **Approve**.
4. Type your MetaModels email and password. **The password is asked for every time**, even if the
   browser is already signed in to the console. This is deliberate: an approval must come from
   someone who knows the password, not just from an open browser tab.
5. The page says *Signed in* and `mm login` exits.

The code expires after 10 minutes. Run `mm login` again if it does.

### Plain http

`mm` sends tokens only over https, or over plain http to a loopback host (`localhost`,
`127.0.0.0/8`, `::1`). The same rule applies to every endpoint and sign-in page the sign-in service
names. For a stack on your LAN served over plain http, pass `--allow-insecure-http` or set
`METAMODELS_ALLOW_INSECURE_HTTP=1`. Every run then prints a warning, because the tokens, and the
password you type into the sign-in page, can be read by anyone on that network.

### Where the credentials live

`mm` stores tokens in `$XDG_CONFIG_HOME/metamodels/credentials.json`, or
`~/.config/metamodels/credentials.json` when `XDG_CONFIG_HOME` is unset. The file is mode `0600`
and its directory `0700`. `mm` refuses a credentials file that other users can read or write, a
directory they can write to, and either one if another user owns it. One file holds sign-ins to
several MetaModels stacks, one per issuer.

The file holds a one-hour access token and a refresh token. `mm` renews the access token by itself
when the API refuses it. A refresh token expires after 30 days of disuse, and 90 days after the
sign-in at the latest.

**If a renewal fails, sign in again.** A refresh token is used up on every attempt, even a refused
one, so `mm` forgets the sign-in and tells you to run `mm login`. Retrying would only look like a
stolen token being replayed, and the sign-in service would revoke the whole sign-in.

### Signing out

```bash
pnpm --filter @metamodels/cli start -- logout --issuer "$OIDC_ISSUER"
```

`mm logout` revokes the refresh token at the sign-in service, then deletes it from this machine.
An access token already issued cannot be revoked. It stays valid until it expires (one hour at
most), and `mm logout` says when that is.

Each machine's sign-in is independent. Every approval creates its own sign-in, so logging out on one
machine, or running `mm login` again there, does not sign any other machine out.

### Commands

`mm --help` lists every command. They map one to one onto the routes below, except
`DELETE /keys/{id}` and `/openapi.json`. Output is JSON on stdout. Errors go to stderr, with exit
code `1`, or `2` when the command line itself is wrong and nothing was sent. Request bodies come from `--data '<json>'` or `--file <path>` (`--file -` reads
stdin). For example:

```bash
mm flocks create --data '{"name":"gpu-box","breed":"ollama","baseUrl":"http://<ollama-host>:11434","tlsTrust":false}'
mm paddocks create --data '{"flockId":"<flock-id>","name":"Team chat","slug":"team-chat"}'
mm keys create --data '{"name":"alice","paddockIds":["<paddock-id>"]}'
mm keys revoke <key-id>
```

A new key's secret is in the output of `mm keys create` and nowhere else, ever. Store it then.

## Scopes and roles

A token carries **scopes**, chosen with `--scope` at sign-in. The scopes are the console's own
capabilities:

| Scope | Allows |
|-------|--------|
| `read` | Every `GET` |
| `resource.write` | Every create, replace, delete, status change and key revocation |
| `user.manage` | Nothing in the admin API (users and invites are not exposed) |
| `license.manage` | Nothing in the admin API (the licence is not exposed) |

A request is allowed only when **both** the user's role and the token's scopes allow it:

| Role | May use |
|------|---------|
| `admin` | `read`, `resource.write` (and in the console, `user.manage`, `license.manage`) |
| `member` | `read`, `resource.write` |
| `viewer` | `read` |

**A token never exceeds its user's role.** A viewer who signs in with
`--scope read,resource.write` gets a token that says `resource.write`, and every write it attempts
is still refused. The reverse also holds: an admin who signs in with `--scope read` gets a token
that cannot write. A token with no capability scopes at all can do nothing. It does not fall back
to its user's role. The role is looked up again on every request, so demoting or deactivating a
user takes effect on their tokens at once.

A refusal is a `403` that names the missing capability, so you know what to sign in again with:

```json
{"type":"about:blank","title":"Forbidden","status":403,
 "detail":"forbidden: missing capability 'resource.write'","capability":"resource.write"}
```

## Authentication

Send the access token as `Authorization: Bearer <token>`. That is the only way in:

- No token: `401`, with `WWW-Authenticate: Bearer`.
- The console's session cookie (`mm_session`) is **not** accepted. A request with only the cookie
  is a `401`. A request with a bearer token **and** the cookie is a `400`, before the token is looked
  at. A browser adds the cookie by itself and a script does not, so a request carrying both looks
  like a browser being tricked into making it.
- A token for another audience, from another issuer, expired, with a bad signature, or signed with
  a key the sign-in service no longer publishes: `401`. Every rejected token gets the same answer,
  on purpose.
- The sign-in service's keys cannot be fetched: `503` with `Retry-After: 30`. The token itself was
  not judged.
- The token names a signing key missing from the list the console fetched less than 30 seconds ago:
  also `503` with `Retry-After: 30`. The console may not fetch the list again that soon, and the key
  could be one the sign-in service has only just started publishing. A retry after 30 seconds makes
  the console fetch the list again, and gets `200` or `401`.

## Routes

All paths are relative to `$CONSOLE_URL/api/admin/v1`.

| Method | Path | Scope | Does |
|--------|------|-------|------|
| `GET` | `/flocks` | `read` | List flocks (paginated) |
| `POST` | `/flocks` | `resource.write` | Create a flock. `201`, with `Location` |
| `GET` | `/flocks/{id}` | `read` | Get a flock |
| `PUT` | `/flocks/{id}` | `resource.write` | Replace a flock |
| `DELETE` | `/flocks/{id}` | `resource.write` | Delete a flock. `204` |
| `GET` | `/paddocks` | `read` | List paddocks (paginated) |
| `POST` | `/paddocks` | `resource.write` | Create a paddock. `201`, with `Location`. A taken slug is `409` |
| `GET` | `/paddocks/{id}` | `read` | Get a paddock |
| `PUT` | `/paddocks/{id}` | `resource.write` | Replace a paddock. `status` is ignored here |
| `DELETE` | `/paddocks/{id}` | `resource.write` | Delete a paddock. `204` |
| `PUT` | `/paddocks/{id}/status` | `resource.write` | Enable or disable a paddock (`{"status":"active"}` or `"disabled"`) |
| `GET` | `/paddocks/{id}/fence` | `read` | Get a paddock's fence |
| `PUT` | `/paddocks/{id}/fence` | `resource.write` | Create or replace a paddock's fence |
| `GET` | `/paddocks/{id}/templates` | `read` | List a ComfyUI paddock's workflow templates |
| `POST` | `/paddocks/{id}/templates` | `resource.write` | Add or replace a workflow template. `201` |
| `PUT` | `/paddocks/{id}/templates/{tid}` | `resource.write` | Replace the template the path names |
| `DELETE` | `/paddocks/{id}/templates/{tid}` | `resource.write` | Remove a workflow template. `204` |
| `GET` | `/keys` | `read` | List API keys (paginated). Never includes a key's secret |
| `POST` | `/keys` | `resource.write` | Create an API key. `201`. The only response that ever contains its secret |
| `POST` | `/keys/{id}/revoke` | `resource.write` | Revoke an API key. `204` |
| `DELETE` | `/keys/{id}` | none | Always `405`. See below |
| `GET` | `/usage/matrix` | `read` | Usage pivoted by key and paddock |
| `GET` | `/usage/daily` | `read` | One meter dimension by UTC day |
| `GET` | `/usage/top-keys` | `read` | The org's keys ranked by one dimension |
| `GET` | `/openapi.json` | none | The OpenAPI document. No token needed |

The request and response shapes, and each usage report's query parameters, are in the OpenAPI
document. A resource in another org is a `404`, the same as one that does not exist.

⚠ A flock's `upstreamAuth`, the credential MetaModels sends to your AI server, is returned in
plain text to any token with `read`. Treat flock listings as secrets.

### Why keys are revoked, not deleted

An API key's usage history, which is what you bill from, is stored against the key. Deleting the key
would delete that history with it. So a key is only ever **revoked**: it stops working at once and
its history stays. `DELETE /keys/{id}` answers `405` with an empty `Allow` header and a `detail` that
names `POST /keys/{id}/revoke`. `mm` has no `keys delete` command.

## Errors

Every error is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details, with
`Content-Type: application/problem+json`:

```json
{"type":"about:blank","title":"Unauthorized","status":401,
 "detail":"the admin API requires a bearer access token; it does not accept a console session"}
```

`type` is always `about:blank`. Some errors add a member:

- `403` adds `capability`, the scope the request lacked.
- `422` (validation) adds `errors`, a list of `{ "path", "message" }`.
- `500` has no `detail` at all, so nothing internal can leak through it.

`mm` prints these as one line, `403 Forbidden: …`, followed by the capability or the validation
errors.

## Pagination

`GET /flocks`, `GET /paddocks` and `GET /keys` take `?limit=` (default 50, at most 200) and
`?cursor=`. The body is always a **bare JSON array**. When there may be more, the response carries
an [RFC 8288](https://www.rfc-editor.org/rfc/rfc8288) link to the next page:

```
Link: <…/api/admin/v1/flocks?limit=50&cursor=…>; rel="next"
```

Follow it until a response has no `Link`. Treat the cursor as opaque, copied from the link, never
built by hand. A full page means "there may be more", so a list whose length is an exact multiple of
`limit` ends with one empty page. `mm` prints `More results: repeat with --cursor …` on stderr when
there is a next page. The usage reports are not paginated.

## Rotating the token-signing key

The sign-in service signs every access token with `OIDC_SIGNING_KEY`. The console checks tokens
against the keys the sign-in service publishes, and keeps a copy of that list for **10 minutes**.
Access tokens live for **1 hour**.

To rotate the key without breaking every signed-in CLI at once, follow
[Rotating the sign-in keys](DEPLOY.md#rotating-the-sign-in-keys) in DEPLOY.md. For the admin API,
the window to wait in its step 3 is **70 minutes**: the one-hour access-token lifetime plus the
console's 10-minute key cache. Leave the previous key in `OIDC_PREVIOUS_SIGNING_KEYS` at least that
long after redeploying the sign-in service. After you clear it (step 4), the console may keep
accepting tokens signed with the old key for up to 10 more minutes, until its cached copy expires.

Once the console's copy no longer lists the old key, a token signed with it is answered `401`, like
any other rejected token. `mm` then renews its token with its refresh token, so a CLI that was not
used during the whole window keeps working without a new `mm login`. There is one short gap, the
30-second case under [Authentication](#authentication): if the console fetched the key list less
than 30 seconds earlier, the old-key token gets `503` instead. `mm` does not retry a `503`, so run the
command again after 30 seconds.

**The one exception is a leaked key.** Never use the overlap for it: that would keep publishing the
leaked key for the whole window. Replace it outright, with `OIDC_PREVIOUS_SIGNING_KEYS` empty, as
[Forcing everyone to sign in again](DEPLOY.md#forcing-everyone-to-sign-in-again) describes. Every
token signed with the old key then stops working, which is the point.
