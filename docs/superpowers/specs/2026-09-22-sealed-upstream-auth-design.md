# Sealed upstream credentials: `flock.upstream_auth` encrypted at rest and write-only

**Status:** implemented on `feat/encrypt-upstream-auth`, stacked on M2 (`claude/m2-admin-api`).
**Date:** 2026-09-22.
**Relates to:** [`2026-09-22-m2-admin-api-design.md`](2026-09-22-m2-admin-api-design.md). M2's
`docs/api/openapi.json` documented this leak as a known issue tracked as its own milestone. This is
that milestone.

---

## 1. Why

`flock.upstream_auth` is the credential the stack sends to an upstream Ollama or ComfyUI server. It
was stored in plaintext, and every flock read returned it. `listFlocks` and `getFlock` were
`db.select().from(flock)`. Before M2, only a 12-hour console session could reach those reads. M2
serves them at `GET /api/admin/v1/flocks[/{id}]` to OAuth access tokens. So a long-lived CLI token
holding only `read`, the least-privileged capability, could list every upstream credential in the
org over the network, and then keep them in a `0600` file on an operator's laptop.

Three changes are needed, and each depends on the one before:

1. **Encrypt the column at rest**, so a database dump or backup is not a credential dump.
2. **Stop returning the credential from any read.** It becomes write-only.
3. **Make an omitted field on PUT mean "do not touch it".** M2's full-replace semantics were safe
   only because a GET returned the value, so a GET → edit → PUT round trip could send it back.
   Once reads stop returning it, that same round trip would silently clear it.

## 2. Decisions

| # | Crux | Decision |
|---|---|---|
| S1 | Key source | A **dedicated `UPSTREAM_AUTH_KEY`**, held only by `migrate`, `control-plane` and `data-plane`. It does not reuse `LICENSE_KEY_SECRET`. |
| S2 | Rotation | `UPSTREAM_AUTH_PREVIOUS_KEYS`, modelled on `OIDC_PREVIOUS_SIGNING_KEYS`. Every envelope names its key. |
| S3 | Where values get re-encrypted | In **`migrate`**, after the SQL runs and before any other service starts, since all of them wait on `service_completed_successfully`. |
| S4 | Column | Renamed `upstream_auth` → **`upstream_auth_enc`**, plus a `CHECK` that every value is sealed, added `NOT VALID` and validated once the sweep has run. |
| S5 | Response shape | An **allowlist projection** in the service, `flockView`, with `hasUpstreamAuth: boolean` in place of the credential. |
| S6 | PUT | `upstreamAuth` is **tri-state**. Omitted leaves it untouched, `null` clears it, and a string replaces it. |
| S7 | Unreadable credential | **Fail closed, per flock.** The data plane returns 503 after its key and scope gates. `migrate` warns and names the flock but never fails the run. |
| S8 | Writers | An update that omits the credential may not change `baseUrl` or turn `tlsTrust` on while a credential is stored. The admin API answers **409**. |

### 2.1 Why not reuse `license-crypto.ts` (S1, S2)

It is the same cipher, AES-256-GCM, and the envelope format follows its shape. But it had four
properties this use cannot accept:

- **The key.** Reusing `LICENSE_KEY_SECRET` would hand the licence secret to the data plane, so one
  leak would expose both. A dedicated key keeps the blast radius to the three services that
  actually seal or open credentials.
- **No key id.** Without one, a value sealed under a key the stack does not hold looks identical
  to a tampered value. Restoring a backup under another key must be recognisable as exactly that,
  and rotation must be an overlap window rather than a flag day. `kid` is a hash of the derived
  key, so the operator never has to name a key.
- **Key derivation.** `license-crypto.ts` derives with a bare SHA-256. This uses HKDF with a
  purpose label, so the same bytes reused for another purpose would not produce the same AES key.
- **Key format.** It accepts any string of 16 or more characters. This takes base64 of exactly 32
  bytes. A key is generated, not chosen, and malformed input fails at boot with the variable
  named, never the value.

The GCM additional authenticated data is the row the value belongs to: `flock:<orgId>:<flockId>`,
both UUIDs, so no pair of ids can spell another pair's. An envelope copied onto another flock, or
into another org, then fails authentication instead of being sent to that flock's upstream. Anyone
with database write access can already change `base_url`, so the binding matters most across
tenants. So that the id exists before the INSERT, `saveFlock` mints it with `randomUUID()` on create
rather than leaving it to the column default. Re-labelling the kid needs no binding of its own,
because a different kid means a different key.

### 2.2 Why the re-encryption runs in `migrate` (S3, S4)

