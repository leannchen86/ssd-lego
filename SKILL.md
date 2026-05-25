---
name: ssd-rack-sim-lessons
description: Use when working on SSD Rack Simulator or a similar data-driven interactive canvas app, especially when changing render loops, drag/drop, catalog data models, DOM projection, or visual renderer implementations.
---

# SSD Rack Simulator Lessons

Use this skill as a compact memory of the project decisions that worked, the paths we rejected, and the mistakes to avoid repeating in future interactive data/visualization apps.

## Core Workflow

1. Read the current app shape before editing: `AGENTS.md`, `js/app.js`, `js/state.js`, `js/ui.js`, `js/renderer.js`, and the relevant `data/*.json`.
2. Keep behavior and visuals separate: app state and calculations live outside renderer-specific code.
3. Capture input events as raw facts or actions, then interpret them in one ordered render/update pass.
4. Normalize catalog data at load time, especially strings that are repeatedly parsed downstream.
5. Verify interaction in a browser when changing canvas, drag/drop, layout, or render scheduling.
6. For experiments, keep changes uncommitted until the user explicitly asks to land them.

## Yes: Decisions To Keep

- Use a plain serializable app state object instead of a reactive proxy for transient UI state.
- Centralize action handling and render scheduling in `js/app.js`.
- Treat hover, drag, cursor, and hover-card state as transient UI facts, not as build-changing state.
- Compute expensive or shared derived values once per meaningful build change, then pass them into UI render functions.
- Parse catalog strings early in `js/catalog.js`, such as storage interface generation and display labels.
- Use structured interface facts like `{ kind: 'nvme', generation: 5 }` instead of repeatedly matching strings like `"NVMe PCIe 5"`.
- Keep compatibility logic in `js/state.js` so UI, fill strategy, drop handling, and renderer all share one rule.
- Keep `RackRenderer` behind a stable API: `render(state, stats, now)` and `hitTest(x, y)`.
- Let renderer implementations change internally without forcing app/UI changes.
- Use browser verification for canvas work, including console errors, screenshots, and a real drag/drop path.
- Use pixel or canvas-output probes when possible so “it rendered” is more than a screenshot vibe check.
- Preserve the existing UI shell and panel DOM when changing the center visualization.
- Use a separate worktree for major rewrites, then apply/commit only the cleaned change set to `main`.
- Update project docs when architecture changes, not as an afterthought.

## No: Decisions We Turned Down

- Do not let every `state` mutation emit a global refresh.
- Do not run full stats, fitness, insights, and DOM panel rewrites on bay hover changes.
- Do not mix native drag/drop, mouse drag, and pointer drag as separate competing behavior paths.
- Do not put major interaction logic inside DOM event callbacks.
- Do not use DOM layout reads in the hot drag path unless there is no stable alternative.
- Do not repeatedly regex-parse catalog strings in renderer/UI/stat code.
- Do not denormalize catalog data into multiple mutable sources of truth.
- Do not redesign the whole page when the requested change is architectural or renderer-only.
- Do not commit visual experiments unless the user explicitly asks.
- Do not claim parity or correctness without browser verification.
- Do not leave temporary worktrees, screenshots, patches, or preview servers behind after landing.

## Aesthetic Direction

Yes:

- Keep the app feeling like an operational planning tool, not a marketing page.
- Favor dense, scan-friendly panels with compact labels, small metrics, and restrained affordances.
- Let the rack/canvas carry most of the visual richness; keep controls quiet and predictable.
- Preserve the dark equipment-room atmosphere: near-black background, blue-gray panels, cool cyan accents, subtle green/yellow status colors.
- Make hardware look believable before making it flashy: chassis lips, bays, vents, LEDs, screws, trays, and bus/path constraints should read clearly.
- Use glow sparingly for meaningful signals such as active LEDs, hover/drop target, or selected state.
- Keep card and panel radii small; this UI should feel precise, mechanical, and utilitarian.
- When experimenting with 3D, preserve the same composition and information density before adding spectacle.

No:

- Do not turn the first screen into a landing page or hero composition.
- Do not use decorative gradients, orbs, bokeh, oversized cards, or one-note color themes.
- Do not let 3D drama obscure bay count, drive placement, compatibility, or stats.
- Do not make the palette playful or toy-like; visual delight should come from crisp hardware rendering and responsive interaction.
- Do not replace domain-specific details with generic sci-fi surfaces.
- Do not brighten the whole interface just to show off the renderer; preserve the low-light rack-room mood.
- Do not make the side panels compete visually with the rack.

## Errors We Hit

- **Reactive hover refresh:** `hoveredBay`, `dragDrive`, and related transient fields used to trigger `state:change`, which caused full UI refreshes while dragging. Keep transient visual state away from global refresh triggers.
- **Duplicate drop refresh:** dropping a drive changed several state fields and then emitted/called refresh paths again. Batch the semantic build change and render once.
- **Too many drag paths:** the app had native `dragstart/dragover/drop/dragend` plus `pointerdown/pointermove/pointerup` plus mouse handlers. Prefer one primary pointer path, with native drag only as compatibility glue when needed.
- **Repeated stats computation:** UI refresh called `computeStats` from multiple panel functions. Compute once for the frame/build and pass the result down.
- **Stringly typed interfaces:** compatibility and labels were derived from raw strings in several files. Normalize once and use structured facts downstream.
- **Docs drift:** architecture docs still described the old reactive/event-bus design after the code changed. Update `AGENTS.md` and `README.md` with the code.
- **Tooling mismatch:** `bun` may not exist on every shell path even though the project dev command uses it. If Bun is unavailable, use an equivalent static server for verification and state that clearly.
- **WebGL screenshot probing:** browser evaluate wrappers may not expose full canvas methods. Fall back to screenshots and local image sampling when direct `getContext`/`readPixels` is unavailable.
- **3D framing:** a renderer can be technically nonblank while the rack is cropped or nearly invisible. Verify framing on desktop and narrow viewports, not just “no errors.”

## Verification Checklist

- `git status --short --branch` before and after.
- `node --input-type=module --check < js/app.js` and repeat for changed ES modules.
- `git diff --check`.
- Browser open of `index.html`.
- Console error check.
- Select a representative server.
- Fill all bays.
- Drag one catalog drive onto the rack.
- Screenshot desktop viewport.
- Screenshot or inspect a narrow viewport when renderer/layout changed.
- Confirm no temporary files, worktrees, or servers remain unless the user asked to keep them.

## Renderer Guidance

- Keep renderer state disposable and rebuildable from app state.
- Keep hit testing in the renderer, but return app-level bay indexes.
- Preserve the visual language: dark rack-room background, subdued blue-gray chassis, cyan accents, restrained glow, dense operational UI.
- For Canvas 2D, avoid full redraws unless the frame is actually animating or the rack state changed.
- For Three.js/WebGL experiments, verify nonblank output, framing, and drag/drop hit testing across viewport sizes.
- Avoid adding renderer-specific fields to catalog data unless they are genuine domain facts.

## Data Modeling Guidance

- Catalog JSON remains the source of truth.
- `js/catalog.js` owns boundary validation and normalization.
- `js/types.js` documents shared data shapes with JSDoc; keep it runtime-light.
- `js/state.js` owns domain facts: bays, compatibility, fill strategy, stats, and signatures.
- `js/ui.js` owns DOM projection only.
- `js/app.js` owns ordering: input, state transition, derived data, canvas render, DOM render.
