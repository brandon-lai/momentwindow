// Small geodesy: a local tangent plane in metres around a point, web
// mercator tile maths, quadkeys and UTM. Accurate to well under a metre over
// the 5 km squares Moment paints, which is all it is asked to do.

const R = 6378137;
const D2R = Math.PI / 180;

export interface Local {
  lat0: number; lon0: number; x0: number; y0: number;
  toXY(lat: number, lon: number): [number, number];
  toLatLon(x: number, y: number): [number, number];
}

// Origin (0,0) is the south-west corner of a square of side `size` centred on
// (lat0, lon0).
export function localFrame(lat0: number, lon0: number, size: number): Local {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * D2R) + 1.175 * Math.cos(4 * lat0 * D2R);
  const mPerDegLon = 111412.84 * Math.cos(lat0 * D2R) - 93.5 * Math.cos(3 * lat0 * D2R);
  const half = size / 2;
  return {
    lat0, lon0, x0: half, y0: half,
    toXY: (lat, lon) => [(lon - lon0) * mPerDegLon + half, (lat - lat0) * mPerDegLat + half],
    toLatLon: (x, y) => [lat0 + (y - half) / mPerDegLat, lon0 + (x - half) / mPerDegLon],
  };
}

export function bboxOf(L: Local, size: number, margin = 0): { s: number; w: number; n: number; e: number } {
  const [s, w] = L.toLatLon(-margin, -margin), [n, e] = L.toLatLon(size + margin, size + margin);
  return { s, w, n, e };
}

// web mercator tiles
export function lonToTileX(lon: number, z: number) { return ((lon + 180) / 360) * 2 ** z; }
export function latToTileY(lat: number, z: number) {
  const r = lat * D2R;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
export function tileXToLon(x: number, z: number) { return (x / 2 ** z) * 360 - 180; }
export function tileYToLat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return Math.atan(Math.sinh(n)) / D2R;
}
export function tilesFor(b: { s: number; w: number; n: number; e: number }, z: number): [number, number][] {
  const x0 = Math.floor(lonToTileX(b.w, z)), x1 = Math.floor(lonToTileX(b.e, z));
  const y0 = Math.floor(latToTileY(b.n, z)), y1 = Math.floor(latToTileY(b.s, z));
  const out: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([x, y]);
  return out;
}
export function quadkey(x: number, y: number, z: number): string {
  let q = "";
  for (let i = z; i > 0; i--) {
    let d = 0; const m = 1 << (i - 1);
    if (x & m) d += 1;
    if (y & m) d += 2;
    q += d;
  }
  return q;
}
export function mercX(lon: number) { return R * lon * D2R; }
export function mercY(lat: number) { return R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)); }

// UTM forward (WGS84), for reading Sentinel-2 tiles in their native grid.
export function toUTM(lat: number, lon: number, zone: number, south: boolean): [number, number] {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = lat * D2R, lam = (lon - lon0) * D2R;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * lam;
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let y = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (south) y += 10000000;
  return [x, y];
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(s));
}
