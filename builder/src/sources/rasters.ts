// Cloud-optimised GeoTIFF readers for the three imagery-derived layers:
// ESA WorldCover (land cover classes), Sentinel-2 L2A via Earth Search
// (true colour, scene classes, red and near-infrared), and the Meta/WRI
// canopy height map. Every reader returns a grid over the scene square in
// local metres, so the rest of the builder never sees a projection.
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import { type Local, mercX, mercY, quadkey, toUTM, lonToTileX, latToTileY } from "../../../shared/geo.ts";
import type { Grid } from "../geom.ts";

const tiffs = new Map<string, Promise<GeoTIFF>>();
function open(url: string): Promise<GeoTIFF> {
  if (!tiffs.has(url)) {
    const p = fromUrl(url, { allowFullFile: false, cacheSize: 64, blockSize: 65536 } as any);
    p.catch(() => tiffs.delete(url));
    tiffs.set(url, p);
    if (tiffs.size > 60) tiffs.delete(tiffs.keys().next().value!);
  }
  return tiffs.get(url)!;
}

// Reads the window of `img` covering the given native-coordinate box, then
// samples it at each grid cell centre via `toNative`.
async function sampleImage(img: GeoTIFFImage, size: number, res: number, toNative: (x: number, y: number) => [number, number], bands: number[] | null, fill: number): Promise<Float32Array[]> {
  const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const W = img.getWidth(), H = img.getHeight();
  const n = Math.ceil(size / res);
  // native box of the square
  let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
  for (const [x, y] of [[0, 0], [size, 0], [0, size], [size, size], [size / 2, 0], [size / 2, size], [0, size / 2], [size, size / 2]]) {
    const [nx, ny] = toNative(x, y); const px = (nx - ox) / rx, py = (ny - oy) / ry;
    px0 = Math.min(px0, px); py0 = Math.min(py0, py); px1 = Math.max(px1, px); py1 = Math.max(py1, py);
  }
  const wx0 = Math.max(0, Math.floor(px0) - 1), wy0 = Math.max(0, Math.floor(py0) - 1), wx1 = Math.min(W, Math.ceil(px1) + 1), wy1 = Math.min(H, Math.ceil(py1) + 1);
  const nb = bands ? bands.length : img.getSamplesPerPixel();
  const outs = Array.from({ length: nb }, () => new Float32Array(n * n).fill(fill));
  if (wx1 <= wx0 || wy1 <= wy0) return outs;
  const rasters = (await img.readRasters({ window: [wx0, wy0, wx1, wy1], samples: bands ?? undefined, interleave: false })) as unknown as ArrayLike<number>[];
  const ww = wx1 - wx0, wh = wy1 - wy0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [nx, ny] = toNative((i + 0.5) * res, (j + 0.5) * res);
    const px = Math.floor((nx - ox) / rx) - wx0, py = Math.floor((ny - oy) / ry) - wy0;
    if (px < 0 || py < 0 || px >= ww || py >= wh) continue;
    for (let b = 0; b < nb; b++) outs[b][j * n + i] = rasters[b][py * ww + px];
  }
  return outs;
}

// ---------- ESA WorldCover 10 m (2021, v200) ----------
export const WC = { tree: 10, shrub: 20, grass: 30, crop: 40, built: 50, bare: 60, snow: 70, water: 80, wetland: 90, mangrove: 95, moss: 100 } as const;

