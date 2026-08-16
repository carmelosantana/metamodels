# Security posture & supply-chain hardening — status + next steps

A living brief for working through MetaModels security. Grounded in a real audit run on 2026-07-30
against the supply-chain-risk-mitigation playbook (dependency, package-manager, headers, CI/CD,
incident-response). Work through the "Open" items at your pace.

## Already in place (verified 2026-07-30) ✅

- **Package-manager quarantine:** `.npmrc` has `minimumReleaseAge=1440` (24h hold on newly-published
  packages — the single control that would have blocked the recent TanStack/SAP worm versions) and
  `blockExoticSubdeps=true` (no git/tarball transitive deps). Node floor `>=24`.
- **Lockfile discipline:** CI installs with `--frozen-lockfile`; no dependency caching in CI (smaller
  attack surface than cache-restore).
- **CI/CD least-privilege:** `permissions: contents: read` by default; **no `pull_request_target`**;
  **no `id-token`** (nothing publishes in v1); every third-party action pinned to a **full 40-char
  commit SHA** (`actions/checkout@11d5960a…`, `actions/setup-node@49933ea5…`); `zizmor` runs as a
  workflow; `CODEOWNERS` on `/.github/` + lockfile + root config.
- **Framework CVE:** control-plane pinned to `next@16.2.0` (≥16.2 avoids CVE-2025-66478 RCE).
- **Security headers, both planes:** control-plane sends a **nonce-based CSP** (no
  `'unsafe-inline'` for script; `object-src`/`frame-src`/`frame-ancestors` `'none'`;
  `base-uri`/`form-action` `'self'`) plus HSTS, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`. Data-plane
  sends nosniff/HSTS/DENY/`no-referrer` on every response including errors and 404s. Verified
  in a real browser against the running stack: zero CSP violations across login, dashboard,
  paddocks + client-side modal, usage charts, fence editor, and the 404 page. See
  docs/DEPLOY.md § Security headers.
- **No persistence backdoors present:** no `.vscode/tasks.json`, `.vscode/setup.mjs`,
  `.claude/setup.mjs`, or committed `.claude/settings*.json`; no `execution.js`/`router_init.js`
  worm-blob signatures anywhere in the tree.
- **No secrets in git history:** full-history scan found no private keys, no cloud/token prefixes;
  every secret-shaped string is a test fixture or a local smoke throwaway; `.env` never committed.

## Open — prioritized

### P0 — Rotate the GitHub PAT(s) found in `~/.bash_history` — ⏳ OPERATOR ACTION, STILL OPEN
The single highest-value item on this page, and the only one Claude cannot do. Plaintext
GitHub tokens are sitting in shell history on this machine. **Rotate them** (GitHub →
Settings → Developer settings → Personal access tokens → revoke + reissue; `gh auth login`
to re-authenticate) and scrub the matching history lines. Unrelated to this repo's code, but
a live credential exposure that outranks every hardening item below.

### P1 — Make the security linter green, then enforce it (sequencing matters) — ✅ DONE
zizmor's first real run (private repo, 2026-07-30) failed with 10 `--pedantic` findings. None were the
dangerous class; they were hygiene, all now fixed on branch `chore/ci-security-hardening` (verified
locally: "No findings to report"):
- **`artipacked` (low):** `actions/checkout` doesn't set `persist-credentials: false` → the checkout
  leaves a usable git token on the runner. **Fix:** add `persist-credentials: false` to every
  `checkout` step. (Genuine hardening — do this.)
- **`concurrency-limits`:** neither workflow sets a `concurrency:` group → duplicate runs can pile up
  / race. **Fix:** add a `concurrency: { group: ${{ github.workflow }}-${{ github.ref }},
  cancel-in-progress: true }` block to both workflows.
- **`anonymous-definition` (info):** jobs lack a `name:`. Cosmetic; add names to silence.

> **Do NOT enable branch protection requiring the `zizmor` check until it is green** — otherwise every
> merge is blocked. Order: fix findings → confirm green → then require the checks.

**Decision to make:** keep `--pedantic` (strictest — fix all 10, most future friction but highest bar)
vs. run zizmor's default persona (drops the info/cosmetic noise, still catches the real classes).

### P2 — Enable branch protection on `main` — ✅ DONE
`main` requires status checks `test`, `build-smoke`, `zizmor` (strict/up-to-date), a PR before
merging, linear history, and blocks force-pushes. Two deliberate relaxations: **0 required
approvals** and **Code-Owners review off** — on a solo-owned repo both would deadlock every
merge. Turn both on the moment a second maintainer joins. `enforce_admins` is off as an
escape hatch.

### P3 — Complete the security headers (CSP + HSTS) — ✅ DONE
Nonce-based CSP + HSTS on the control-plane, and nosniff/HSTS/DENY/no-referrer on the
data-plane. Details and the operator knobs are in docs/DEPLOY.md § Security headers.

Two things worth knowing about the shape chosen:
- `script-src` uses a **per-request nonce with `'strict-dynamic'`**, not a host allowlist.
  Consequence: every page is rendered per-request, because a prerendered page is baked at
  build time with no nonce and would block its own bootstrap. This was caught by inspecting
  the built `login.html` — it had six un-nonced inline scripts — not by assumption.
- `style-src` still allows `'unsafe-inline'`. Next inlines the `<style>` for next/font and
  critical CSS without nonce-stamping it. A far weaker sink than script (an injected
  `<style>` cannot execute), and `default-src 'self'` still bounds every load, but it is the
  one directive left to tighten if Next later nonces its style tags.

### P4 — Dependency-vetting discipline (ongoing, not a one-off)
Before every `pnpm add` / upgrade: check the publish date (a <48h-old version is the top red flag),
look it up on `socket.dev/npm/package/<name>`, prefer provenance, and **read the lockfile diff** — a
lockfile change without a matching `package.json` change is a classic attack tell. `minimumReleaseAge`
already backstops this, but the human check catches the rest.

## Incident-response quick reference
If a machine/CI run may have executed a malicious install: **treat as compromised — contain + rotate,
don't clean-and-continue.** Disconnect network → rotate everything reachable (AWS, GitHub PATs, npm
tokens, SSH, `.env` secrets) → `gh auth status` + revoke cached tokens → `npm access ls-packages` to
check for unauthorized publishes → scan GitHub for exfil repos (`<word>-<word>-<3 digits>`, desc "A
Mini Shai-Hulud has Appeared"). Worm IOCs: `execution.js` (~11.7 MB) / `router_init.js` (~2.3 MB) in a
package root; install-time calls to `filev2.getsession.org` or `169.254.169.254`.

## The `{Db}` file — RESOLVED (benign, root cause proven)
The untracked 23 MB file named `{Db}` that appeared in the repo root at 2026-07-30 07:04 was a
**screen capture of the desktop**, written by ImageMagick's `import` (screen-grab) tool. Root cause,
proven to the millisecond: a ledger-append command's double-quoted note contained markdown backticks,
so the shell ran command-substitution on them; the fragment `` `import type {Db}` `` executed
`/usr/bin/import` (the TS keyword `import` collided with the ImageMagick binary on `PATH`), which
grabbed the X display and wrote it to the literal filename `{Db}`. No network, no persistence
(cron/unit/hook), no touched dependencies, no secret visible in the image, never committed. **Verdict:
benign tooling mishap, not an indicator of compromise.** The triage evidence
(`~/Projects/metamodels-triage/`) was reviewed and deleted on 2026-08-16; this paragraph is
the surviving record.

### Two real findings the investigation surfaced (worth acting on)
- **Shell-injection-from-untrusted-text primitive.** The mechanism that made `{Db}` is the same one an
  attacker gets if any tool does `echo "…$UNTRUSTED…" >> file` where the text contains `` `…` `` or
  `$(…)`. **Discipline:** write files from untrusted/rich text with a **single-quoted heredoc** or
  `printf '%s'`, never an unquoted/double-quoted `echo`. (Relevant anywhere we interpolate model
  output, issue bodies, PR text, or ledger prose into a shell.)
- **Plaintext GitHub PAT(s) in `~/.bash_history`.** Tracked as **P0** above — still open.

## Maintenance note: pinned image digests
The CI service images (`postgres`/`redis`) are now pinned to `@sha256:` digests (immutable — a mutable
tag can be repointed at a malicious image). Trade-off: a pinned digest does **not** receive base-image
security updates automatically. Re-resolve and bump the digests periodically (e.g. quarterly, or when a
Postgres/Redis CVE lands): `docker buildx imagetools inspect postgres:16-bookworm --format
'{{.Manifest.Digest}}'`.
