import { cellToBoundary, cellToLatLng, latLngToCell } from "h3-js";
import { bboxOf, localFrame } from "../../shared/geo.ts";
import { fetchOSM } from "../../builder/src/sources/ofm.ts";
import { pickFeature, waterGrid } from "../../builder/src/snap.ts";
const [lat, lon] = process.argv[2].split(",").map(Number);
const cell = latLngToCell(lat, lon, 8); const [clat, clon] = cellToLatLng(cell);
const PS = 2400, P = localFrame(clat, clon, PS);
const osm = await fetchOSM(P, bboxOf(P, PS), 14);
const ring = cellToBoundary(cell).map(([a, b]) => P.toXY(a, b));
console.log("cell", cell, "centre", clat, clon, "ring", ring.map(p => p.map(Math.round).join(",")).join(" "));
const s = pickFeature(osm, ring, PS);
console.log(s, P.toLatLon(s.x, s.y));
const W = waterGrid(osm, PS, 60);
let rows = []; for (let j = W.n - 1; j >= 0; j -= 1) { let r = ""; for (let i = 0; i < W.n; i++) { const x = (i + .5) * 60, y = (j + .5) * 60; const inC = ring.length && require0(x, y); r += W.g[j * W.n + i] ? "~" : inC ? "o" : "."; } rows.push(r); }
function require0(x: number, y: number) { let c = false; for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) { const [xi, yi] = ring[i], [xk, yk] = ring[k]; if ((yi > y) !== (yk > y) && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) c = !c; } return c; }
console.log(rows.join("\n"));
// heading scores at the chosen point
{
  const W2 = waterGrid(osm, PS, 20);
  const pts = [[s.x, s.y], [1440, 840], [1300, 760]];
  for (const [x, y] of pts) {
    const wedge = (th: number, d0: number, d1: number, f: (u: number, v: number) => boolean) => { let n = 0, hit = 0; for (let a = -3; a <= 3; a++) { const t = th + (a / 3) * (Math.PI / 5); for (let d = d0; d <= d1; d += 40) { n++; if (f(x + Math.cos(t) * d, y + Math.sin(t) * d)) hit++; } } return hit / n; };
    const out: string[] = [];
    for (const [h, th] of [["N", Math.PI / 2], ["E", 0], ["S", -Math.PI / 2], ["W", Math.PI]] as [string, number][]) out.push(`${h}: wF ${wedge(th + Math.PI, 40, 480, W2.at).toFixed(2)} landA ${wedge(th, 80, 880, (u, v) => !W2.at(u, v)).toFixed(2)}`);
    console.log(x.toFixed(0), y.toFixed(0), W2.at(x, y) ? "WET" : "dry", out.join(" | "));
  }
}
