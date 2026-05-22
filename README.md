# SSD Rack Simulator

A browser-based planning tool for exploring SSD choices in real server chassis. Pick an owned or new server, choose a use case and network path, place compatible consumer SSDs into bays, and see capacity, cost, bandwidth, power, bottlenecks, and workload fit update live.

Live demo: [leannchen86.github.io/ssd-rack-sim](https://leannchen86.github.io/ssd-rack-sim/)

## Quick Start

Run from the project root:

```bash
bun run dev
```

Open [http://localhost:8080](http://localhost:8080).

There is no build step for the app. It uses plain ES modules, Canvas 2D, Tailwind from a CDN, and a tiny Bun static dev server. Refresh the browser after edits.

## What It Models

- Owned Dell fleet reuse vs new Dell/Supermicro purchase options, plus reference what-if M.2 chassis
- SATA and native M.2 NVMe bay compatibility, including PCIe generation fallback
- Workload fit for archive, search/web serving, low-latency app data, and AI scratch use cases
- Network path caps for 25GbE, 100GbE, 200GbE, or local disk-bound modeling
- Cost, power, controller/NAND/vendor concentration, and bottlenecks
- Auto-fill presets for quickly comparing balanced, cheapest, capacity, write-speed, read-speed, endurance, or exact-drive builds

The simulator is meant for planning and comparison, not final procurement or benchmarking. Retail prices are snapshots from the catalog data and may drift quickly.

## Development

Most changes are data or vanilla JavaScript edits:

- App shell: `index.html`
- Catalog loading and normalization: `js/catalog.js`
- Shared JSDoc data contracts: `js/types.js`
- State and calculations: `js/state.js`
- Render scheduling and input ordering: `js/app.js`
- Canvas rack rendering: `js/renderer.js`
- DOM projection for controls and panels: `js/ui.js`
- Tradeoff analysis: `js/insights.js`
- Catalog data: `data/*.json`

If you add or update SSDs, servers, or workloads, edit the matching JSON file and reload the page.

## License

ISC, per `package.json`.
