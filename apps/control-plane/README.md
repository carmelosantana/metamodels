# @metamodels/control-plane

Operator console (Next.js App Router) for MetaModels. Free tier: one admin operator.
Multi-user seats + licensing land in Plan 5.7.

## Setup
1. `cp .env.example .env` and fill in `DATABASE_URL`, `SESSION_SECRET`.
2. Run migrations from the schema package: `pnpm --filter @metamodels/schema exec drizzle-kit migrate`.
3. Seed the first admin: `OPERATOR_EMAIL=... OPERATOR_PASSWORD=... pnpm --filter @metamodels/control-plane seed`.
4. `pnpm --filter @metamodels/control-plane dev` → sign in at `/login`.

## Architecture
- Business logic lives in Next-free modules (`src/auth`, `src/server`, `src/lib`) tested with vitest + pglite.
- `authorize(user, action)` is the server-side capability boundary; UI hiding is convenience only.
- Auth: scrypt password hash + HMAC-signed httpOnly session cookie (Node `crypto`, no third-party lib).
