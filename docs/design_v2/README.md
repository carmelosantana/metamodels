# Handoff: MetaModels Operator Console — full screen set

## Overview
High-fidelity design references for the **MetaModels operator control plane** — a self-hosted proxy that puts a fence (auth, rate limits, breed-aware guardrails, metered usage) around local AI servers (**Ollama** chat, **ComfyUI** image). This bundle covers the **complete screen set from the brief** plus the ★ hero: the WorkflowTemplate `paramSchema` editor.

## About the Design Files
The files here are **design references created in HTML** — prototypes of look and behaviour, **not production code to copy**. Recreate them in the target codebase (**Next.js 15 + shadcn/ui + Tailwind**) using its patterns and primitives. `design-spec.json` is the **machine-readable source of truth** (tokens, component inventory, per-screen composition, `ParamSpec` contract, and the `interactions` action map). Screenshots are in `screenshots/`. **Buttons are intentionally unwired** — implement against the `interactions[].action` ids; the user will finalize behaviour with you.

## Fidelity
**High-fidelity.** Final colours, type, spacing, layout. Operator-mode screens should be recreated pixel-faithfully with shadcn primitives; the MetaBoy playground is a themed skin.

## ⚠️ Theme architecture — read first
This revision (**v2**) resolves a design review: MetaBoy (the Game Boy skin) is **not** the whole console.

- **Operator mode = the default admin theme.** The entire admin surface (dashboard, all CRUD, usage, audit) is a **legible dark shadcn surface with Earth GB accent hues** — AA contrast, real IBM Plex sizes, full tables. A security + billing tool must be calm and legible.
- **MetaBoy = consumer-facing only.** The Game Boy dot-matrix skin is scoped to the **hosted per-Paddock playground** (screen 11a) — low-density (prompt + slider + Run + result), so the pixel LCD costs nothing and the branding pays off. It is **operator-selectable per Paddock** (plain ↔ MetaBoy). Optionally a dashboard-only vanity flourish, off by default. True multi-tenant theming is out of scope for v1; per-Paddock skin is in.

The MetaBoy dashboard/editor (5a/6a/7a–c) remain in the HTML as **earlier explorations** — reference only; 8a/8b supersede them for the admin.

## Domain model
Field names map 1:1 to `packages/schema/src/schema.ts`.

| Object | Herding name | Meaning | Key fields |
|---|---|---|---|
| Flock | (upstream) | Connected local AI server | `name`, `breed` (`ollama`\|`comfyui`), `baseUrl`, `upstreamAuth?`, `tlsTrust`, `healthOk` (ro) |
| Paddock | (published endpoint) | Public `/p/:slug` → one Flock | `name`, `slug`, `flockId`, `status` |
| Fence | (policy) | Rules on a Paddock | `constraintJson`, `rateLimit`, `quota` |
| WorkflowTemplate | (ComfyUI) | Pre-approved workflow, few knobs exposed | `name`, `graphJson`, **`paramSchema`**, `cost` |
| API Key | (consumer key) | Credential to call Paddocks | `name`, `prefix`, full key (once), `status`, `expiresAt` |

### paramSchema — `ParamSpec` union (from `packages/connectors/src/comfyui/template.ts`)
```ts
type ParamSpec =
  | { name: string; type: 'text';   target:  { node: string; input: string } }
  | { name: string; type: 'seed';   targets: { node: string; input: string }[] }
  | { name: string; type: 'number'; target:  { node: string; input: string }; min?: number; max?: number }
  | { name: string; type: 'image';  target:  { node: string; input: string } }
```
Security invariants (preserve in UI): only promoted inputs are caller-editable; `seed` is auto-generated server-side (show AUTO, never a field); `image` value comes from trusted `/upload/image` keyed by name (show upload slot); unknown caller key → `unknown param: <key>` HTTP 400; `mutate` route class on Ollama is hard-blocked by the system regardless of UI.

## Design tokens
Full list in `design-spec.json → tokens`. Two token sets — **operatorMode** and **metaBoy** — plus the shared **Earth GB** palette (`#774346` plum · `#b87652` warm-brown · `#acb965` sage · `#f5f29e` cream).

**Operator mode:** bg `#141110`, panel `#1a1614`/`#1c1714`, border `#2e2620`, divider `#241d19`, input border `#3a2f28`; text `#ece4d6`, muted `#9a8b7c`, faint `#7d6f62`; primary/healthy sage `#acb965` (text-on-primary `#23260f`), comfyui `#c08457`, danger `#cf5f4b`; radius card 9 / control 7 / chip 5. Type: IBM Plex Sans (UI) + IBM Plex Mono (IDs/URLs/keys/numbers).

