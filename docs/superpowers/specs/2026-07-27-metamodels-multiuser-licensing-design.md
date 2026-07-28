# MetaModels — Multi-User & Lemon Squeezy Licensing (Control-Plane Feature Design)

**Date:** 2026-07-27
**Status:** Approved design → feeds `writing-plans` for the Plan 5 control-plane milestone set.
**Companion docs:** the product spec `docs/superpowers/specs/2026-07-25-metamodels-design.md`; the control-plane mockups `docs/design_v2/` (operator-mode admin theme + hero paramSchema editor); the roadmap `docs/superpowers/plans/2026-07-25-metamodels-v1.md`.

---

## 1. Context & scope

MetaModels stays **self-hosted** (AGPL). Each operator runs their own instance. This design adds **multi-user (a team of operators on one instance)** as a **paid/donation upgrade**, unlocked with a **Lemon Squeezy license key**. It is "open core": the free tier is a fully-functional single-operator console; the paid tier unlocks additional operator seats.

The existing schema is already **`org` + `user`, everything org-scoped** ("single-operator, org-ready"). This feature makes the `user` dimension real: multiple users per org, differentiated by role. It does **not** introduce multi-tenancy (many isolated orgs on one deployment) — a single self-hosted instance is one org with a team.

### Considered and deferred (recorded so the decision is legible)

During brainstorming we explored a **hosted reselling marketplace** — independent sellers list fenced Paddocks, buyers purchase access, and the platform takes a ~5% cut via **Stripe Connect**. That is a different product (a hosted, multi-tenant, payment-splitting marketplace) and was **deliberately shelved** in favor of the self-hosted open-core model above. If revisited, it would require: true multi-tenancy (isolated orgs, cross-tenant enforcement everywhere), a marketplace/discovery surface, Stripe Connect revenue-share, and a hosted deployment where the platform is the payment chokepoint. The metering already built in Plan 4 (`usage_rollup` by key×paddock×dim) would be its billing basis. **Not in scope here.**

---

## 2. Roles & authorization

Three roles, stored in the existing `user.role` column (currently `text NOT NULL DEFAULT 'admin'`):

| Role | Scope |
|---|---|
| **admin** | Full control: all resource CRUD **+ user management + license/entitlement**. |
| **member** | All resource CRUD (Flocks / Paddocks / Fences / WorkflowTemplates / API Keys). **Cannot** manage users or the license. |
| **viewer** | Read-only: Dashboard, Usage, Audit log. No writes anywhere. |

- Authorization is a single pure helper — `authorize(user, action): boolean` (or throws `ForbiddenError`) — consulted by **every** write path and by read paths that must exclude viewer-forbidden data. Actions are coarse capability strings (e.g. `resource.write`, `user.manage`, `license.manage`, `read`). This helper is built in Plan 5.1 and used by all later CRUD, so role enforcement is uniform and testable in isolation.
- The **audit log** records `actor` = the acting user's identifier (email or id) on every mutating action.
- Roles are a small enum; `viewer` is genuinely useful (a teammate who watches metrics but cannot change config). Keep all three.

---

## 3. Multi-user authentication

The data plane authenticates **consumers** by API key; this is unrelated — it is **operator** login for the control-plane app.

- **Credential:** email + password, verified against `user.passwordHash`. Passwords are hashed with a modern KDF (bcrypt or argon2id) — the exact library is a plan-level choice; the spec requires a slow, salted hash, never plaintext or fast digests.
- **Session:** a signed, httpOnly session cookie identifying the user id + role (a lightweight session — signed cookie / Auth.js credentials provider; chosen at plan time). No third-party IdP in v1.
- **Seeding:** first-run creates the initial **admin** user (from env/setup, e.g. `OPERATOR_EMAIL` + a set-password step). This is the free tier's single seat.
- **Adding users (gated — see §4):** an admin invites a teammate by email + role. This creates an **`invite` row** (email, role, single-use token hash, expiry) — **not** a `user` row yet. The invitee follows the link and sets their own password; **only then is the `user` row created** (with its `passwordHash` populated). This keeps `user.passwordHash` `NOT NULL` with no half-provisioned users. A pending invite reserves a seat (see §4). **No operator password is ever displayed in plaintext, and never stored unhashed.** (If the invite-token flow proves too heavy at plan time, the fallback is an admin-set temporary password shown once at creation — but the invite-row model is preferred and is the default.)
- **User lifecycle:** users can be **deactivated** (not hard-deleted) so audit `actor` references remain valid. Add a `user.status` column (`active` | `deactivated`, default `active`). Deactivated users cannot log in and **do not consume a seat**.

