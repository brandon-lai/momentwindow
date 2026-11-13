// One scene bundle per H3 cell. Two passes: a quick probe of the map around
// the cell decides the scene kind, the snapped feature and the heading; then
// every source is fetched for the final square in parallel and baked.
import { cellToBoundary, cellToLatLng, getResolution, isValidCell } from "h3-js";
import { BUNDLE_VERSION, KIND, LANDMARK_CLASSES, type Building, type Cover, type Heading, type Pt, type Rail, type Ring, type Road, type SceneBundle, type SceneKind } from "../../shared/bundle.ts";
import { bboxOf, localFrame, type Local } from "../../shared/geo.ts";
import { absArea, area, centroid, clipLine, clipRing, grid8, inRing, len, rasterise, round1, roundPts, simplify } from "./geom.ts";
import { forward, nameNear, pickFeature, waterGrid } from "./snap.ts";
import { fetchOSM, type OsmData } from "./sources/ofm.ts";
import { fetchElevation, type Elevation } from "./sources/terrain.ts";
import { fetchCanopy, fetchSentinel, fetchWorldCover } from "./sources/rasters.ts";
import { reverseGeocode } from "./sources/photon.ts";
import { buildCovers, placeTrees, sampleColour } from "./surface.ts";

export class OceanError extends Error { constructor() { super("This cell is open ocean: there is no land to paint."); } }
export class CellError extends Error {}

export interface BuildOpts {
  date?: Date; // season of the imagery (defaults to now)
  onLite?: (b: SceneBundle) => void; // streets and footprints, before imagery
  log?: (msg: string) => void;
}

const ROAD_W: Record<string, number> = { motorway: 22, trunk: 20, primary: 16, secondary: 14, tertiary: 12, minor: 9, service: 5, track: 4, path: 3, raceway: 8, busway: 8 };
const ROAD_KIND: Record<string, string> = { motorway: "avenue", trunk: "avenue", primary: "avenue", secondary: "avenue", tertiary: "street", minor: "street", service: "lane", track: "dirt", path: "path", busway: "street" };

