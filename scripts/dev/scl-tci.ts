import { fromUrl } from "geotiff";
import { toUTM } from "../../shared/geo.ts";
const [lat, lon] = [46.624, 8.034];
const base = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/T/MS/2025/12/S2C_32TMS_20251231_0_L2A/";
const scl = await (await fromUrl(base + "SCL.tif")).getImage(0), tci = await (await fromUrl(base + "TCI.tif")).getImage(0);
const [x, y] = toUTM(lat, lon, 32, false);
const s0 = scl.getOrigin(), t0 = tci.getOrigin();
const h = 50; // 20 m pixels -> 2 km
const spx = Math.floor((x - s0[0]) / 20), spy = Math.floor((s0[1] - y) / 20);
const [sb] = await scl.readRasters({ window: [spx - h, spy - h, spx + h, spy + h], samples: [0], interleave: false }) as any;
const tpx = Math.floor((x - t0[0]) / 10), tpy = Math.floor((t0[1] - y) / 10);
const tb = await tci.readRasters({ window: [tpx - 2 * h, tpy - 2 * h, tpx + 2 * h, tpy + 2 * h], samples: [0, 1, 2], interleave: false }) as any;
const buckets: Record<string, number> = {};
for (let j = 0; j < 2 * h; j++) for (let i = 0; i < 2 * h; i++) {
  if (sb[j * 2 * h + i] !== 2) continue;
  const k = (2 * j) * 4 * h + 2 * i; const r = tb[0][k], g = tb[1][k], b = tb[2][k];
  const key = `${Math.floor((r + g + b) / 3 / 20) * 20}|${b >= r ? "b>=r" : "r>b"}|${Math.abs(r - g) < 22 ? "neutral" : "tinted"}`;
  buckets[key] = (buckets[key] || 0) + 1;
}
console.log(Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join("  "));
