# Handoff: MetaModels Operator Console — "MetaBoy" (Game Boy / Earth GB)

## Overview
High-fidelity design references for the MetaModels **operator control plane** — a self-hosted proxy that puts a fence (auth, rate limits, guardrails, metered usage) around local AI servers (Ollama chat, ComfyUI image). This bundle covers the app dashboard and the **★ hero screen: the WorkflowTemplate `paramSchema` editor**, where an operator marks which ComfyUI graph inputs become caller-editable parameters.

The visual direction is a **dot-matrix Game Boy ("MetaBoy")**: an earthy DMG handheld shell wrapping a glowing LCD that renders the console in the 4-colour **Earth GB** palette. This is a deliberate, opinionated skin — treat the *device chrome* (shell, D-pad, A/B buttons, scanlines, glow) as brand styling, and the *LCD content* (panels, tables, forms) as the actual product UI to implement.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behaviour, **not production code to copy directly**. The task is to **recreate these designs in the target codebase** (the real product is **Next.js 15 + shadcn/ui + Tailwind**, per the product brief) using its established patterns and libraries. The Game Boy treatment is achieved with plain inline styles here; in the codebase it should become themed components (a `<Device>` shell, an `<Lcd>` surface, `<LcdPanel>`, `<NodeRow>`, `<ParamInspector>`, `<ConsumerForm>` etc.) driven by the design tokens in `design-spec.json`.

The `design-spec.json` file is the **machine-readable source of truth**: palette, typography, component inventory, every screen/state, and — importantly — an `interactions` section listing each button/control, a stable `action` id, and its intended behaviour. **Buttons are intentionally not wired.** The user will finalize behaviour with the developer; the `action` ids give you a contract to implement against.

## Fidelity
**High-fidelity (hifi).** Final colours, typography, spacing, and layout. Recreate the LCD content pixel-faithfully; reproduce the device chrome as themed brand components. Exact values live in `design-spec.json`.

## Domain model (what the screens manipulate)
Field names map 1:1 to the real DB schema (`packages/schema/src/schema.ts`).

| Object | Herding name | Meaning | Key fields |
|---|---|---|---|
| Flock | (upstream) | A connected local AI server | `name`, `breed` (`ollama`\|`comfyui`), `baseUrl`, `upstreamAuth?`, `tlsTrust`, `healthOk` (read-only) |
| Paddock | (published endpoint) | Public `/p/:slug` mapped to one Flock | `name`, `slug`, `flockId`, `status` (`active`\|`disabled`) |
| Fence | (policy) | Rules on a Paddock | `constraintJson`, `rateLimit`, `quota` |
| WorkflowTemplate | (ComfyUI only) | Pre-approved workflow with only certain knobs exposed | `name`, `graphJson`, **`paramSchema`**, `cost` |
| API Key | (consumer key) | Credential to call Paddocks | `name`, `prefix`, full key (shown once), `status`, `expiresAt` |

### paramSchema — the `ParamSpec` union (from `packages/connectors/src/comfyui/template.ts`)
The hero editor produces an array of `ParamSpec`. This is the exact shape the backend validates against in `reconstructGraph()`:
```ts
type ParamSpec =
  | { name: string; type: 'text';   target:  { node: string; input: string } }
  | { name: string; type: 'seed';   targets: { node: string; input: string }[] }
  | { name: string; type: 'number'; target:  { node: string; input: string }; min?: number; max?: number }
  | { name: string; type: 'image';  target:  { node: string; input: string } }
```
Security invariants the UI must preserve:
- Only inputs promoted to a `ParamSpec` are caller-editable. Everything else is **locked** and unreachable.
- `seed` params are **auto-generated server-side** on every run (not a caller value) — the UI shows them as "AUTO", never a text field.
- `image` param values come from a trusted `/upload/image` keyed by param name; the raw request field is ignored — the UI shows an upload slot, not a URL field.
- A caller sending any key not in `paramSchema` is rejected with `unknown param: <key>` (HTTP 400). This is the 7b error state.

## Screens / Views
All screens are the same device shell (see Design Tokens → Device chrome) wrapping an LCD. Widths/heights are the design canvas sizes.