**MetaBoy:** LCD surface `radial-gradient(120% 130% at 30% 10%, #e4e58f, #cdd07e 46%, #b7bd6d)`; glow `0 0 0 3px #0d0a0b, 0 0 34px 4px rgba(172,185,101,.55), inset 0 0 40px rgba(95,51,54,.22)`; ink `#5f3336`, green `#7c8b3a`, red `#a8402f`; shell `linear-gradient(150deg,#4a363b,#392a2e,#2f2226)` radius `22px 22px 84px 22px`; scanlines + vignette overlays; Press Start 2P pixel font for headers/badges only.

## Component inventory
Full descriptions with values in `design-spec.json → componentInventory`. Summary:

**Operator mode:** AppSidebar (228px full / 54px rail), PageHeader, StatTile, DataTable (grid-contents rows), StatusPill, BreedChip, Drawer (right sheet + scrim), Modal (centered + scrim), FormField (text/url/select/segmented/switch), Switch, NodeCard (graph node w/ selected glow ring), ParamInspector, ConsumerFormPreview (textarea + slider + Run), RouteClassRow (mutate = locked terracotta), AllowlistChip, BlastRadiusCard, BarChart, AuditRow (expandable), SecretReveal (shown-once, saved-gate).

**MetaBoy:** DeviceShell, Bezel (power LED), Lcd (glow + scanline/vignette overlays), LcdTitleStrip, LcdPanel (hard-ink borders), PixelButton, LcdSlider, UploadSlot, Dpad/ABButtons/Speaker (decorative), RejectionToast.

## Screens (with screenshots)
Each entry lists its screenshot and composing components; full data in `design-spec.json → screens`.

**Operator mode (admin — implement these):**
- **8a Dashboard** — `screenshots/8a-operator-dashboard.png`. Full sidebar, 4 StatTiles, Flocks table, Top keys, Recent activity. Header carries the optional `🎮 MetaBoy` theme pill.
- **8b ★ paramSchema editor** — `screenshots/8b-operator-paramschema-editor.png`. Left: 6 NodeCards with Locked/Exposed chips (selected node glows sage). Right: ParamInspector (#6.text → Prompt, max 400, required) over ConsumerFormPreview.
- **9a Flocks** — `screenshots/9a-flocks.png`. List table + right Drawer "Connect a flock" (breed picker, baseUrl, upstreamAuth, TLS switch, **Test connection** result).
- **9b Paddocks** — `screenshots/9b-paddocks.png`. Paddock cards (status switch, disabled dimmed) + New-paddock panel with **live `/p/:slug` URL preview**.
- **9c Fence editor (Ollama)** — `screenshots/9c-fence-editor.png`. RouteClassRows read/infer (on) + **mutate permanently locked** (terracotta, 🔒), model allowlist chips, rate limit + quota, BlastRadiusCard.
- **9d API Keys + shown-once** — `screenshots/9d-api-keys-shown-once.png`. Keys table (revoked row dimmed) + **SecretReveal modal**: warning, full key + Copy, scope chips, "I've saved it" gate.
- **10a Usage** — `screenshots/10a-usage.png`. Filters + one BarChart + table (key × paddock × tokens_in/out, jobs, gpu_ms, images).
- **10b Audit log** — `screenshots/10b-audit-log.png`. Day-grouped AuditRows, one expanded detail card, action/actor filters.

**MetaBoy (consumer — keep the skin):**
- **11a Consumer playground `/p/art-gen`** — `screenshots/11a-metaboy-playground.png`. DeviceShell + LCD: Prompt textarea, Steps LcdSlider, Seed random, GENERATE PixelButton, result panel (dithered **placeholder** — swap a real render), fence footer, D-pad/A-B/speaker.

**MetaBoy explorations (reference only):** 5a dashboard, 6a editor, 7a empty, 7b error (undeclared param → 400), 7c image param — screenshots included; superseded by operator mode for the admin.

## Interactions & state
See `design-spec.json → interactions` (each button → stable `action` id + intent) and `→ state` (per-screen state shape). Highlights: `template.ingest/expose/lock/edit/save`, `flock.testConnection/create`, `paddock.create/toggleStatus/setTheme`, `fence.save` (mutate stays off), `key.mint/copy/confirmSaved/revoke`, `playground.generate`. Cover empty / loading / error / destructive-confirm on each screen.

## Assets
- Fonts: Google Fonts — IBM Plex Sans, IBM Plex Mono, Press Start 2P (MetaBoy only).
- No raster/SVG art. Charts, status/lock/expose indicators, dithered result tile are all CSS. `collie.png` chips are placeholder text. Swap a real render into 11a's result tile when available.

## Files
- `MetaModels Control Plane.dc.html` — the full design (canvas doc; turns stacked newest-first, stable id badges 5a…11a). Open in a browser.
- `support.js` — runtime for the .dc.html.
- `design-spec.json` — machine-readable spec (v2).
- `screenshots/` — one PNG per screen (filenames above).
