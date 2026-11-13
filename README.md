# Moment · live window

**Moment opens on a live watercolour window onto the visitor's own neighbourhood, painted from real map data, real elevation and land cover read from satellite imagery, at the real time of day and in the real weather.**

The view is angled, like looking out of a high window, and the scene moves: ferries run their real routes, cars and people move along real streets, birds circle, lamps come on at dusk. The visitor can freeze the moment into a postcard and send it.

Built from `Moment-Live-Window-PRD.pdf` (2026-11-12). The painter is a port of the prototype ("Moment Terrain Tests"), now fed from real data instead of synthetic layouts.

- **Live:** https://momentwindow.flockfield-server.workers.dev (try `?place=battery`, `?place=asakusa`, `?place=grindelwald`)
- **Scene builder:** https://momentwindow-builder.vercel.app/api/scene (POST, shared secret, answers 401 without it)
- **Repo:** https://github.com/brandon-lai/momentwindow

---

## What is working

| | Status |
| --- | --- |
| Locate and snap | `request.cf` → H3 resolution-8 cell at the edge; the raw point is used once and dropped. "Paint my exact area" sends browser coordinates through the same snapping (`/locate`), and they go no further. "Paint somewhere else" searches places (Photon) and turns results into cells at the edge. |
| Scene builder | One bundle per cell from OpenFreeMap (OSM), Terrain Tiles, ESA WorldCover, Sentinel-2 L2A (cloud-masked, up to three scenes composited, newest clear scene first), Meta/WRI canopy height. Snaps to the most postcard public feature, picks the heading, classifies land cover, samples real colours, places trees, casts rays for real ridges. Streams NDJSON: streets and footprints first, then the full bundle. |
| Painting | Pencil drawing from geometry alone, then washes bloom in the PRD's order: sky, water, ground, buildings, trees. Painted in a Web Worker (OffscreenCanvas + WebGL). Device pixel ratio capped at 2. |
| Live window | Real time: the sun moves, lamps come on one by one as the sun drops below −2°, windows light after sunset with a few switching each minute, the washes repaint (crossfaded) when the light or weather changes. Weather from Open-Meteo, refreshed every 15 minutes. |
| Life from the map | Ferries on OSM ferry routes (pausing at terminals), boats only on open water over 0.2 km² (sailboats only under 12 m/s wind), canal boats on canals and narrow rivers, cars and buses on the road graph (busier at rush hour), trains on real rail, cable cars on real aerialways, people on paths and in parks (fewer in rain), gulls / crows / small birds, murmuration over farmland Oct–Mar near sunset, livestock in pasture, chimney smoke below 8 °C drifting with the real wind, rain rings on water, cloud shadows when partly cloudy. |
| Taps | In the PRD's order: boat (hull + 8 px: horn, steam, bow wave), bird (22 px: scatter), flock, water (ripples that bend the painted reflections; drag leaves a trail), building (handwritten label: real name if public, else type, plus height). `prefers-reduced-motion`: life drawn but still, no ripples or flow, labels still work. |
| Postcards | "Send this moment" freezes time, weather, sun and life (seed + step count), takes a note (≤ 140 characters) and a 1200 × 630 share image. `/p/:id` replays the same frozen moment and its life on any device, with Open Graph tags. |
| Credits | "Map data" lists every source used in that scene, plus the location policy. |

## Acceptance criteria, as measured

**1. Real data**
- `/scene/:cell` returns a valid bundle for land cells; open ocean gets a clear error (404 "This cell is open ocean"). **Pass.** The pre-build covered 500 cities on six continents with 0 failures.
- The Battery from the real bundle against the prototype card: same framing (looking north from the harbour at Battery Park, Castle Clinton, the ferry slips and the towers), real footprints and heights, ferries on the real Staten Island route. Judged side by side from screenshots. **Pass, by my eye**; it is worth a human look.
- No raw coordinates in logs, storage or bundles. **Pass.** Checked at runtime on production: a distinctive coordinate sent to `/locate` appears nowhere in the bundle or the worker's live logs. Bundles carry the snapped public place, postcards carry the cell, timing logs carry a country and a resolution-5 cell. Cloudflare's per-request invocation logs include the connecting IP, so they are switched off (`edge/wrangler.jsonc`). `test/edge.test.ts` covers the same rules.