### 1. Dashboard (option 4a — flat Earth GB, superseded skin) and 5a (MetaBoy)
- **5a MetaBoy Dashboard** — 1180×788 device. LCD shows: title strip (`DASHBOARD`, `♥2/3`, clock); 4 stat tiles (Health `2/3`, Paddocks `3`, Req 24h `18204` + sparkline, Errors `0.4%`); a `FLOCKS` panel listing Studio Ollama (healthy), Render Box (healthy, comfyui), Edge Llama (down, pulsing red); a "PRESS START" footer. Status semantics: sage fill = healthy, terracotta = down.
- **4a** is an earlier *flat* (non-device) Earth GB recolor of the dashboard, kept for reference. The MetaBoy direction (5a onward) supersedes it.

### 2. ★ paramSchema editor — loaded (option 6a)
1180×840 device. LCD = two panels under a title strip (`WORKFLOW TEMPLATE`, `sdxl_txt2img.json`, `comfyui`, `◈3 EXPOSED`):
- **Left `GRAPH` panel** — the tamed `graphJson`. One block per node: `#id` + class_type (e.g. `#6 CLIPTextEncode`, `#3 KSampler`). Under each, its inputs, each flagged **`✳ EXPOSED`** (sage dot + glow) or **`🔒 LOCK`** (hollow terracotta square). Selected node has a sage left-bar + `▸ SELECTED` chip. Nodes shown: `#4 CheckpointLoaderSimple` (ckpt_name 🔒), `#6 CLIPTextEncode` (text ✳ → "Prompt", selected), `#7 CLIPTextEncode` (negative, text 🔒), `#5 EmptyLatentImage` (width/height 🔒 CAP 1024), `#3 KSampler` (seed ✳ AUTO, steps ✳ 10-40, cfg/sampler 🔒), `#9 SaveImage` (🔒).
- **Right column** — top: **param inspector** for the selected input (`PARAM · #6.text`, type `text`; editable `name`=Prompt, `required` yes/no toggle, `max len`=400). Bottom: **`CONSUMER FORM` preview** — the live caller-facing contract: Prompt textarea (char counter 62/400), Steps slider (10–40, value 25), Seed row (AUTO / RUN), `▶ RUN · 1cr` + `JSON` buttons.
- **Footer hint bar**: `A:EXPOSE  B:LOCK  ▲▼:NODE  START:SAVE` and `3 of 14 inputs exposed — rest locked`.

### 3. paramSchema editor — empty (option 7a)
720×560 device. Same editor chrome; `◈0 EXPOSED`. Left GRAPH panel holds a dashed **ingest dropzone**: `NO GRAPH LOADED`, `▶ PASTE` / `⇪ UPLOAD`. Right CONSUMER FORM panel is a dimmed placeholder: "Promote inputs from the graph and the caller's form builds here." Footer: `START:PASTE  ⇪:UPLOAD`.

### 4. paramSchema editor — error (option 7b)
720×560 device. The editor dimmed behind a scrim; a **rejection toast** overlays the bottom: `PARAM REJECTED`, `HTTP 400 · fence held the line`, `/p/art-gen`. Shows the caller payload (prompt ✓, steps ✓, `ckpt_name = "juggernaut-xl-v9"` ✕ UNDECLARED) and reason `unknown param: ckpt_name`. Actions: `▶ VIEW IN AUDIT`, `DISMISS`. This is a transient notification, not a full screen.

### 5. paramSchema editor — image param (option 7c)
720×560 device. Editor with `#10 LoadImage` selected (image ✳ IMG → "Init image"), plus `#14 VAEEncode 🔒`, `#3 KSampler` (seed AUTO, denoise/cfg 🔒), `#9 SaveImage 🔒`. Right: image inspector (`name`=Init image, `accept`=png·jpg·webp·≤2048²·8MB, note "value comes from /upload/image, keyed by name — raw field ignored") over a **consumer upload slot** (dashed DROP IMAGE zone + uploaded `collie.png` chip).

