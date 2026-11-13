// The PRD's regression set: every test place at noon, golden hour and one
// hour after sunset (local), painted in a real browser and screenshotted.
//   node --experimental-strip-types scripts/regress.ts [base] [ids] [times]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { TEST_PLACES } from "../shared/places.ts";
import { sunPos } from "../client/src/paint/util.ts";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const ids = (process.argv[3] ?? "").split(",").filter(Boolean);
const times = (process.argv[4] ?? "noon,golden,night").split(",");
const day = process.env.DAY ?? "2026-11-12";
const out = process.env.OUT ?? "/tmp/mw-regress";
fs.mkdirSync(out, { recursive: true });

function when(lat: number, lon: number, kind: string): string {
  const t0 = Date.parse(day + "T00:00:00Z") - (lon / 15) * 3600e3; // local midnight, roughly
  const samples: [number, number][] = [];
  for (let m = 0; m < 24 * 60; m += 2) { const t = t0 + m * 60e3; samples.push([t, sunPos(t, lat, lon).alt]); }
  if (kind === "noon") return new Date(samples.reduce((a, b) => (b[1] > a[1] ? b : a))[0]).toISOString();
  const noonI = samples.findIndex(s => s === samples.reduce((a, b) => (b[1] > a[1] ? b : a)));
  const after = samples.slice(noonI);
  if (kind === "golden") return new Date((after.find(s => s[1] < 8) ?? after[after.length - 1])[0]).toISOString();
  const set = after.find(s => s[1] < 0) ?? after[after.length - 1];
  return new Date(set[0] + 3600e3).toISOString();
}

const rows: unknown[] = [];
for (const p of TEST_PLACES.filter(p => !ids.length || ids.includes(p.id))) for (const k of times) {
  const at = when(p.lat, p.lon, k);
  const extra = process.env.Q ? "&" + process.env.Q : "";
  const url = `${base}/?place=${p.id}&at=${encodeURIComponent(at)}${extra}`;
  const shot = `${out}/${p.id}-${k}.png`;
  const r = spawnSync("node", ["scripts/probe.mjs", url, 'JSON.stringify({marks: window.__moment.marks, line: document.getElementById("line").textContent, status: document.getElementById("status").textContent, t: window.__moment.meta && window.__moment.meta.timings})', "1400", "1000"], { env: { ...process.env, SHOT: shot, SETTLE_MS: process.env.SETTLE_MS ?? "16000", HEADFUL: process.env.HEADFUL ?? "1" }, encoding: "utf8", timeout: 180000 });
  const line = (r.stdout || "").trim().split("\n").pop() ?? "";
  let res: any = null; try { res = JSON.parse(JSON.parse(line)); } catch { res = { raw: line.slice(0, 300), err: (r.stderr || "").slice(0, 300) }; }
  rows.push({ id: p.id, k, at, shot, ...res });
  console.log(p.id.padEnd(12), k.padEnd(7), at, res?.marks?.painted ?? "-", "ms painted |", res?.line ?? res?.status ?? res?.raw);
}
fs.writeFileSync(`${out}/results.json`, JSON.stringify(rows, null, 1));