**2. Satellite paint**
- Every test place recognisable with the label hidden: Battery, Aquatic Park, Herengracht (Westerkerk and the canal ring), Asakusa (the Sumida, its bridges, the Asahi towers), Central (piers and towers) and Naousa (harbour, breakwater, blue domes) read as themselves to me. Levittown, Middlebury and Kansas read as their kind of place, which is what their tests ask. **Needs a human judge who knows them.** Screenshots: `scripts/regress.ts`.
- Seasons: Vermont with late-October imagery paints autumn (2,061 of 3,000 trees red-orange); Grindelwald with January imagery paints snow (48% of the ground). **Pass**, after two fixes found by rendering (below).
- Tree count within 30% of a hand count on two 200 m squares (NAIP photos, public domain): Levittown 26 against about 28; Middlebury 81 against about 65–75 (the closed canopy at the square's edge makes the hand count soft). **Pass.**

**3. Alive**
- Life within 2 s of the painting finishing: life starts 30–60 ms after the last wash and is fully faded in by 1.2 s. **Pass.**
- Rain, fog and snow match Open-Meteo for the cell at load time: the palette, particles and words come straight from `/weather/:cell` (Grindelwald painted rain while Open-Meteo reported rain). **Pass.**
- 30 fps on a mid-range Android phone with two windows of life on screen: **not measured.** There was no phone to hand, and Chrome's CPU throttling did not reach the painting worker. On a laptop (M-series Mac, device scale 2) the live window holds 120 fps and a cached scene paints in about 0.8 s of worker time. Phones draw at most 3,000 trees (the PRD's mobile cap).

**4. Postcards**
- A postcard link replays the same frozen frame and life on another device: sent from production through the UI, opened in a fresh browser profile. Same time, weather and note, and life resumes from the frozen step (a boat in the same place). `test/life.test.ts` proves the replay is exact. **Pass.**
- Share image in iMessage, WhatsApp and Slack previews: the Open Graph tags and a 1200 × 630 JPEG are served, and Slack's, WhatsApp's and Facebook's crawlers get 200. **The previews were not checked inside the apps.**
- Credits list every source used in that scene. **Pass.**

**Budgets** (production, laptop at device scale 2):

| Step | Budget | Measured |
| --- | --- | --- |
| Edge locate and snap | 30 ms | in the page request, no extra round trip |
| Bundle fetch, cached cell | 400 ms | served from KV; the page paints a cached cell in about 3 s total |
| Scene build, uncached cell | 4 s | **missed**: 9.6 s median, 16.7 s p90 end to end during the pre-build (three builds at once); about 4–9 s for a single build. The streets-and-footprints bundle arrives first (1.3–3.7 s), so the pencil drawing shows early. |
| Pencil drawing visible | 1.5 s | 0.5–0.65 s (cached) |
| Full painting | 3 s laptop, 5 s phone | about 3.1 s on a laptop, including the 2 s of staged blooms; phone not measured |
| Page weight before the bundle | 250 KB gz | about 55 KB gz (JS + CSS + worker) |
| Bundle size, dense 2 km city | under 600 KB gz | 280–410 KB gz |

## Decisions, and why

| PRD says | Shipped | Why |
| --- | --- | --- |
| OSM via Protomaps, copied to R2 | **OpenFreeMap vector tiles** (OpenMapTiles schema), read in place | R2 is not enabled on the Cloudflare account and the planet file is about 120 GB. OpenFreeMap is free public OSM hosting meant for exactly this use, with water polygons already assembled from the coastline. Overpass was tried first: 53 s for one 2 km square. |
| Overture buildings | **OSM buildings** (OpenMapTiles `render_height`, `colour`) | Overture's tile copies have moved, and reading its GeoParquet per cell takes tens of seconds. OSM heights are good in cities. Roofs are inferred: pitched on small houses, and on narrow town houses where that is the local style (Netherlands, Germany, Japan and others); domes on Orthodox churches; flat where the region builds flat (Greece, the Middle East, Mexico and others). Facade colours come from OSM; roof colours from Sentinel-2. |
| Scene builder: Python container | **Node on Vercel** (Build Output API, region pdx1) | Cloudflare Containers need a paid plan. Every source is a cloud-optimised GeoTIFF or a vector tile, which geotiff.js and @mapbox/vector-tile read fine. pdx1 sits beside the Sentinel-2 bucket. |
| Scene cache in R2, postcards in KV | **KV for both** | No R2 (above). Bundles are stored uncompressed and Cloudflare compresses them on the way out, because the free plan's 10 ms CPU limit leaves no room for gzip in the worker. |
| Weather cached per resolution-6 cell for 15 minutes | Per resolution-6 cell, in isolate memory | The Cache API does not work on `workers.dev`. On a custom domain it would. |
| Sentinel-2 composite of the last 30–60 days | Newest scene under 25% cloud in the last 30 days, then the clearest of 60, masked by scene class, up to three scenes stacked | The colour has to be this month's: the least cloudy scene painted Vermont green on 6 October when the 23 October scene was at peak colour. |
| NDVI | Sentinel-2's own scene classes (vegetation, bare soil, snow) | Half the reads per scene. Snow in terrain shadow is recovered by colour: the classifier called 70% of Grindelwald's valley "dark area" in January. |
| Cap trees at 3,000 | The bundle carries up to 8,000, evenly thinned; phones draw the first 3,000 | Taking the tallest 3,000 left Middlebury's streets with no trees at all. |
| Heading override when the feature faces the camera's back | The camera stands on the water and looks at the land for a waterfront; mountains face their highest skyline; otherwise north | This is the framing of the winning prototype card (the Battery from the harbour). Grindelwald faced away from the Eiger before the mountain rule. |
| Ridges beyond the far edge | Real terrain out to 25 km, drawn by its elevation angle from the far edge | A true projection put distant flat ground over the whole sky, because at a 34° pitch the horizon is above the frame. |
| Park or street tap: people glance, a dog barks (v1.1) | Not built | The PRD marks it v1.1. |
| NAIP fine colour (optional) | Not used | Requester-pays; Sentinel-2 covers colour well enough, which the PRD allows. |

