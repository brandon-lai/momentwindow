// Trees the bundle placed inside a 200 m square (centred on lat,lon), and
// that square's bounds, for comparing against a hand count on an aerial photo.
import fs from "node:fs";
import { localFrame } from "../../shared/geo.ts";
const [file, ll] = [process.argv[2], process.argv[3]];
const b = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop()!);
const S = b.size[0], L = localFrame(b.centre[0], b.centre[1], S);
const [cx, cy] = L.toXY(...(ll.split(",").map(Number) as [number, number]));
const x0 = cx - 100, y0 = cy - 100;
const n = b.trees.filter((t: any) => t.x >= x0 && t.x < x0 + 200 && t.y >= y0 && t.y < y0 + 200).length;
const [s, w] = L.toLatLon(x0, y0), [nn, e] = L.toLatLon(x0 + 200, y0 + 200);
console.log(JSON.stringify({ trees: n, inBundle: b.trees.length, bbox: [w, s, e, nn].map(v => +v.toFixed(6)) }));
