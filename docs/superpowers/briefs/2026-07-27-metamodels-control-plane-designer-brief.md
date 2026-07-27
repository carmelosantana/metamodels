# MetaModels — Control Plane Designer Brief

**Date:** 2026-07-27
**For:** UI/UX designer (mockups track)
**From:** Carmelo
**Deliverable:** High-fidelity mockups for the operator admin UI ("control plane")
**Companion doc:** `docs/superpowers/specs/2026-07-25-metamodels-design.md` (full product spec — read for depth)

---

## 1. What MetaModels is (in one breath)

MetaModels is a **self-hosted proxy that puts a fence around local AI servers**. People run powerful AI locally — **Ollama** (chat/LLM) and **ComfyUI** (image generation) — but those servers ship with *no* auth, no rate limiting, no usage accounting. MetaModels sits in front of them and adds: API keys, rate limits, per-provider guardrails, and metered usage you can eventually bill for.

**Positioning line:** *"Cloudflare AI Gateway meets Stripe — self-hosted, and it speaks ComfyUI, not just chat."*

**Who uses this screen set:** a **single technical operator** — the person who runs the AI box and wants to safely hand access to teammates, clients, or an app. They are developer-adjacent, comfortable with the concepts, and want a fast, dense, *trustworthy* admin — not a consumer onboarding funnel. Think Vercel/Railway/Linear dashboard energy, not a marketing site.

> **Design north star:** this is a security & money tool. Every screen should make the operator feel **in control and certain** — clear state, no ambiguity about what's exposed, what's locked, and what it's costing.

---

## 2. Brand & tone

- **Metaphor:** herding / border collie. The product "herds" unruly local AI. The domain nouns below lean into it (Flock, Paddock, Fence). Lean into this *lightly* — a confident wordmark and maybe one dog/herding motif, not a cartoon. It should still read as serious infrastructure.
- **Naming is a placeholder — pressure-test it.** We deliberately want your read on whether the herding nouns (Flock/Paddock/Fence) *help* comprehension or get in the way. If a screen is clearer with a plain-language label + the herding term as secondary, show us.
- **Aesthetic:** clean, dense, keyboard-friendly, **dark-mode-first** (operators live in terminals) but design light too. Built on **shadcn/ui + Tailwind** (Next.js 15) — so please design with that component vocabulary (their default primitives, spacing scale, radius). Staying close to shadcn defaults keeps build cost low; deviate only where it earns its keep.
- **Desktop-first.** This is an admin tool used at a desk. Responsive-down is nice-to-have, not required for v1.

---

## 3. The domain model (what the screens manipulate)

Five core objects the operator manages, plus usage/audit read views. These map 1:1 to real database tables — field names are real.

| Object | Herding name | Plain meaning | Key fields the UI edits |
|---|---|---|---|
| **Flock** | (upstream) | A connected local AI server | `name`, `breed` (`ollama` \| `comfyui`), `baseUrl`, `upstreamAuth` (optional secret), `tlsTrust` (bool), `healthOk` (live status, read-only) |
| **Paddock** | (published endpoint) | A safe, public-facing URL that maps to one Flock under a policy | `name`, `slug` (the public path `/p/:slug`), `flockId`, `status` (`active`\|`disabled`) |
| **Fence** | (policy) | The rules attached to a Paddock | `constraintJson` (breed-specific guardrails — see §5), `rateLimit`, `quota` |
| **WorkflowTemplate** | (ComfyUI only) | A pre-approved image workflow with **only certain knobs exposed** to callers | `name`, `graphJson` (the full ComfyUI graph, operator-supplied), **`paramSchema`** (which slots callers may override — **the hero screen, §6**), `cost` |
| **API Key** | (consumer key) | A credential a consumer uses to call Paddocks | `name`, `prefix` (shown), full key (**shown once at creation**), `status` (`active`\|`revoked`), `expiresAt`, which Paddocks it can reach (`keyPaddock` links) |

**Relationships to make legible in the IA:** a Flock has many Paddocks; a Paddock has one Fence; ComfyUI Flocks own WorkflowTemplates; a Key is granted access to a set of Paddocks. The operator's mental flow is: **connect a Flock → publish a Paddock (with a Fence) → mint a Key scoped to it → watch usage.**

---

## 4. Screens to design

Priority order. **★ = highest value, design first.**

1. **App shell / navigation** — sidebar or top-nav for the 6 sections below, org/operator menu, dark-mode toggle, a global "connection health" indicator.
2. **Dashboard / home** — at-a-glance: Flock health, active Paddocks, top keys by usage this period, recent audit events. The "am I OK?" screen.
3. **Flocks** — list (with live `healthOk` dot: green/red/unknown) + create/edit drawer or page. The `baseUrl` + `upstreamAuth` form, a "Test connection" affordance, and the breed picker (Ollama vs ComfyUI — the choice changes downstream options).
4. **Paddocks** — list + create/edit. Picking a Flock, setting the public `slug` (show the resulting `/p/:slug` URL live), status toggle. This screen **hosts or links to the Fence editor**.
5. **Fence editor** — breed-aware policy editor (see §5 for the two shapes). Rate limit + quota inputs. This is where "what's allowed" is made concrete — make the *blast radius* obvious (e.g. "callers may use 3 models, all mutating endpoints are blocked").
6. **★ WorkflowTemplate `paramSchema` editor** — **the single least-obvious, highest-value screen. See §6.**
7. **API Keys** — list (prefix, status, last-used, expiry) + create flow. **The create flow must handle the "shown once" secret** — a copy-once modal with strong "save this now" affordance. Plus the **scope step**: which Paddocks this key may call.
8. **Usage view** — a plain, honest read of metered usage: per key × per paddock × dimension (`tokens_in`, `tokens_out`, `jobs`, `gpu_ms`, `images`) over time buckets. Tables first, one simple chart. Not a BI tool — clarity over dazzle.
9. **Audit log** — chronological, filterable list of operator actions (`actor`, `action`, `target`, timestamp, expandable detail). Read-only.

