// Elevation from the Terrain Tiles on AWS (Mapzen/Tilezen terrarium PNGs,
// no account). Returns a sampler over latitude/longitude, bilinear.
import { PNG } from "pngjs";
import { latToTileY, lonToTileX, tilesFor } from "../../../shared/geo.ts";

const cache = new Map<string, Promise<Float32Array | null>>();

async function tile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const key = `${z}/${x}/${y}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
      if (!r.ok) return null;
      const png = PNG.sync.read(Buffer.from(await r.arrayBuffer()));
      const out = new Float32Array(256 * 256);
      for (let i = 0; i < 256 * 256; i++) out[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
      return out;
    })());
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return cache.get(key)!;
}

export interface Elevation { at(lat: number, lon: number): number; z: number }

export async function fetchElevation(bb: { s: number; w: number; n: number; e: number }, z: number): Promise<Elevation> {
  const list = tilesFor(bb, z);
  const data = new Map<string, Float32Array | null>();
  await Promise.all(list.map(async ([x, y]) => data.set(`${x}/${y}`, await tile(z, x, y))));
  const px = (lat: number, lon: number) => [lonToTileX(lon, z) * 256 - 0.5, latToTileY(lat, z) * 256 - 0.5];
  const sample = (gx: number, gy: number): number => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = data.get(`${tx}/${ty}`); if (!t) return 0;
    const ix = Math.min(255, Math.max(0, gx - tx * 256)), iy = Math.min(255, Math.max(0, gy - ty * 256));
    return t[iy * 256 + ix];
  };
  return {
    z,
    at(lat, lon) {
      const [fx, fy] = px(lat, lon), x = Math.floor(fx), y = Math.floor(fy), u = fx - x, v = fy - y;
      const a = sample(x, y), b = sample(x + 1, y), c = sample(x, y + 1), d = sample(x + 1, y + 1);
      const h = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
      // Terrarium over the sea carries bathymetry; the painting wants a flat sea.
      return Math.max(h, -2);
    },
  };
}