SQL cannot encrypt, because the key is not in the database, so migration 0008 only renames the
column and adds the check `NOT VALID`. That lets pre-upgrade plaintext survive the migration while
refusing every new unsealed write. `resealUpstreamAuth` then, in one transaction:

- seals the surviving plaintext rows;
- re-seals any row under a previous key with the current one;
- reports, and leaves untouched, any row no held key can open;
- runs `VALIDATE CONSTRAINT`.

If the pass sealed any plaintext, a `VACUUM FULL "flock"` follows, so the old row versions do not
stay in the table's data files. The WAL and earlier backups are out of its reach, and `DEPLOY.md`
says so.

The same pass is the one-time upgrade and the second half of every rotation. `migrate` loads the
key before it touches the database, so a missing key stops the deploy before a half-applied
upgrade.

Renaming the column, rather than changing what it holds in place, made every old reader of the
plaintext field stop compiling. The type checker found them all: the data-plane config store and
`flock-health.ts`.

### 2.3 Why the projection lives in the service (S5)

`requireCapability` and org scoping already live in the service. A filter in each route would be
one forgotten route away from leaking the credential again. `flockView` is an allowlist, not "all
columns minus one", so any column added later stays out of responses until someone adds it
deliberately. The OpenAPI conformance test compares the documented `Flock` against `flockView`.

`getFlockConnection` is the only place the control plane opens a credential, and only to call the
flock itself when listing its models. It needs `read`, because the flock's answer is what leaves
the server, and the credential only goes to the flock's own base URL.

### 2.4 Why an omitted field keeps the credential (S6)

This copies M2's `paddock.status` precedent in `savePaddock`. The zod field stays `.nullish()` and
is never defaulted. `saveFlock` leaves an omitted credential out of `values` with a conditional
spread, so the UPDATE never names the column. That keeps the fix inside the service's transaction,
where a read-modify-write would race. The console's form omits a blank field instead of sending
`null`.

Omit-keeps has one consequence that write-only has to guard against (S8). If a kept credential
followed a changed `baseUrl`, a `resource.write` token could point the flock at its own server and
have the next model listing or paddock request deliver the credential there. So `saveFlock`
compares the new `baseUrl` and `tlsTrust` against the stored row, inside the same transaction and
`FOR UPDATE`. If either change would carry a stored credential somewhere new, it refuses the write
with `CredentialRebindError`, unless the request re-sends `upstreamAuth` or `null`.

### 2.5 Why an unreadable credential fails closed (S7)

Forwarding without the credential would turn a key problem into an upstream 401, which points the
operator at the wrong system. The data plane's 503 comes after the API-key and scope checks, so
only a caller entitled to that paddock learns that its credential is broken.

`migrate` does not fail on an unreadable row. One flock restored from a backup under another key
should cost that one flock, not stop the whole stack from starting. It also keeps the unreadable
value rather than nulling it, so putting the right key back recovers it. `docs/DEPLOY.md` covers
rotation, restore and leak response.

## 3. Reconciliation with the scoping spec (5fc652e, Kanboard #4512–#4519)

A separate scoping session wrote its own spec for this milestone. It was never pushed, and it lives
at `claude/flock-upstream-auth-spec`, commit `5fc652e`, in
`docs/superpowers/specs/2026-09-23-flock-upstream-auth-at-rest.md`. Its decisions are D1–D8. This
table records, for each place the two specs differ, what this PR does and why, so those decisions
are not lost.

