# Moment · live window

**Moment opens on a live watercolour window onto the visitor's own neighbourhood, painted from real map data, real elevation and land cover read from satellite imagery, at the real time of day and in the real weather.**

The view is angled, like looking out of a high window, and the scene moves: boats cross the water on real ferry routes, cars and people move along real streets, birds circle, lights come on at dusk. The visitor can freeze the moment into a postcard and send it.

Built from `Moment-Live-Window-PRD.pdf` (2026-11-12). The painter is a port of the prototype ("Moment Terrain Tests"), now fed from real data instead of synthetic layouts.

- **Live:** https://momentwindow.flockfield-server.workers.dev
- **Scene builder:** https://momentwindow-builder.vercel.app/api/scene (POST, secret required)
- **Repo:** https://github.com/brandon-lai/momentwindow

---

## How it works

```
browser ── page, pencil drawing, washes, life, ripples, postcards (Vite + TypeScript, painting in a Web Worker)
   │  /scene/:cell  /weather/:cell  /locate  /search  /postcard  /p/:id
edge (Cloudflare Worker) ── request.cf → H3 cell (raw point dropped) · KV scene cache · Open-Meteo · Photon search · postcards in KV
   │  on a cache miss only
scene builder (Vercel Node function, pdx1) ── one bundle per H3 resolution-8 cell, streamed as NDJSON: streets and footprints first, then the full bundle
   │
open data, read in place: OpenFreeMap vector tiles (OSM) · Terrain Tiles on AWS · ESA WorldCover · Sentinel-2 L2A (Earth Search) · Meta/WRI canopy height · Photon
```

| Module | What it does |
| --- | --- |
| `edge/src/index.ts` | locate and snap, `/scene/:cell`, `/weather/:cell`, `/locate`, `/search`, `/postcard`, `/p/:id` (+ `.jpg`), `/t` timing beacon |
| `builder/src/sources/ofm.ts` | OSM vector tiles, clipped per tile so tile buffers never duplicate features |
| `builder/src/sources/terrain.ts` | Terrarium elevation |
| `builder/src/sources/rasters.ts` | WorldCover classes, Sentinel-2 true colour and scene classes (cloud-masked, up to three scenes composited), canopy peaks |
| `builder/src/snap.ts` | the public feature, the heading |
| `builder/src/surface.ts` | classify (OSM, then WorldCover where OSM is blank), colour (per-region Sentinel-2 medians), fields split by real colour, snow and bare earth, trees from canopy peaks |
| `builder/src/build.ts` | buildings, roads, rail, ferries, aerialways, spawn zones, ridges past the far edge, bake |
| `client/src/paint/*` | the prototype's painter: ground painting, 3D terrain pass (WebGL), buildings and trees, sky and real ridges, pencil drawing |
| `client/src/live/*` | life from the map, ripple simulation, horns |
| `client/src/main.ts` | the window: pencil, staged washes, live loop, taps, real time, postcards |

## Running it

```bash
npm ci
BUILDER_SECRET=dev-secret node --experimental-strip-types scripts/builder-server.ts   # builder on :8790
npm run build:client
npx wrangler dev --config edge/wrangler.jsonc --port 8787 --var BUILDER_URL:http://127.0.0.1:8790/
open "http://127.0.0.1:8787/?place=battery"
```

Overrides for testing: `?place=<test place id>`, `?cell=<h3 res 8>`, `?at=<ISO time>` (time of day), `?weather=rain|drizzle|snow|fog|clear`, `?date=YYYY-MM-DD` (imagery season). `node --experimental-strip-types scripts/build-place.ts battery` builds one bundle and prints what went into it. `scripts/regress.ts` paints the ten test places at noon, golden hour and an hour after sunset and screenshots each.

## Deploying

- **Builder:** Vercel project `momentwindow-builder`, git-connected: a push to `main` builds it (`scripts/bundle-builder.mjs` bundles it with esbuild into a Build Output API function). Needs `BUILDER_SECRET`.
- **Edge:** `npm run build:client && npx wrangler deploy --config edge/wrangler.jsonc`, from a `git archive` of the pushed commit (as with Flock and Moment). Needs the `BUILDER_SECRET` worker secret.
