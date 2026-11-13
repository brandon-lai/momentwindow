// Builds one scene bundle locally and reports what went into it.
//   node --experimental-strip-types scripts/build-place.ts battery [YYYY-MM-DD]
//   node --experimental-strip-types scripts/build-place.ts 40.703,-74.016
import fs from "node:fs";
import zlib from "node:zlib";
import { latLngToCell } from "h3-js";
import { TEST_PLACES } from "../shared/places.ts";
import { buildScene } from "../builder/src/build.ts";

async function main() {
  const arg = process.argv[2] ?? "battery";
  const date = process.argv[3] ? new Date(process.argv[3] + "T12:00:00Z") : undefined;
  const tp = TEST_PLACES.find(p => p.id === arg);
  const [lat, lon] = tp ? [tp.lat, tp.lon] : arg.split(",").map(Number);
  const cell = latLngToCell(lat, lon, 8);
  const t0 = Date.now(); let liteAt = 0;
  const b = await buildScene(cell, { date, log: m => console.log("  ", m), onLite: () => { liteAt = Date.now() - t0; } });
  const json = JSON.stringify(b);
  const gz = zlib.gzipSync(json).length;
  const out = process.env.OUT ?? `/tmp/mw-${tp?.id ?? cell}${date ? "-" + process.argv[3] : ""}.json`;
  fs.writeFileSync(out, json);
  console.log(JSON.stringify({ place: tp?.id ?? arg, cell, label: b.label, kind: b.view.kind, heading: b.heading, feature: b.feature, liteMs: liteAt, totalMs: Date.now() - t0, gzKB: Math.round(gz / 1024), counts: { water: b.water.length, land: b.land.length, roads: b.roads.length, rail: b.rail.length, ferries: b.ferries.length, covers: b.covers.length, buildings: b.buildings.length, trees: b.trees.length, canals: b.spawn.canals.length, openWater: b.spawn.openWater.length }, distant: b.distant, sample: b.sample, sources: b.built.sources, notes: b.built.notes, out }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