export async function fetchWorldCover(L: Local, size: number, res: number): Promise<Grid<Uint8Array>> {
  const n = Math.ceil(size / res), out = new Uint8Array(n * n);
  const corners = [L.toLatLon(0, 0), L.toLatLon(size, size)];
  const names = new Set<string>();
  for (const lat of [corners[0][0], corners[1][0]]) for (const lon of [corners[0][1], corners[1][1]]) {
    const la = Math.floor(lat / 3) * 3, lo = Math.floor(lon / 3) * 3;
    names.add(`${la < 0 ? "S" : "N"}${String(Math.abs(la)).padStart(2, "0")}${lo < 0 ? "W" : "E"}${String(Math.abs(lo)).padStart(3, "0")}`);
  }
  for (const name of names) {
    const url = `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;
    let img: GeoTIFFImage;
    try { img = await (await open(url)).getImage(0); } catch { continue; } // open ocean has no tile
    const [band] = await sampleImage(img, size, res, (x, y) => { const [la, lo] = L.toLatLon(x, y); return [lo, la]; }, [0], 0);
    for (let k = 0; k < out.length; k++) if (band[k]) out[k] = band[k];
  }
  return { w: n, h: n, res, data: out };
}

// ---------- Sentinel-2 L2A (Earth Search STAC) ----------
interface StacItem { id: string; properties: Record<string, any>; assets: Record<string, { href: string }> }

export interface Sentinel {
  rgb: Grid<Uint8Array>[]; // r, g, b true colour (TCI), 0 where no clear pixel
  clear: Grid<Uint8Array>; // 1 where a clear pixel was found
  snow: Grid<Uint8Array>; // 1 where the scene class says snow
  bare: Grid<Uint8Array>; // 1 where the scene class says not vegetated (bare soil)
  items: string[]; month: string; cloudFraction: number;
}

export async function fetchSentinel(L: Local, size: number, res: number, refDate: Date): Promise<Sentinel | null> {
  const [s, w] = L.toLatLon(0, 0), [n, e] = L.toLatLon(size, size);
  const end = new Date(refDate.getTime()), start = new Date(refDate.getTime() - 60 * 864e5);
  const body = {
    collections: ["sentinel-2-l2a"], bbox: [w, s, e, n], datetime: `${start.toISOString()}/${end.toISOString()}`, limit: 8,
    query: { "eo:cloud_cover": { lt: 60 } }, sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }],
  };
  const r = await fetch("https://earth-search.aws.element84.com/v1/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`earth-search ${r.status}`);
  const items = ((await r.json()) as { features: StacItem[] }).features ?? [];
  if (!items.length) return null;
  // Prefer the last 30 days, then fall back to the full 60: the season should
  // be the current one.
  const recent = (it: StacItem) => new Date(it.properties.datetime).getTime() > refDate.getTime() - 30 * 864e5;
  items.sort((a, b) => (Number(recent(b)) - Number(recent(a))) || a.properties["eo:cloud_cover"] - b.properties["eo:cloud_cover"]);
  const N = Math.ceil(size / res), cnt = N * N;
  const R = new Uint8Array(cnt), G = new Uint8Array(cnt), B = new Uint8Array(cnt), clear = new Uint8Array(cnt), snow = new Uint8Array(cnt), bare = new Uint8Array(cnt);
  const used: string[] = [];
  for (const it of items.slice(0, 3)) {
    const zone = it.properties["proj:code"] ? parseInt(String(it.properties["proj:code"]).slice(-2)) : it.properties["mgrs:utm_zone"];
    const epsg = String(it.properties["proj:code"] ?? it.properties["proj:epsg"] ?? "");
    const south = epsg.includes("327") || it.properties["mgrs:latitude_band"] < "N";
    const toNative = (x: number, y: number) => { const [la, lo] = L.toLatLon(x, y); return toUTM(la, lo, zone, south); };
    // True colour plus the scene classification, which already separates
    // vegetation (4) from bare soil (5) and snow (11): the vegetation index
    // the PRD names, precomputed by ESA, for half the reads.
    const [tci, scl] = await Promise.all([
      open(it.assets.visual.href).then(t => t.getImage(0)),
      open(it.assets.scl.href).then(t => t.getImage(0)),
    ]);
    const [[r8, g8, b8], [sc]] = await Promise.all([
      sampleImage(tci, size, res, toNative, [0, 1, 2], 0),
      sampleImage(scl, size, res, toNative, [0], 0),
    ]);
    used.push(it.id);
    let missing = 0;
    for (let k = 0; k < cnt; k++) {
      if (clear[k]) continue;
      const c = sc[k];
      // scene classes: 0 nodata, 1 saturated, 3 cloud shadow, 8/9 cloud, 10 cirrus
      if (c === 0 || c === 1 || c === 3 || c === 8 || c === 9 || c === 10 || (r8[k] === 0 && g8[k] === 0 && b8[k] === 0)) { missing++; continue; }
      R[k] = r8[k]; G[k] = g8[k]; B[k] = b8[k]; clear[k] = 1; snow[k] = c === 11 ? 1 : 0; bare[k] = c === 5 ? 1 : 0;
    }
    if (missing / cnt < 0.03) break;
  }
  let nclear = 0; for (let k = 0; k < cnt; k++) nclear += clear[k];
  const g8 = (d: Uint8Array): Grid<Uint8Array> => ({ w: N, h: N, res, data: d });
  const month = items[0].properties.datetime.slice(0, 7);
  return { rgb: [g8(R), g8(G), g8(B)], clear: g8(clear), snow: g8(snow), bare: g8(bare), items: used, month, cloudFraction: 1 - nclear / cnt };
}

// ---------- Meta / WRI canopy height (1 m, quadkey zoom-9 tiles) ----------
export async function fetchCanopy(L: Local, size: number, res: number): Promise<Grid<Float32Array> | null> {
  const n = Math.ceil(size / res), out = new Float32Array(n * n);
  const keys = new Set<string>();
  for (const [x, y] of [[0, 0], [size, 0], [0, size], [size, size]]) {
    const [la, lo] = L.toLatLon(x, y);
    keys.add(quadkey(Math.floor(lonToTileX(lo, 9)), Math.floor(latToTileY(la, 9)), 9));
  }
  let found = false;
  for (const q of keys) {
    const url = `https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/${q}.tif`;
    let img: GeoTIFFImage;
    try { img = await (await open(url)).getImage(0); } catch { continue; }
    found = true;
    // Max-pool the 1.2 m pixels into the grid so no crown peak is skipped.
    // Over 5 km the mercator-to-local map is affine to a few centimetres.
    const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution(), W = img.getWidth(), H = img.getHeight();
    const toPx = (x: number, y: number) => { const [la, lo] = L.toLatLon(x, y); return [(mercX(lo) - ox) / rx, (mercY(la) - oy) / ry]; };
    const c00 = toPx(0, 0), c10 = toPx(size, 0), c01 = toPx(0, size);
    const wx0 = Math.max(0, Math.floor(Math.min(c00[0], c01[0])) - 1), wx1 = Math.min(W, Math.ceil(Math.max(c10[0], c00[0])) + 1);
    const wy0 = Math.max(0, Math.floor(Math.min(c01[1], c00[1])) - 1), wy1 = Math.min(H, Math.ceil(Math.max(c00[1], c10[1])) + 1);
    if (wx1 <= wx0 || wy1 <= wy0) continue;
    const [band] = (await img.readRasters({ window: [wx0, wy0, wx1, wy1], samples: [0], interleave: false })) as unknown as ArrayLike<number>[];
    const ww = wx1 - wx0;
    // invert the affine pixel = c00 + x/size*(c10-c00) + y/size*(c01-c00)
    const ax = (c10[0] - c00[0]) / size, ay = (c01[0] - c00[0]) / size, bx = (c10[1] - c00[1]) / size, by = (c01[1] - c00[1]) / size;
    const det = ax * by - ay * bx;
    for (let py = wy0; py < wy1; py++) for (let px = wx0; px < wx1; px++) {
      const v = band[(py - wy0) * ww + (px - wx0)]; if (!v || v > 120) continue;
      const dx = px + 0.5 - c00[0], dy = py + 0.5 - c00[1];
      const x = (by * dx - ay * dy) / det, y = (-bx * dx + ax * dy) / det;
      const i = Math.floor(x / res), j = Math.floor(y / res);
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      if (v > out[j * n + i]) out[j * n + i] = v;
    }
  }
  return found ? { w: n, h: n, res, data: out } : null;
}
