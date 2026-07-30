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
- **Some security headers:** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`.
- **No persistence backdoors present:** no `.vscode/tasks.json`, `.vscode/setup.mjs`,
  `.claude/setup.mjs`, or committed `.claude/settings*.json`; no `execution.js`/`router_init.js`
  worm-blob signatures anywhere in the tree.
- **No secrets in git history:** full-history scan found no private keys, no cloud/token prefixes;
  every secret-shaped string is a test fixture or a local smoke throwaway; `.env` never committed.

## Open — prioritized

### P1 — Make the security linter green, then enforce it (sequencing matters) — ✅ FIXED in this change
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

### P2 — Enable branch protection on `main` (the standing "operator MUST" item)
Once the checks are green, require on `main`: status checks `test`, `build-smoke`, `zizmor` +
"require a PR before merging" + "require review from Code Owners" (CODEOWNERS already covers
`/.github/`). Until this is on, the supply-chain posture is authored but **unenforced** — anyone with
push access can bypass it.

### P3 — Complete the security headers (CSP + HSTS)
Currently missing **Content-Security-Policy** and **Strict-Transport-Security**. Add a `default-src
'self'` CSP with an explicit `script-src` allowlist and HSTS. Caveat: CSP `script-src` is an
allowlist — any future third-party script (analytics, widget) must be added or CSP will (correctly)
block it. Worth doing before any public exposure.

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
benign tooling mishap, not an indicator of compromise.** Evidence + full write-up:
`~/Projects/metamodels-triage/` (`INVESTIGATION.md`, `FORENSICS.md`, rendered PNG). The evidence can be
deleted once reviewed.

### Two real findings the investigation surfaced (worth acting on)
- **Shell-injection-from-untrusted-text primitive.** The mechanism that made `{Db}` is the same one an
  attacker gets if any tool does `echo "…$UNTRUSTED…" >> file` where the text contains `` `…` `` or
  `$(…)`. **Discipline:** write files from untrusted/rich text with a **single-quoted heredoc** or
  `printf '%s'`, never an unquoted/double-quoted `echo`. (Relevant anywhere we interpolate model
  output, issue bodies, PR text, or ledger prose into a shell.)
- **Plaintext GitHub PAT(s) in `~/.bash_history`.** Unrelated to this repo but a live exposure.
  **Recommend rotating** those tokens (`gh auth token` / GitHub → Settings → Developer settings →
  revoke + reissue) and scrubbing the history lines. This is an operator action — not done
  automatically.

## Maintenance note: pinned image digests
The CI service images (`postgres`/`redis`) are now pinned to `@sha256:` digests (immutable — a mutable
tag can be repointed at a malicious image). Trade-off: a pinned digest does **not** receive base-image
security updates automatically. Re-resolve and bump the digests periodically (e.g. quarterly, or when a
Postgres/Redis CVE lands): `docker buildx imagetools inspect postgres:16-bookworm --format
'{{.Manifest.Digest}}'`.
