// Pre-builds the scenes visitors are most likely to land on, so most first
// visits hit the cache (PRD: "pre-build the 500 most populated cells").
// Population source: GeoNames cities15000 (CC BY 4.0). IP geolocation
// reports a city's coordinates, so the city-centre cell is the one most of a
// city's visitors arrive at.
//   node --experimental-strip-types scripts/prebuild.ts [base] [count] [concurrency]
import fs from "node:fs";
import { latLngToCell } from "h3-js";

const base = process.argv[2] ?? "https://momentwindow.flockfield-server.workers.dev";
const count = Number(process.argv[3] ?? 500), conc = Number(process.argv[4] ?? 3);
const file = process.env.CITIES ?? "/tmp/cities15000.txt";
const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const cities = lines.map(l => { const f = l.split("\t"); return { name: f[2], lat: +f[4], lon: +f[5], cc: f[8], pop: +f[14] }; }).sort((a, b) => b.pop - a.pop);
const seen = new Set<string>(); const todo: { name: string; cc: string; cell: string }[] = [];
for (const c of cities) { const cell = latLngToCell(c.lat, c.lon, 8); if (seen.has(cell)) continue; seen.add(cell); todo.push({ name: c.name, cc: c.cc, cell }); if (todo.length >= count) break; }
const log = fs.createWriteStream(process.env.LOG ?? "/tmp/mw-prebuild.jsonl", { flags: "a" });
let i = 0, ok = 0, hit = 0, fail = 0; const t0 = Date.now();
async function worker() {
  while (i < todo.length) {
    const job = todo[i++]; const s = Date.now();
    try {
      const r = await fetch(`${base}/scene/${job.cell}`, { signal: AbortSignal.timeout(120000) });
      const cache = r.headers.get("x-moment-cache"); const body = await r.text();
      const last = body.trim().split("\n").pop() ?? ""; let label = "";
      try { const j = JSON.parse(last); label = j.label ?? j.error ?? ""; if (j.error) throw new Error(j.error); } catch (e) { throw new Error(r.status + " " + String((e as Error).message).slice(0, 120)); }
      if (cache === "hit") hit++; else ok++;
      log.write(JSON.stringify({ ...job, status: r.status, cache, ms: Date.now() - s, bytes: body.length, label }) + "\n");
    } catch (e) { fail++; log.write(JSON.stringify({ ...job, error: String((e as Error).message) }) + "\n"); }
    if ((ok + hit + fail) % 10 === 0) console.log(`${ok + hit + fail}/${todo.length} built ${ok} cached ${hit} failed ${fail} · ${Math.round((Date.now() - t0) / 1000)} s`);
  }
}
await Promise.all(Array.from({ length: conc }, worker));
console.log(`done: built ${ok}, already cached ${hit}, failed ${fail}, ${Math.round((Date.now() - t0) / 1000)} s`);
