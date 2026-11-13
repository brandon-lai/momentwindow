// Famous landmarks, painted at local early afternoon and screenshotted: the
// recognisability set for big cities.
//   node --experimental-strip-types scripts/landmarks-regress.ts [base] [ids]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { latLngToCell } from "h3-js";

export const LANDMARKS: [string, number, number][] = [
  ["eiffel", 48.8584, 2.2945], ["westminster", 51.5007, -0.1246], ["towerbridge", 51.5055, -0.0754], ["empirestate", 40.7484, -73.9857],
  ["goldengate", 37.8199, -122.4783], ["operahouse", -33.8568, 151.2153], ["tokyotower", 35.6586, 139.7454], ["colosseum", 41.8902, 12.4922],
  ["liberty", 40.6892, -74.0445], ["cntower", 43.6426, -79.3871], ["notredame", 48.8530, 2.3499], ["stpauls", 51.5138, -0.0984],
];
const base = process.argv[2] ?? "http://127.0.0.1:8787", ids = (process.argv[3] ?? "").split(",").filter(Boolean);
const out = process.env.OUT ?? "/tmp/mw-landmarks"; fs.mkdirSync(out, { recursive: true });
for (const [id, lat, lon] of LANDMARKS.filter(l => !ids.length || ids.includes(l[0]))) {
  const at = new Date(Date.UTC(2026, 5, 21, 13) - (lon / 15) * 3600e3).toISOString(); // about 1 p.m. local in June
  const url = `${base}/?cell=${latLngToCell(lat, lon, 8)}&at=${encodeURIComponent(at)}&weather=clear`;
  const r = spawnSync("node", ["scripts/probe.mjs", url, 'JSON.stringify({line: document.getElementById("line").textContent, lms: (window.__moment.bundle && window.__moment.bundle.landmarks || []).map(l => l.name + ":" + l.kind).join(", "), painted: window.__moment.marks.painted})', "1400", "1000"], { env: { ...process.env, SHOT: `${out}/${id}.png`, SETTLE_MS: process.env.SETTLE_MS ?? "30000", HEADFUL: "1", PROBE_TIMEOUT_MS: "90000" }, encoding: "utf8", timeout: 120000 });
  console.log(id.padEnd(12), (r.stdout || "").trim().split("\n").pop()?.slice(0, 400));
}
