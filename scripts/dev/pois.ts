import { latLngToCell, cellToLatLng } from "h3-js";
import { bboxOf, localFrame } from "../../shared/geo.ts";
import { fetchOSM } from "../../builder/src/sources/ofm.ts";
const [lat, lon] = process.argv[2].split(",").map(Number); const r = +(process.argv[3] ?? 300);
const L = localFrame(lat, lon, 2000); const osm = await fetchOSM(L, bboxOf(L, 2000), 14);
for (const p of osm.pois.filter(p => p.name && Math.hypot(p.x - 1000, p.y - 1000) < r).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)).slice(0, 25)) console.log(p.cls, p.sub, JSON.stringify(p.name), p.rank, Math.round(Math.hypot(p.x - 1000, p.y - 1000)));
for (const p of osm.park) console.log("park-layer", p.cls, p.name);
