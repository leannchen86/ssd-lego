# Project Instructions

## Dev Server

Run from project root:

```bash
bun run dev
```

Then open http://localhost:8080

## Architecture

- `index.html` — single page entry point, Tailwind via CDN, 4-column layout
- `js/catalog.js` — loads JSON catalogs, validates required fields, normalizes display labels and structured storage interfaces
- `js/types.js` — shared JSDoc type contracts for catalog/state shapes
- `js/state.js` — plain serializable app state + pure domain derivations (bay building, compatibility, stats, fill strategy)
- `js/app.js` — centralized input queue, ordered action handling, render scheduling, and canvas/DOM projection coordination
- `js/renderer.js` — Canvas 2D rack renderer (chassis + module sections)
- `js/ui.js` — DOM projection for controls/panels/drive hover; event callbacks enqueue actions instead of mutating state directly
- `js/insights.js` — reasoning engine: generates contextual tradeoff analysis
- `data/drives.json` — drive catalog (12 drives: consumer/flagship NVMe, Samsung enterprise U.2, budget SATA, industrial)
- `data/controllers.json` — SSD controller catalog (Phison, Samsung, Silicon Motion)
- `data/servers.json` — server catalog (legacy owned fleet + new Dell/Supermicro)
- `data/modules.json` — PCIe add-in cards (Apex X16 Gen5)
- `data/workloads.json` — workload profiles with requirements + anti-patterns

## Stack

Vanilla JS (ES modules), Canvas 2D, Tailwind CSS (CDN), Bun static dev server. No build step. No framework.

## UI/Data Flow

- Catalog strings such as `"SATA III"` and `"NVMe PCIe 5"` are parsed once in `js/catalog.js` into structured interface facts.
- Input events should store raw facts or enqueue actions; `js/app.js` interprets them in the next scheduled render.
- Hover/drag state is transient UI state and must not trigger full panel recomputation.
- DOM writes are projected from state in `js/ui.js`; Canvas writes are projected from the same state in `js/renderer.js`.

## Adding Data

- **Drive**: add entry to `data/drives.json` — auto-picked up
- **Server**: add to `data/servers.json` — set `owned: true` for existing fleet
- **Workload**: add to `data/workloads.json` — define requirements + anti-patterns
- NVMe PCIe backwards compatibility handled (Gen4 drives work in Gen5 bays)