export async function buildScene(cell: string, opts: BuildOpts = {}): Promise<SceneBundle> {
  const t0 = Date.now(), sources: Record<string, number> = {}, notes: string[] = [];
  const timed = async <T>(name: string, p: Promise<T>): Promise<T> => { const s = Date.now(); try { return await p; } finally { sources[name] = Date.now() - s; } };
  // imagery is best-effort: a slow service costs that layer, never the build
  const capped = <T>(name: string, p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>(r => setTimeout(() => { notes.push(`${name} gave up after ${ms / 1000} s`); r(null); }, ms))]);
  if (!isValidCell(cell) || getResolution(cell) !== 8) throw new CellError("A scene is built per H3 cell at resolution 8.");
  const date = opts.date ?? new Date();

  // ---- probe: the map within ~800 m of the cell ----
  const [clat, clon] = cellToLatLng(cell);
  const PS = 2400; // probe square: the cell plus room to judge what a camera would see
  const P = localFrame(clat, clon, PS);
  const probeBox = bboxOf(P, PS);
  const [osmProbe, reliefProbe] = await Promise.all([
    timed("probe.osm", fetchOSM(P, probeBox, 14)),
    timed("probe.terrain", fetchElevation(bboxOf(P, PS, 1300), 11)),
  ]);
  const cellRing: Ring = cellToBoundary(cell).map(([la, lo]) => P.toXY(la, lo));

  // open ocean: water everywhere, nothing built
  const wg = waterGrid(osmProbe, PS, 25);
  const cellLand = (() => { let n = 0, l = 0; for (let y = PS / 2 - 600; y < PS / 2 + 600; y += 25) for (let x = PS / 2 - 600; x < PS / 2 + 600; x += 25) if (inRing(x, y, cellRing)) { n++; if (!wg.at(x, y)) l++; } return l / Math.max(1, n); })();
  if (cellLand < 0.02 && osmProbe.buildings.length === 0) throw new OceanError();

  // scene kind from building cover and relief
  // built share of the land within 800 m of the cell centre
  let footprint = 0, count = 0, tall = 0; const areas: number[] = [];
  for (const b of osmProbe.buildings) {
    const c = centroid(b.rings[0]); if (Math.hypot(c[0] - PS / 2, c[1] - PS / 2) >= 800) continue;
    const a = absArea(b.rings[0]); footprint += a; count++; areas.push(a); if (b.h > 14) tall++;
  }
  const builtFrac = footprint / (Math.PI * 800 * 800);
  areas.sort((a, b) => a - b);
  const medianFootprint = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
  // a city centre has big footprints or tall buildings; a suburb of small
  // houses can cover as much ground and still be a suburb
  const cityLike = medianFootprint > 260 || tall / Math.max(1, count) > 0.2;
  let lo = Infinity, hi = -Infinity;
  for (let a = 0; a < 24; a++) for (const d of [0, 600, 1200, 1800, 2400]) {
    const [la, lon] = P.toLatLon(PS / 2 + Math.cos(a / 24 * 2 * Math.PI) * d, PS / 2 + Math.sin(a / 24 * 2 * Math.PI) * d);
    const h = reliefProbe.at(la, lon); lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  const relief = hi - lo;
  const kind: SceneKind = relief > 450 && builtFrac < 0.12 ? "mountain" : builtFrac > 0.14 && cityLike ? "dense" : builtFrac > 0.03 || count > 120 ? "suburb" : "country";
  notes.push(`kind ${kind}: ${(builtFrac * 100).toFixed(1)}% built, ${count} buildings within 800 m (median ${Math.round(medianFootprint)} m2), ${Math.round(relief)} m relief`);
  const K = KIND[kind];

  // ---- snap ----
  const snap = pickFeature(osmProbe, cellRing, PS);
  if (kind === "mountain") {
    // in the mountains the picture is the mountains: face the highest skyline
    const wide = await timed("probe.relief", fetchElevation(bboxOf(P, PS, 11000), 10));
    const [sla, slo] = P.toLatLon(snap.x, snap.y), h0 = wide.at(sla, slo);
    let best = -Infinity;
    for (const [h, th] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as [Heading, number][]) {
      let m = -Infinity;
      for (let a = -25; a <= 25; a += 5) for (let d = 1500; d <= 11000; d += 500) {
        const t = ((th + a) * Math.PI) / 180, [la, lo2] = P.toLatLon(snap.x + Math.sin(t) * d, snap.y + Math.cos(t) * d);
        m = Math.max(m, (wide.at(la, lo2) - h0) / d);
      }
      if (m > best + (h === "N" ? 0 : 0.02)) { best = m; snap.heading = h; }
    }
    notes.push(`mountain heading ${snap.heading} (max slope to skyline ${best.toFixed(2)})`);
  }
  const fwd = forward(snap.heading);
  // the feature sits 30% of the way into the window's depth
  const wcx = snap.x + fwd[0] * K.d * 0.2, wcy = snap.y + fwd[1] * K.d * 0.2;
  const [lat0, lon0] = P.toLatLon(wcx, wcy);
  const S = K.square;
  const L = localFrame(lat0, lon0, S);
  const fx = snap.x - wcx + S / 2, fy = snap.y - wcy + S / 2;
  opts.log?.(`snap ${snap.kind} ${snap.name ?? ""} heading ${snap.heading} kind ${kind}`);

  // window rectangle in north-up local metres, for priorities and the ridge rays
  const rot = (u: number, v: number): Pt => { // view frame (u right, v forward) about the square centre -> north-up
    const c = S / 2, du = u - c, dv = v - c;
    switch (snap.heading) { case "N": return [c + du, c + dv]; case "S": return [c - du, c - dv]; case "E": return [c + dv, c - du]; default: return [c - dv, c + du]; }
  };
  const win: Ring = [rot((S - K.w) / 2, (S - K.d) / 2), rot((S + K.w) / 2, (S - K.d) / 2), rot((S + K.w) / 2, (S + K.d) / 2), rot((S - K.w) / 2, (S + K.d) / 2)];
  const inWindow = (x: number, y: number) => inRing(x, y, win);

  // ---- fetch everything for the square ----
  const box = bboxOf(L, S, 60);
  const z = 14; // buildings only come at full detail at zoom 14
  const tz = kind === "country" || kind === "mountain" ? 12 : 14;
  const osmP = timed("osm", fetchOSM(L, box, z));
  const elevP = timed("terrain", fetchElevation(box, tz));
  // beyond the far edge: real ridges to 25 km out
  const farOrigin = rot(S / 2, (S - K.d) / 2);
  const [fla, flo] = L.toLatLon(farOrigin[0], farOrigin[1]);
  const farL = localFrame(fla, flo, 52000);
  const farP = timed("terrain.far", fetchElevation(bboxOf(farL, 52000), 10));
  const placeP = timed("photon", reverseGeocode(lat0, lon0).catch(() => null));
  const imgRes = 10;
  const wcP = timed("worldcover", capped("worldcover", fetchWorldCover(L, S, imgRes).catch(e => { notes.push(`worldcover: ${e.message}`); return null; }), 25000));
  const s2P = timed("sentinel2", capped("sentinel-2", fetchSentinel(L, S, imgRes, date).catch(e => { notes.push(`sentinel-2: ${e.message}`); return null; }), 30000));
  const canRes = kind === "dense" ? 2 : kind === "suburb" ? 2 : 3;
  const canP = timed("canopy", capped("canopy", fetchCanopy(L, S, canRes).catch(e => { notes.push(`canopy: ${e.message}`); return null; }), 25000));

  const [osm, elev] = await Promise.all([osmP, elevP]);
  const W = waterGrid(osm, S, 4);
  const water = (x: number, y: number) => W.at(x, y);

  // ---- terrain grid ----
  const cols = 201, rows = 201, spacing = S / (cols - 1);
  const raw = new Float32Array(cols * rows);
  let base = Infinity;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const [la, lon] = L.toLatLon(i * spacing, j * spacing);
    const h = elev.at(la, lon); raw[j * cols + i] = h; base = Math.min(base, h);
  }
  base = Math.floor(base);
  // water is flat at its lowest shore level so ripples and boats sit on it
  const heights = new Int16Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i; let h = raw[k] - base;
    if (water(i * spacing, j * spacing)) h = Math.min(h, 0.3);
    heights[k] = Math.max(-3000, Math.min(32000, Math.round(h * 10)));
  }
  const elevAt = (x: number, y: number) => {
    const fi = Math.max(0, Math.min(cols - 1.001, x / spacing)), fj = Math.max(0, Math.min(rows - 1.001, y / spacing));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    const a = heights[j * cols + i], b = heights[j * cols + i + 1], c = heights[(j + 1) * cols + i], d = heights[(j + 1) * cols + i + 1];
    return (a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v) / 10;
  };

  // ---- vectors ----
  const clipPoly = (rings: Ring[]): Ring[] => rings.map(r => clipRing(r, -20, -20, S + 20, S + 20)).filter(r => r.length >= 3);
  const waterPolys: Ring[][] = [];
  for (const w of osm.water) { if (w.cls === "swimming_pool") continue; const p = clipPoly(w.rings); if (p.length && absArea(p[0]) > 20) waterPolys.push(p.map(r => roundPts(simplify(r, 0.6, true)))); }
  const land: Ring[] = [];
  for (const p of osm.piers) { const r = clipPoly(p.rings)[0]; if (r) land.push(roundPts(simplify(r, 0.3, true))); }
  const roads: Road[] = [], rail: Rail[] = [], ferries: Pt[][] = [], paths: Pt[][] = [], cables: Pt[][] = [];
  const dense = kind === "dense" || kind === "suburb";
  for (const t of osm.transport) {
    if (t.brunnel === "tunnel") continue;
    for (const pts0 of clipLine(t.pts, -30, -30, S + 30, S + 30)) {
      const pts = roundPts(simplify(pts0, 0.8));
      if (pts.length < 2 || len(pts) < 4) continue;
      if (t.cls === "ferry") { ferries.push(pts); continue; }
      if (t.cls === "aerialway" && ["cable_car", "gondola", "mixed_lift"].includes(t.sub ?? "")) { cables.push(pts); continue; }
      if (t.cls === "rail" || t.cls === "transit") {
        if (t.sub === "subway" || t.sub === "funicular") continue;
        const k = t.sub === "tram" ? "tram" : t.sub === "light_rail" || t.sub === "monorail" ? "light_rail" : "rail";
        rail.push({ pts, kind: k, ...(t.brunnel === "bridge" ? { bridge: true } : {}) });
        continue;
      }
      if (t.cls === "pier") { land.push(...bandRing(pts, 6)); continue; }
      const kindR = ROAD_KIND[t.cls]; if (!kindR) continue;
      let w = ROAD_W[t.cls] ?? 6;
      if (t.cls === "path" && (t.sub === "pedestrian" || t.sub === "platform")) w = 6;
      if (t.sub === "steps") w = 3;
      roads.push({ pts, w, kind: kindR, lit: dense && (kindR === "avenue" || kindR === "street" || (kindR === "path" && t.sub === "pedestrian")), ...(t.brunnel === "bridge" ? { bridge: true } : {}) });
      if (kindR === "path" && t.sub !== "steps") paths.push(pts);
    }
  }

  // ---- buildings (footprints now, colours and names after imagery) ----
  const countryCode = ((await placeP)?.cc ?? "").toUpperCase();
  const flatRoofs = ["GR", "CY", "MT", "MA", "TN", "EG", "IL", "JO", "LB", "AE", "SA", "QA", "OM", "KW", "BH", "IR", "IQ", "LY", "DZ", "MX", "PE", "IN", "PK"].includes(countryCode);
  const domeChurch = ["GR", "CY", "RU", "UA", "BG", "RS", "RO", "GE", "AM"].includes(countryCode);
  // town houses with pitched roofs even in dense centres (canal houses,
  // Japanese houses); not New York's flat-roofed rows
  const pitchedTowns = ["NL", "BE", "DE", "DK", "SE", "NO", "FI", "PL", "CZ", "AT", "CH", "GB", "IE", "FR", "JP", "LU", "EE", "LV", "LT", "SK", "HU", "SI"].includes(countryCode);
  const buildings: Building[] = [];
  for (const b of osm.buildings) {
    if (b.hide) continue;
    const r0 = clipRing(b.rings[0], -10, -10, S + 10, S + 10); if (r0.length < 3) continue;
    let ring = simplify(r0, 0.4, true); if (ring.length < 3) continue;
    const a = absArea(ring); if (a < 10) continue;
    if (area(ring) < 0) ring = ring.slice().reverse();
    const c = centroid(ring);
    let h = b.h, notes2 = "";
    if (!h || h === 5) { h = a < 250 ? 7 : 12; notes2 = "default"; }
    const poi = osm.pois.find(p => p.name && LANDMARK_CLASSES.has(p.cls) && Math.abs(p.x - c[0]) < 120 && Math.abs(p.y - c[1]) < 120 && inRing(p.x, p.y, ring));
    // roofs: pitched on small detached houses outside dense centres, domes on
    // Orthodox churches, flat where the region builds flat
    let roof = "flat", roofH = 0, roofDir: number | undefined;
    const axis = longAxis(ring);
    if (poi?.cls === "place_of_worship") { roof = domeChurch ? "dome" : "gable"; roofH = domeChurch ? Math.min(8, Math.sqrt(a) * 0.5) : Math.min(10, Math.sqrt(a) * 0.35); roofDir = axis; }
    else if (!flatRoofs && kind !== "dense" && a < 320 && h <= 14) { roof = "gable"; roofH = Math.min(5, Math.sqrt(a) * 0.32); roofDir = axis; }
    else if (pitchedTowns && a < 420 && h <= 26) {
      let longest = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; longest = Math.max(longest, Math.hypot(q[0] - p[0], q[1] - p[1])); }
      const width = a / Math.max(1, longest);
      if (width < 11) { roof = "gable"; roofH = Math.min(6, Math.max(3, width * 0.55)); roofDir = axis; }
    }
    buildings.push({
      p: roundPts(ring), h: round1(h - Math.min(b.minH, h - 1)), minH: round1(Math.min(b.minH, h - 1)), roof, roofH: round1(roofH),
      ...(roofDir !== undefined ? { roofDir: Math.round(roofDir * 100) / 100 } : {}),
      ...(b.colour ? { facadeColour: b.colour } : {}),
      ...(poi ? { name: poi.name, cls: poi.sub || poi.cls } : {}),
      ...(notes2 ? {} : {}),
    });
  }

  const centre: [number, number] = [Math.round(lat0 * 1e5) / 1e5, Math.round(lon0 * 1e5) / 1e5];
  const place = await placeP;
  const featureName = snap.name ?? nameNear(osm, fx, fy, 400);
  const city = place?.city || place?.county || place?.state || "";
  const town = osm.places.filter(p => p.name && ["village", "town", "hamlet", "city", "suburb"].includes(p.cls)).sort((a, b) => Math.hypot(a.x - S / 2, a.y - S / 2) - Math.hypot(b.x - S / 2, b.y - S / 2))[0]?.name;
  const region = place?.state || place?.country || "";
  const label = featureName ? `Around ${theName(featureName)}${city && city !== featureName ? `, ${city}` : ""}`
    : place?.district && city ? `${place.district}, ${city}`
    : city ? `Around ${city}`
    : town ? `Near ${town}${region ? `, ${region}` : ""}`
    : place?.county ? `${place.county}${region && region !== place.county ? `, ${region}` : ""}`
    : region ? `Somewhere in ${region}` : "Open country";

  // ---- beyond the far edge ----
  const far = await farP;
  const beyond: SceneBundle["beyond"] = [];
  const headAz = { N: 0, E: 90, S: 180, W: 270 }[snap.heading];
  for (let k = -30; k <= 30; k++) {
    const az = (k / 30) * 52; // wide enough to reach the window's far corners
    const dist: number[] = [], hs: number[] = [];
    for (let s = 0; s < 36; s++) {
      const d = 150 * Math.pow(1.16, s); if (d > 25000) break;
      const th = ((headAz + az) * Math.PI) / 180;
      const x = farL.x0 + Math.sin(th) * d, y = farL.y0 + Math.cos(th) * d;
      const [la, lon] = farL.toLatLon(x, y);
      dist.push(Math.round(d)); hs.push(Math.round(far.at(la, lon) - base));
    }
    beyond.push({ az: Math.round(az * 10) / 10, dist, h: hs });
  }
  let farMax = -Infinity; for (const r of beyond) for (const h of r.h) farMax = Math.max(farMax, h);
  // far edge over open water?
  let farWet = 0; for (let u = 0.1; u <= 0.9; u += 0.1) { const p = rot(S / 2 - K.w / 2 + u * K.w, (S + K.d) / 2 - 20); if (water(p[0], p[1])) farWet++; }
  const distant: SceneBundle["distant"] = farMax > 120 ? "ridge" : farWet >= 6 ? "island" : kind === "dense" ? "skyline" : "hills";

  const attribution = ["© OpenStreetMap contributors (ODbL)", "OpenMapTiles via OpenFreeMap", "Terrain Tiles on AWS (Mapzen, USGS, SRTM, GMTED, ETOPO1 and others)"];
  const spawnBase = { paths: paths.slice(0, 400), canals: [] as Pt[][] };

  const bundle: SceneBundle = {
    version: BUNDLE_VERSION, cell, centre, size: [S, S], heading: snap.heading,
    terrain: { cols, rows, spacing: round1(spacing), heights: Buffer.from(heights.buffer).toString("base64"), base },
    water: waterPolys, land, roads, rail, ferries, covers: [], buildings, trees: [],
    spawn: { parks: [], paths: spawnBase.paths, openWater: [], pasture: [], canals: [], cables },
    attribution,
    view: { w: K.w, d: K.d, pitch: K.pitch, kind },
    label, place: { name: featureName ?? "", city, country: place?.country ?? "", cc: countryCode },
    sample: { ground: null, water: null, snowCover: 0, month: date.toISOString().slice(0, 7) },
    distant, beyond,
    feature: { kind: snap.kind, ...(featureName ? { name: featureName } : {}), x: round1(fx), y: round1(fy) },
    built: { at: new Date().toISOString(), ms: 0, sources, month: date.toISOString().slice(0, 7), notes },
  };
  // spawn zones that need only the map
  for (const p of waterPolys) {
    const a = absArea(p[0]) - p.slice(1).reduce((s, h) => s + absArea(h), 0);
    if (a > 200000) bundle.spawn.openWater.push(p[0]);
  }
  for (const w of osm.waterways) {
    if (w.brunnel === "tunnel" || !["canal", "river"].includes(w.cls)) continue;
    for (const pts of clipLine(w.pts, 0, 0, S, S)) {
      // narrower than 60 m: the land is within 30 m either side somewhere along it
      const mid = pts[Math.floor(pts.length / 2)];
      let narrow = false;
      for (let a = 0; a < 8 && !narrow; a++) { const th = (a * Math.PI) / 4; if (!water(mid[0] + Math.cos(th) * 30, mid[1] + Math.sin(th) * 30)) narrow = true; }
      if (narrow && len(pts) > 120) bundle.spawn.canals.push(roundPts(simplify(pts, 1)));
    }
  }
  trim(bundle, win, kind);
  bundle.built.ms = Date.now() - t0;
  opts.onLite?.(structuredClone(bundle));

  // ---- imagery ----
  const [wc, s2, canopy] = await Promise.all([wcP, s2P, canP]);
  if (s2) { notes.push(`sentinel-2 ${s2.items.join(", ")}, ${(s2.cloudFraction * 100).toFixed(0)}% still cloudy`); bundle.sample.month = s2.month; bundle.built.month = s2.month; }
  const covers: Cover[] = buildCovers({ size: S, kind, osm, wc, s2, water, notes });
  bundle.covers = covers.map(c => ({ ...c, poly: roundPts(c.poly), ...(c.colour ? { colour: c.colour.map(Math.round) as Cover["colour"] } : {}) }));
  // ground and water samples
  if (s2) {
    const landPoly: Ring[] = [[[0, 0], [S, 0], [S, S], [0, S]]];
    const n = s2.clear.w, R: number[] = [], G: number[] = [], B: number[] = [], wR: number[] = [], wG: number[] = [], wB: number[] = [];
    const cm = grid8(S, 10);
    for (const c of covers) rasterise(cm, [c.poly], 1);
    const coverMask = cm.data;
    let snowN = 0, landN = 0;
    for (let k = 0; k < n * n; k++) {
      if (!s2.clear.data[k]) continue;
      const x = ((k % n) + 0.5) * 10, y = (Math.floor(k / n) + 0.5) * 10;
      if (water(x, y)) { wR.push(s2.rgb[0].data[k]); wG.push(s2.rgb[1].data[k]); wB.push(s2.rgb[2].data[k]); continue; }
      landN++; if (s2.snow.data[k]) snowN++;
      if (!coverMask[k]) { R.push(s2.rgb[0].data[k]); G.push(s2.rgb[1].data[k]); B.push(s2.rgb[2].data[k]); }
    }
    const med = (a: number[]) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    if (R.length > 20) bundle.sample.ground = [med(R), med(G), med(B)];
    if (wR.length > 20) bundle.sample.water = [med(wR), med(wG), med(wB)];
    bundle.sample.snowCover = Math.round((100 * snowN) / Math.max(1, landN)) / 100;
    void landPoly; void sampleColour;
    bundle.attribution.push("Contains modified Copernicus Sentinel data " + s2.month.slice(0, 4) + " (Earth Search by Element 84)");
  }
  if (wc) bundle.attribution.push("ESA WorldCover 10 m 2021 v200 (CC BY 4.0)");
  // trees
  const month = date.getUTCMonth() + 1;
  bundle.trees = placeTrees(canopy, s2, { lat: lat0, elev: (x, y) => elevAt(x, y) + base, month, water, cap: 3000, priority: (x, y) => (inWindow(x, y) ? 1 : 0) });
  if (canopy) bundle.attribution.push("Meta and World Resources Institute, High Resolution Canopy Height Maps (CC BY 4.0)");
  notes.push(`${bundle.trees.length} trees`);
  // building colours from the imagery where OSM has none: roofs only (the
  // satellite sees roofs), facades stay with the palette
  if (s2) for (const b of bundle.buildings) {
    if (b.roof === "flat" && absArea(b.p) > 150) { const c = sampleColour(s2, [b.p], S); if (c) b.roofColour = "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join(""); }
  }
  // parks and pasture for life
  bundle.spawn.parks = bundle.covers.filter(c => (c.type === "park" || c.type === "plaza") && absArea(c.poly) > 800).map(c => c.poly);
  bundle.spawn.pasture = bundle.covers.filter(c => c.type === "pasture" || (c.type === "grass" && (kind === "country" || kind === "mountain"))).filter(c => absArea(c.poly) > 3000).map(c => c.poly).slice(0, 30);
  trim(bundle, win, kind);
  bundle.built.ms = Date.now() - t0;
  return bundle;
}