Extensions to the bundle contract are listed in `shared/bundle.ts`: `view`, `label`, `place`, `sample`, `distant`, `beyond`, `feature`, `built`, `terrain.base` (heights are decimetres above it, so the Alps fit an Int16) and `spawn.cables`. Water is a list of polygons with holes rather than bare rings.

## The PRD's open questions, answered

1. **Should the heading follow the phone's compass?** No, not in v1. The heading is part of the composition: a compass-driven window would re-frame with every twitch of the hand, and a postcard would not match what was sent.
2. **How dark at night?** A moonlit indigo, a step darker than dusk and never black, with stars when the sky is clear and a warm city glow low on the horizon in towns. The lamps and windows carry the picture.
3. **Live or frozen weather on a postcard?** Frozen, as planned. The postcard is the moment that was sent.
4. **Sound beyond horns, and muted?** Horns only, and only when the visitor taps a boat. Nothing plays by itself, so there is nothing to mute.
5. **Is Moment commercial?** Not now: no ads, Open-Meteo's free tier, no commercial imagery. Going commercial means the paid Open-Meteo plan first.

## Licensing and attribution

Every scene credits its sources ("Map data"): © OpenStreetMap contributors (ODbL) via OpenMapTiles/OpenFreeMap, Terrain Tiles on AWS, ESA WorldCover 2021 (CC BY 4.0), modified Copernicus Sentinel data (Earth Search), Meta and WRI canopy height (CC BY 4.0), Open-Meteo (CC BY 4.0), Photon (OSM). Baked bundles derive from OSM, so they are an ODbL derivative database. The format is published (`shared/bundle.ts`) and any bundle is available at `/scene/:cell`, which covers "publish the format and keep them available on request". A licence review before any commercial use is still the PRD's open item.

## Limits worth knowing

- Free-plan KV allows 1,000 writes a day: each new cell is one write, each postcard two. The pre-build used 500 on launch day.
- A cell's bundle is kept per calendar month (`scene:v1:<cell>:<YYYY-MM>`), so imagery refreshes monthly. Postcards ask for their own month's bundle.
- Labels come from OSM names, in Latin script only (the handwriting font cannot draw others), so some are plain ("Around Boss Chrigel, Grindelwald").

## Running it

```bash
npm ci
BUILDER_SECRET=dev-secret node --experimental-strip-types scripts/builder-server.ts   # builder on :8790
npm run build:client
npx wrangler dev --config edge/wrangler.jsonc --port 8787 --var BUILDER_URL:http://127.0.0.1:8790/
open "http://127.0.0.1:8787/?place=battery"
npm test && npm run typecheck
```

Overrides: `?place=<test place id>`, `?cell=<h3 res 8>`, `?at=<ISO time>`, `?weather=rain|drizzle|snow|fog|clear`, `?date=YYYY-MM-DD` (imagery season).
Tools:
- `scripts/build-place.ts battery` builds one bundle and reports what went into it.
- `scripts/regress.ts` paints the ten test places at noon, golden hour and an hour after sunset, and screenshots each.
- `scripts/prebuild.ts` builds the 500 most populated cells (GeoNames cities15000, CC BY 4.0).
- `scripts/probe.mjs` is the headless Chrome driver. `HEADFUL=1` uses the real GPU, `DPR=2` sets device scale and `THROTTLE=4` slows the CPU.

## Deploying

- **Builder:** Vercel project `momentwindow-builder`, git-connected, so a push to `main` deploys it. `scripts/bundle-builder.mjs` bundles it with esbuild into a Build Output API function. It needs `BUILDER_SECRET` (set).
- **Edge:** from the pushed commit: `git archive HEAD | tar -x -C $D && cd $D && npm ci && npm run build:client && npx wrangler deploy --config edge/wrangler.jsonc`. It needs the `BUILDER_SECRET` worker secret (set). A GitHub Action could do this once a `CLOUDFLARE_API_TOKEN` repository secret exists.