| Decision | That spec (5fc652e) | This PR | Kept or changed, and why |
|---|---|---|---|
| D1 key env | `FLOCK_AUTH_KEY` / `FLOCK_AUTH_PREVIOUS_KEYS` | `UPSTREAM_AUTH_KEY` / `UPSTREAM_AUTH_PREVIOUS_KEYS` | **Kept.** Already wired through three compose files, `new-stack.sh`, CI and `DEPLOY.md`, and it names what the key protects. |
| D1 envelope | `v1.<kid>.<iv>.<ct>.<tag>` in the same column | `sealed:v1:<kid>:<iv>:<ct>:<tag>` in the renamed `upstream_auth_enc` | **Kept.** Both are unambiguous. The `sealed:v1:` prefix is what the database CHECK tests. |
| D1 AAD | `flock:<orgId>:<flockId>` | Was `sealed:v1:<kid>`; now `flock:<orgId>:<flockId>` | **Changed to that spec.** It stops an envelope being moved to another flock or tenant. It was cheap, because no release shipped the earlier format. |
| D1 flock id on create | Minted by the service with `randomUUID()` | Minted by the service with `randomUUID()` | **Changed to that spec**, because the AAD needs the id before the INSERT. |
| D1 key derivation | Raw key, no HKDF; kid = hash of the raw key | HKDF with a purpose label; kid = hash of the derived key | **Kept.** Domain separation costs nothing. That spec's objection was to deriving from *another* secret, which this does not do. |
| D3 shared module | One seal/open module in `@metamodels/connectors` | `@metamodels/schema/sealed` (and `/reseal`) | **Kept.** migrate, control-plane and data-plane already depend on `@metamodels/schema`; migrate does not depend on connectors. |
| D3 where the control plane opens it | Only in `flock-health.ts`, at the call to the flock | Only in `getFlockConnection` (`flocks-service.ts`), whose one caller is `flock-health.ts` | **Kept.** Same boundary, but org-scoped next to the other flock reads, and it reports an unreadable credential instead of throwing. |
| D2 rotation | Batched, resumable `rewrap` command with SKIP LOCKED; retire a key once its count reaches 0 | `migrate` re-encrypts every row in one transaction on each deploy | **Kept, and departs from that spec's stated goal (Destination 4) of not re-encrypting every row at once.** `flock` is tiny and nothing else is running while `migrate` holds the lock, so rotation finishes on the deploy that introduces the key, with nothing extra to run. |
| D3 who holds the key | control-plane and data-plane only; never `migrate` | `migrate`, control-plane and data-plane | **Kept.** `migrate` has to encrypt legacy rows before the CHECK can be validated and before any service reads the column. |
| D3 boot validation | Both apps refuse to start | All three exit with status 1 on a missing or invalid key | **Kept.** The console's `register()` now exits instead of rejecting, which Next swallowed. |
| D4 read shape | `hasUpstreamAuth` through a service view | Allowlist `flockView` plus `hasUpstreamAuth` | **Kept.** Same outcome. An allowlist is stricter than a view that drops one column. |
| D4 console | Password input, "credential set" marker, per-row Replace, Remove and server-side Test | Password input, "Stored" marker, create-only | **Follow-up** before the first release tag (§4). Until then, changing a credential in the console means deleting the flock, which deletes its paddocks. |
| D5 PUT | Tri-state: omitted keeps, `null` clears, a string replaces | The same tri-state, plus a **409** when an omitted credential would follow a changed `baseUrl` or a newly enabled `tlsTrust` | **Kept.** That spec leaves open the case where a writer re-points a flock and receives its kept credential. |
| D5 audit | `set` / `cleared` / `unchanged` | `set` / `cleared`; no key when unchanged | **Kept.** An absent key already means unchanged. |
| D6 migration | No DDL. Background boot pass in the control plane. Plaintext stays readable for one release | Column rename, NOT VALID CHECK, re-encryption in `migrate`. Plaintext is never read after the upgrade | **Kept.** No window where plaintext is read, and the database refuses new unsealed writes. |
| D6 rollback | `rewrap --to-plaintext` required before a downgrade | Downgrade only by restoring a database backup, as documented | **Kept.** A tool that decrypts everything is a footgun, and nothing has been released that anyone would downgrade to. |
| D7 `info.version` | 2.0.0 if M2 is in a release tag, otherwise 1.0.0 | 1.0.0 | **Same outcome.** The latest tag, v0.4.1, predates M2. |
| D8 auth contract | Store the bare token. One helper sends `Bearer` on every path. Reject a scheme prefix, whitespace and CR/LF. The migration strips a legacy `Bearer ` | Done in PR #21, stacked on this PR, with one ruling that departs from that spec: **the legacy `Bearer ` prefix is dropped at send time by `upstreamAuthHeaders()`, not in reseal.** Reseal encrypts legacy values unchanged | **Changed.** New writes are validated as bare tokens, so no new prefixed value can arrive, and normalising a second time inside reseal would duplicate the helper. This section, not 5fc652e, is the source of truth; 5fc652e stays unedited as the historical record. |
| Proof | A real-Postgres test that resumes after a crash, plus an e2e on an isolated compose stack | PGlite unit tests, manual runs on Postgres 16, and `scripts/smoke.sh` | **Follow-up** before the first release tag (§4). |

## 4. Not in this milestone

- **Changing the credentials at the upstream servers.** Credentials in pre-upgrade backups, or in
  listings already fetched, stay exposed. `DEPLOY.md` tells operators to reissue them if needed.
- **Follow-ups due before the first release tag:**
  - Console Replace, Remove and Test controls for a stored credential (scoping spec D4). Until
    then, recovering a single credential goes through `PUT /api/admin/v1/flocks/{id}`.
  - A real-Postgres test that resumes the reseal after a crash, and an e2e on an isolated compose
    stack (scoping spec proof).
  - The D8 auth contract: PR #21.
