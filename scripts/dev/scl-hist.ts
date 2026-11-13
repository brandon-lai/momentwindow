import { fromUrl } from "geotiff";
import { localFrame, toUTM } from "../../shared/geo.ts";
const [lat, lon] = [46.624, 8.034];
const r = await fetch("https://earth-search.aws.element84.com/v1/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collections: ["sentinel-2-l2a"], bbox: [lon - .02, lat - .02, lon + .02, lat + .02], datetime: "2025-12-20T00:00:00Z/2026-01-20T00:00:00Z", limit: 10, query: { "eo:cloud_cover": { lt: 60 } }, sortby: [{ field: "properties.eo:cloud_cover", direction: "asc" }] }) });
const items = (await r.json()).features;
for (const it of items.slice(0, 4)) {
  const img = await (await fromUrl(it.assets.scl.href)).getImage(0);
  const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const [x, y] = toUTM(lat, lon, 32, false);
  const px = Math.floor((x - ox) / rx), py = Math.floor((y - oy) / ry), h = 60;
  const [band] = await img.readRasters({ window: [px - h, py - h, px + h, py + h], samples: [0], interleave: false }) as any;
  const hist: Record<number, number> = {}; for (const v of band) hist[v] = (hist[v] || 0) + 1;
  const tot = band.length;
  console.log(it.id, "cloud", it.properties["eo:cloud_cover"].toFixed(1), Object.entries(hist).map(([k, v]) => `${k}:${Math.round(100 * (v as number) / tot)}%`).join(" "));
}
