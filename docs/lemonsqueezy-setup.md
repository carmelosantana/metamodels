# Lemon Squeezy setup — what to configure next

A working checklist for standing up the Lemon Squeezy (LS) side of MetaModels licensing. Work
through it slowly; nothing here touches code unless a step says so. It is grounded in the actual
integration shipped in Plan 5.7b + the Plan 6c revalidation scheduler — not generic advice.

## How MetaModels talks to Lemon Squeezy (the contract you're configuring against)

The control-plane talks to **only the License API** (`apps/control-plane/src/server/ls-client.ts`):

| Call | Endpoint | When |
|------|----------|------|
| `activate(licenseKey, instanceName)` | `POST /v1/licenses/activate` | operator enters a key on the `/settings` Upgrade screen |
| `validate(licenseKey, instanceId)`   | `POST /v1/licenses/validate` | best-effort on login + the scheduler every 12h |
| `deactivate(licenseKey, instanceId)` | `POST /v1/licenses/deactivate` | operator removes a key |

It reads exactly these fields from the LS response: `activated` / `valid`, `license_key.status`,
`instance.id`, and **`meta.variant_name`**. That last one is load-bearing (see step 3).

**Two things this means for setup:**

1. **You do NOT need a store API key for the current integration.** The License API authenticates
   with the license key itself. A store API key is only needed for the broader LS REST API (orders,
   subscriptions, webhooks) — which MetaModels does not call yet. Don't wire one until we add a
   feature that needs it.
2. **`LICENSE_KEY_SECRET` (env) is NOT a Lemon Squeezy credential.** It's the AES-256-GCM key
   MetaModels uses to encrypt the customer's license key at rest in its own DB. Generate a long
   random string for it; it has nothing to do with your LS account.

---

## Step 1 — Create the account + store

- [ ] Sign up at lemonsqueezy.com and create a **store** (name it e.g. "MetaModels").
- [ ] Stay in **Test mode** for now (top toggle). Test-mode license keys work against the same
      `/v1/licenses/*` endpoints, so you can exercise the whole activate→validate→grace→deactivate
      flow before charging anyone real money.

## Step 2 — Create the product + variants (pricing tiers)

- [ ] Create one **Product** ("MetaModels" — subscription is the natural fit; one-time also works).
- [ ] Create one **Variant per seat tier**. The variant **name** is what MetaModels maps to a seat
      count, so name them deliberately. The code ships with:

      | Variant name (must match exactly) | Seats |
      |-----------------------------------|-------|
      | `Team 5`                          | 5     |
      | `Team 10`                         | 10    |
      | (no license / free)               | 1 (`BASE_SEATS`) |

- [ ] **Decide your real tier names now.** If you name a variant "Team Plan — 5 seats" in LS but the
      code expects `Team 5`, seat resolution **silently falls back to 1 seat** (`resolveSeatsForVariant`).
      Two options:
      - keep LS variant names exactly `Team 5` / `Team 10`, **or**
      - pick your own names and edit `TIER_SEATS` in
        `apps/control-plane/src/server/entitlement-service.ts` to match (one-line map — tell me the
        names + seat counts and I'll wire them + add a test).

## Step 3 — Turn on license keys per variant

- [ ] For each paid variant, enable **License keys** in the variant's settings (LS: variant → License
      key generation).
- [ ] Set the **activation limit** = how many separate MetaModels deployments one purchase may run.
      MetaModels creates **one LS "instance" per org** (instance name = a label you pass at activation).
      For a single self-hosted instance per customer, set the activation limit to **1**. Raise it only
      if you intend to let one license power multiple independent deployments.
- [ ] Leave "license length" as you like — MetaModels re-validates every 12h and carries a **7-day
      offline grace** (`GRACE_MS`), so a brief LS outage never locks a paying customer out.

## Step 4 — Do a test purchase and activate it in the app

- [ ] In Test mode, buy your own product (LS provides test card numbers). You'll receive a license key.
- [ ] Run MetaModels (`docker compose up`), log in as the operator, go to **`/settings` → Upgrade**,
      and paste the test license key. This calls `activate` → stores the encrypted key + the returned
      `instance.id` → resolves seats from `meta.variant_name`.
- [ ] Verify: the seat limit on the org jumps to the tier's seat count, and the entitlement shows
      `status: active` with a `graceUntil` ~7 days out.

## Step 5 — Exercise the lifecycle (still Test mode)

- [ ] **Revalidation:** wait for (or trigger) a scheduler pass — it should log
      `revalidation pass: 1/1 ok, 0 failed` and refresh `graceUntil`.
- [ ] **Offline grace:** temporarily point the client at an unreachable base URL (or block network)
      and confirm the entitlement keeps working until `graceUntil`, then downgrades — this is the
      whole reason the scheduler exists.
- [ ] **Deactivate:** remove the key in `/settings` → confirm LS deactivates the instance and the org
      falls back to `BASE_SEATS = 1`.

## Step 6 — Go live (only when ready)

- [ ] Flip the store to **Live mode**, re-create the product/variants there (test and live are
      separate catalogs), and confirm your real variant names still match `TIER_SEATS`.
- [ ] Publish real prices; the same activate/validate flow works unchanged with live keys.

---

## Deferred / not needed yet (so you don't over-build)

- **Webhooks** — MetaModels does not consume LS webhooks today (it polls `validate` + the scheduler
  revalidates). You only need webhooks if we later want instant reaction to a cancellation/refund
  instead of waiting up to 12h + grace. Flag it if you want it; it's a future plan, not a setup step.
- **Store API key / the full LS REST API** — not used by the current integration (see top). Don't
  create or store one until a feature needs it.
- **Multiple instances per license / seat-based metered billing** — out of scope for v1.

## The one gotcha to remember

> Variant name in Lemon Squeezy **must exactly equal** a key in `TIER_SEATS`, or the customer
> silently gets 1 seat. Decide the names once, keep LS and the code in lockstep.
