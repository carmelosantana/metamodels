# @metamodels/control-plane

Operator console (Next.js App Router) for MetaModels. Free tier: one admin operator.
Multi-user seats + licensing land in Plan 5.7.

## Setup
1. `cp .env.example .env` and fill in `DATABASE_URL`, `SESSION_SECRET`.
2. Run migrations from the schema package: `pnpm --filter @metamodels/schema exec drizzle-kit migrate`.
3. Seed the first admin: `OPERATOR_EMAIL=... OPERATOR_PASSWORD=... pnpm --filter @metamodels/control-plane seed`.
4. `pnpm --filter @metamodels/control-plane dev` → sign in at `/login`.

## Screens
- **Flocks** (`/flocks`) — connect local AI servers (Ollama/ComfyUI) + Test-connection.
- **Paddocks** (`/paddocks`) — publish a fenced endpoint on a Flock: unique `/p/:slug`, status toggle, plain↔MetaBoy consumer theme.
- **Fence editor** (`/paddocks/[id]/fence`) — breed-aware policy: route classes (`mutate` permanently locked), model allowlist, rate limit, quota, and a Blast-Radius summary.

## Architecture
- Business logic lives in Next-free modules (`src/auth`, `src/server`, `src/lib`) tested with vitest + pglite.
- `authorize(user, action)` is the server-side capability boundary; UI hiding is convenience only.
- Auth: scrypt password hash + HMAC-signed httpOnly session cookie (Node `crypto`, no third-party lib).
- CRUD services follow one template: `requireCapability → Zod → org-scope → mutation + audit in one `db.transaction``. Fence `constraint_json`/`quota` are validated on write (breed-aware); `mutate` is never exposable.