// Only the window (plus a margin for shadows, reflections and things driving
// in) is painted, so only that much is shipped. Tall buildings a little
// further out stay for their shadows and reflections.
function trim(b: SceneBundle, win: Ring, kind: SceneKind) {
  const xs = win.map(p => p[0]), ys = win.map(p => p[1]);
  const m = kind === "dense" ? 60 : 100;
  const x0 = Math.min(...xs) - m, x1 = Math.max(...xs) + m, y0 = Math.min(...ys) - m, y1 = Math.max(...ys) + m;
  const inR = (x: number, y: number, e = 0) => x >= x0 - e && x <= x1 + e && y >= y0 - e && y <= y1 + e;
  b.buildings = b.buildings.filter(q => { const c = centroid(q.p); return inR(c[0], c[1], 60) || (q.h > 60 && inR(c[0], c[1], 400)); });
  b.trees = b.trees.filter(t => inR(t.x, t.y, 10));
  const clipC = (r: Ring) => clipRing(r, x0, y0, x1, y1);
  b.covers = b.covers.map(c => ({ ...c, poly: roundPts(clipC(c.poly)) })).filter(c => c.poly.length >= 3 && absArea(c.poly) > 4);
  b.water = b.water.map(p => p.map(r => roundPts(clipRing(r, x0 - 40, y0 - 40, x1 + 40, y1 + 40))).filter(r => r.length >= 3)).filter(p => p.length && absArea(p[0]) > 4);
  b.land = b.land.map(r => roundPts(clipC(r))).filter(r => r.length >= 3);
  const clipL = (l: Pt[]) => clipLine(l, x0 - 40, y0 - 40, x1 + 40, y1 + 40).map(roundPts);
  b.roads = b.roads.flatMap(r => clipL(r.pts).map(pts => ({ ...r, pts }))).filter(r => r.pts.length > 1);
  b.rail = b.rail.flatMap(r => clipL(r.pts).map(pts => ({ ...r, pts })));
  b.spawn.paths = b.spawn.paths.flatMap(clipL).slice(0, 400);
  b.spawn.parks = b.spawn.parks.map(clipC).filter(r => r.length >= 3).map(roundPts);
  b.spawn.pasture = b.spawn.pasture.map(clipC).filter(r => r.length >= 3).map(roundPts);
}

function longAxis(r: Ring): number {
  // direction of the longest edge: ridges run along it
  let best = 0, ang = 0;
  for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); } }
  return ang;
}
function bandRing(pts: Pt[], w: number): Ring[] {
  const L: Pt[] = [], R: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    L.push([round1(pts[i][0] - (ty * w) / 2), round1(pts[i][1] + (tx * w) / 2)]); R.push([round1(pts[i][0] + (ty * w) / 2), round1(pts[i][1] - (tx * w) / 2)]);
  }
  return [L.concat(R.reverse())];
}
function theName(n: string): string { return /^(the|la|le|les|el|il|der|die|das)\s/i.test(n) ? n.replace(/^The /, "the ") : /\b(Park|Square|Battery|Garden|Gardens|Market|Bridge|Harbour|Harbor|Pier|Quay|Station|Museum|Church|Cathedral|Temple|Tower)\b/.test(n) && !/^[A-Z][a-z]+'s/.test(n) ? n : n; }
export type { Local, OsmData, Elevation, Heading };