For each screen please cover the usual states: **empty, populated, loading, error, and the destructive-confirm** (revoke key, disable paddock, delete flock).

---

## 5. Fence guardrails — the two breed shapes (context for screen 5)

The Fence editor is **breed-aware**; the `constraintJson` differs by the parent Flock's breed:

- **Ollama Fence:** an **allowlist** editor —
  - allowed **route classes** (`read` / `infer` / `mutate`) — note `mutate` (pull/delete/push models) is **hard-blocked by the system regardless**; show it as permanently off with a lock + explanation, so the operator *sees* the protection.
  - allowed **models** (e.g. only `llama3.2:1b`, `phi3`) — a list the operator curates.
- **ComfyUI Fence:** **templates are the product.** Callers can *only* run pre-approved WorkflowTemplates with whitelisted param overrides — they can never submit a raw graph. So the ComfyUI Fence screen is really about **which WorkflowTemplates this Paddock exposes**, and the deep work happens in the paramSchema editor (§6).

Both also carry `rateLimit` (requests/window) and `quota` (hard cap per period, per dimension). Design these as shared sub-components.

---

## 6. ★ The hero screen — WorkflowTemplate `paramSchema` editor

**This is the screen to nail.** It's the product's cleverest idea and has no obvious prior art.

**The problem it solves:** A ComfyUI workflow is a big JSON graph of dozens of nodes (a "graph" = boxes wired together: load model → encode prompt → sample → save image). The operator wants to expose a workflow to callers **but only let them change a few safe things** — e.g. the *prompt text* and the *seed* — while everything else (which model, resolution caps, the node wiring) stays locked. If a caller could change arbitrary nodes, they could load huge models, run forever, or break out of the fence.

**So the operator's job on this screen:** given a workflow graph they've pasted/uploaded, **mark which specific node inputs become caller-editable parameters**, and constrain each one.

**The core interaction to design:**
- Ingest the `graphJson` and present its nodes/inputs in a *legible* way (the raw graph is intimidating JSON — your job is to tame it). A node has an id, a type (e.g. "CLIPTextEncode", "KSampler"), and named inputs (e.g. `text`, `seed`, `steps`, `cfg`).
- Let the operator **pick an input** (e.g. node `6` → input `text`) and **promote it to a caller-facing parameter**: give it a friendly name ("Prompt"), a type (string / number / enum / image), and **constraints** (max length; min/max for numbers; allowed enum values; required vs optional; a default).
- Show the resulting **caller-facing form preview** side-by-side — "this is what your consumer will see and be allowed to send." That preview *is* the contract.
- Make **locked vs exposed** unmistakable at a glance across the whole graph. The operator should be able to scan and be sure nothing is exposed that shouldn't be.

Think: *a form-builder crossed with a permissions matrix, over a node graph.* Two panels (graph/nodes on the left, promoted-params + live consumer-form-preview on the right) is one strong direction — but bring your own. This is where the most design exploration pays off.

---

## 7. Explicitly OUT of scope (do not design)

These are deferred post-v1 — don't spend time here:
- **Stripe / billing / invoicing UI.** Usage is *metered* now (§8 usage view) but *charging* is a later phase. No pricing, checkout, or invoice screens.
- **MCP server generation** UI.
- **Multi-tenant / team management** (multiple orgs, inviting users, roles). v1 is a single operator. Design as if one person is logged in; org-switching UI can be stubbed/omitted.
- Marketing site, landing pages, docs site.

---

## 8. Deliverables & logistics

- **Mockups** for the screens in §4 (all nine; the ★ hero and the key-create "shown once" flow are the two must-nails), in your tool of choice (Figma preferred).
- **A component pass** aligned to shadcn/ui primitives (buttons, inputs, tables, drawers/sheets, dialogs, badges, toasts) so engineering can map 1:1.
- **Dark + light**, desktop-first.
- **Timing:** you have runway — the backend (Plan 4) is being built in parallel and the UI implementation (Plan 5) starts *after* your mockups land. So this is the critical-path input to Plan 5; earlier is better, but depth on the hero screen beats breadth.
- **Questions / naming feedback / "this concept is unclear to me":** route back to Carmelo. Especially flag anything in the domain model (§3) or the Fence/paramSchema concepts that didn't click on first read — if it didn't click for you, it won't for the operator.

---

*Companion technical detail (breed contracts, security posture, the full data model) lives in the design spec at `docs/superpowers/specs/2026-07-25-metamodels-design.md`. You don't need to read it to start, but it's there if you want the why behind any constraint.*