---

## 4. Lemon Squeezy licensing & seats

**Base (no license) = 1 active operator user.** The seeded admin. Fully functional; the free/AGPL tier. Attempting to add/activate a second user without an entitlement is blocked with an upgrade prompt.

**Upgrade flow (admin only, *Settings → Upgrade*):**
1. Admin enters a Lemon Squeezy **license key**.
2. App calls LS **`POST /v1/licenses/activate`** with the key + an `instance_name` (this MetaModels instance) → receives an `instance_id` and the license's status/metadata. Store the `instance_id`.
3. App calls LS **`POST /v1/licenses/validate`** (key + `instance_id`) to confirm `valid` and read the license status.
4. On success, **multi-user unlocks** and a **seat count** is derived from the purchased **tier** (the app maps the LS product/variant → N seats via a small config map; e.g. `Team 5` → 5). Seats are the number of **active** users allowed.

**Enforcement:**
- Invariant: **count(active users) + count(pending invites) ≤ seats**. Base seats = 1; licensed seats = tier value. (A pending invite reserves a seat so two admins can't over-invite; the seat is released if the invite expires or is revoked, and is consumed by the resulting user on acceptance.)
- Sending an invite, or reactivating a user, beyond `seats` is rejected with a clear "seat limit reached — upgrade, revoke a pending invite, or deactivate a user" message. Deactivating a user or revoking/expiring an invite frees a seat.
- If a license is downgraded/expired and active users exceed the new seat count, existing users are **not** forcibly locked out mid-session; new logins beyond seats are blocked and the admin is prompted to deactivate down to the limit (grace, not a trap).

**Resilience & storage:**
- A single **`entitlement`** row (per instance/org) holds: the license key (stored as a hash + last-4 for display, or encrypted at rest — plan-level choice; never plaintext in logs), `instanceId`, `status`, `seats`, `tier`/variant, `lastValidatedAt`, and a computed `graceUntil`.
- The app **re-validates periodically** (e.g. on login and on a schedule) via `/v1/licenses/validate`. A network failure does **not** revoke entitlement immediately: an **offline grace window** (e.g. several days from `lastValidatedAt`) keeps a paying team working through outages. Only a definitive `valid: false` from LS (or grace expiry) downgrades to base.
- **Deactivate:** *Settings* offers LS **`POST /v1/licenses/deactivate`** (releases the instance activation) so an operator can move their license to another instance.
- *Settings → Upgrade* displays: tier, **seats used / free**, license status, last validated, and the activate/deactivate controls.

**Honesty:** this is a **soft** gate — the source is AGPL and patchable. It is a legitimate upsell most operators will respect, not DRM. No obfuscation, no phone-home beyond the LS license calls the operator initiated.

---

## 5. Schema changes (additive Drizzle migration)

- **`user`**: add `status text NOT NULL DEFAULT 'active'` (`active` | `deactivated`). `role` already exists (`admin` | `member` | `viewer`; default `admin`). `passwordHash` stays **`NOT NULL`** — the invite-then-accept flow (§3) never creates a user without a password.
- **`entitlement`** (new): `id`, `orgId` (FK → org, unique — one entitlement per org), `licenseKeyRef` (hash/last-4 or encrypted), `instanceId text`, `status text`, `seats integer NOT NULL DEFAULT 1`, `tier text`, `lastValidatedAt timestamptz`, `graceUntil timestamptz`, `createdAt`. Absence of a row (or `status != active`) ⇒ base tier (1 seat).
- **`invite`** (new): `id`, `orgId`, `email`, `role`, `tokenHash`, `expiresAt`, `acceptedAt`. Drives the invite-then-accept flow; a pending (un-accepted, un-expired) invite reserves a seat.
- All additive; `0000`/`0001` untouched; new numbered migration.

---

## 6. New screens (operator-mode, extrapolated)

Two screens are **not** in `docs/design_v2/` and will be **extrapolated in operator mode** from the existing design tokens + component vocabulary (AppSidebar, DataTable, Drawer, Modal, FormField, StatusPill, SecretReveal), then reviewed:

- **Team / Users** (admin-only) — a DataTable of users (name/email, role, status, last login) + an "Invite user" Drawer (email, role) + row actions (change role, deactivate/reactivate). A header stat shows **seats used / free**. Reuses the `SecretReveal`-style one-time pattern if a temp password is shown.
- **Settings → Upgrade / License** (admin-only) — license-key entry, current tier + seats used/free, status + last-validated, activate/deactivate. Mirrors the calm operator-mode form style; an un-activated state shows the value proposition + a link to the Lemon Squeezy storefront.

Role also lightly affects existing screens: **viewer** hides write controls (New/Edit/Delete/Mint) and the Team/Upgrade nav; **member** hides Team/Upgrade. This is presentation on top of the server-side `authorize` gate (the gate is the real boundary; UI hiding is convenience).

---

## 7. Where this lands in the Plan 5 decomposition

The control-plane milestone (**Plan 5**) decomposes into sub-plans; each delivers a working, demoable slice, expanded just-in-time via `writing-plans` then built via `subagent-driven-development` (opus coder + reviewer), whole-branch review, ff-merge, carry-forward — the established v1 workflow.

| # | Sub-plan | Delivers | Screens |
|---|---|---|---|
| **5.1** | **Foundation + auth + Flocks** | Next.js 15 app (`apps/control-plane`), operator-mode theme + app shell, **multi-user-capable auth** (multiple users, sessions, email+password), the **role model + `authorize()` helper** used by all CRUD, the reusable CRUD/Zod/audit/org-scope server pattern, and Flocks CRUD end-to-end (Test-connection). | shell, 9a |
| **5.2** | **Paddocks + Fences** | Publish a fenced Paddock (live `/p/:slug`, status toggle, breed-aware Fence, mutate-locked, allowlist, rate/quota, Blast Radius). Fence `constraint_json`+`quota` **validation on write**; key↔paddock **org-consistency** groundwork; adds `paddock.theme` (plain↔MetaBoy) for the consumer track. | 9b, 9c |
| **5.3** | **★ paramSchema editor** | Wrap a ComfyUI workflow as a constrained template; output matches `reconstructGraph` exactly. | 8b |
| **5.4** | **API Keys + shown-once** | Mint paddock-scoped keys (shown-once), revoke, expiry; org-consistency enforcement. | 9d |
| **5.5** | **Dashboard + Usage + Audit** | Health, usage (query `usage_rollup`), audit history. | 8a, 10a, 10b |
| **5.6** | **CachingConfigStore + Redis pub/sub** | Config edits propagate promptly to the live data-plane (Plan 4 carry-forward). | — |
| **5.7** | **Team & License** (this feature's paid surface) | Users/Team management + role-based invite/deactivate + **seats**, the **Lemon Squeezy** activate/validate/deactivate flow, the `entitlement` table + revalidation + **offline grace**, and *Settings → Upgrade*. | Team, Upgrade (extrapolated) |

- **5.1 builds the mechanism** (multi-user auth + roles + `authorize()`), so every later CRUD is role-enforced from day one — but out of the box only the seeded admin exists; **adding users is gated** until 5.7 lands the seat/license enforcement and management UI.
- **5.7 lands last** because the free single-operator tier is fully usable without it; it is the monetized upgrade layered on a working console.
- **Order:** 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7. Then **Plan 6** (docker-compose packaging + real-Redis integration + CI hardening).
- **Consumer track** (the MetaBoy per-Paddock playground, screen 11a) is a **separate later plan**, not part of Plan 5; it consumes `paddock.theme` (added in 5.2) and lives data-plane-side.

---

## 8. Security & testing notes

- **Passwords:** slow salted KDF (bcrypt/argon2id); never logged or returned. Login is rate-limited (reuse the data-plane's limiter concept or a simple per-IP throttle).
- **Sessions:** signed httpOnly, secure, sameSite cookies; server-side role checks on every request — never trust a client-asserted role.
- **`authorize()` is the boundary:** UI hiding is convenience; the server gate is authoritative and unit-tested per role × action.
- **License handling:** the license key is never stored in plaintext logs; LS API calls fail **open to the last-validated state within grace**, and only a definitive `valid:false` or grace expiry downgrades. Seat enforcement is server-side.
- **Supply chain:** new deps (Next.js, shadcn, a session lib, the KDF, an LS client or plain `fetch`) go through the `supply-chain-risk-mitigation` skill; Next.js pinned `@latest` (≥16.2, avoids CVE-2025-66478) with security headers; new deps pinned and vetted against the `.npmrc` quarantine.
- **Tests stay Docker-free:** control-plane logic tested against pglite; the Lemon Squeezy client is behind an interface with an injected `fetchImpl` (like the data-plane's fake upstreams) so activate/validate/deactivate + grace + seat enforcement are tested with a fake LS, no network.
- **Audit coverage:** user create/deactivate/role-change and license activate/deactivate are audited actions.