## Interactions & Behavior
Buttons are **not wired** — implement against the `action` ids in `design-spec.json → interactions`. Summary of intent:
- **Ingest** (`ingest.paste` / `ingest.upload`) — accept a raw ComfyUI API-format `graphJson`, parse into nodes; nothing exposed until promoted.
- **Node/input selection** (`graph.selectNode`, `graph.selectInput`) — select a node/input; drives the inspector.
- **Expose / Lock** (`param.expose` = A, `param.lock` = B) — promote an input to a `ParamSpec` (choosing type from the input's value type) or remove it. Seed inputs promote as `type:'seed'` (AUTO); image inputs as `type:'image'`.
- **Inspector edits** (`param.setName`, `param.setRequired`, `param.setMax`, `param.setRange`) — edit the selected `ParamSpec`'s friendly name and constraints; changes reflect live in the consumer-form preview.
- **Save** (`template.save` = START) — persist `paramSchema` for the WorkflowTemplate.
- **Consumer preview** (`preview.run`, `preview.viewJson`) — preview-only; `RUN` and `JSON` demonstrate the caller contract, they should not hit production.
- **Error toast** (`error.viewAudit`, `error.dismiss`).

## State Management
- `graph: Record<nodeId, {class_type, inputs}>` — parsed from `graphJson` (empty in 7a).
- `paramSchema: ParamSpec[]` — the promoted params (drives EXPOSED flags + consumer form).
- `selection: {nodeId, input} | null` — drives the inspector.
- `uploads: Record<paramName, filename>` — for image params (preview only).
- Derived: `exposedCount` / `totalInputs` (the `◈N EXPOSED` badge + footer), per-input `locked|exposed` status.
- Error state is a transient toast fed by a rejected consumer request (`{paddock, payload, unknownKey}`).

## Design Tokens
See `design-spec.json → tokens` for the authoritative list. Key values:

**Earth GB palette (source: lospec.com/palette-list/earth-gb):** `#774346` plum · `#b87652` warm-brown · `#acb965` sage · `#f5f29e` cream.

**LCD ink ramp (derived):** ink `#5f3336`, ink-mid `#8a4f3c`, grid-line `#b0a95e`, healthy/green `#7c8b3a`, danger/red `#a8402f`, lcd-light `#e4e58f`.
**LCD surface:** `radial-gradient(120% 130% at 30% 10%, #e4e58f 0%, #cdd07e 46%, #b7bd6d 100%)`.
**LCD glow:** `0 0 0 3px #0d0a0b, 0 0 34px 4px rgba(172,185,101,.55), inset 0 0 40px rgba(95,51,54,.22)`.
**Error LCD surface:** `radial-gradient(120% 130% at 30% 10%, #e9c58f, #d9a56f 48%, #c98a5c)`; error ink `#4a1f1a`, error accent `#8a2f24`.

**Device chrome:** shell `linear-gradient(150deg,#4a363b,#392a2e 42%,#2f2226)`; shell radius `22px 22px 84px 22px` (large device) / `18px 18px 60px 18px` (small); bezel `linear-gradient(160deg,#241a1d,#1b1315)`; recessed controls `#221619`; A/B buttons `radial-gradient(circle at 35% 30%,#b87652,#8a4f3c)`; muted chrome text `#8a6f6a`.

**Typography:** pixel/display = **Press Start 2P** (headers, stat numbers, badges; 7–17px); body/data = **IBM Plex Mono** (10–12.5px); app sans = **IBM Plex Sans**. Uppercase labels use `letter-spacing:.1–.28em`.

**Effects:** scanlines `repeating-linear-gradient(0deg, rgba(60,32,34,.16) 0 1px, transparent 1px 3px)` with `gbflicker` 3.5s; vignette `inset 0 0 46px rgba(95,51,54,.4)`; blinking cursor/hint via `gbblink` 1.1s steps(1); status pulse `mmpulse` 1.6s. Panel borders are hard 2–3px solid ink (no radius inside the LCD — pixel aesthetic).

## Assets
- **Fonts:** Google Fonts — Press Start 2P, IBM Plex Mono, IBM Plex Sans.
- **No raster/SVG art.** All UI is CSS. The `collie.png` upload chip is placeholder text, not a real asset. Status/lock/expose indicators are CSS shapes + glyphs (`✳ 🔒 ♥ ◈ ▶ ⇪ ✓ ✕`).

## Files
- `MetaModels Control Plane.dc.html` — the full design (all options). It's a canvas-mode document: turns are stacked newest-first (`t7`→`t3`), each option has a stable id badge (`5a`, `6a`, `7a`, `7b`, `7c`). Open in a browser to view.
- `design-spec.json` — machine-readable spec: tokens, screens, components, `ParamSpec` shape, and the `interactions` (button → action id → intent) contract.
