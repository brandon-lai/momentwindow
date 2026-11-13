import fs from "node:fs";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
const buf = fs.readFileSync(process.argv[2]);
const t = new VectorTile(new Pbf(buf));
for (const [name, layer] of Object.entries(t.layers)) {
  const keys = {}; const classes = {};
  for (let i = 0; i < layer.length; i++) { const f = layer.feature(i); for (const [k, v] of Object.entries(f.properties)) { if (k.startsWith("name:")) continue; keys[k] = (keys[k] || 0) + 1; if (k === "class" || k === "subclass") classes[`${k}=${v}`] = (classes[`${k}=${v}`] || 0) + 1; } }
  console.log(`${name} n=${layer.length} extent=${layer.extent} keys=${Object.keys(keys).join(",")}`);
  console.log("   ", Object.entries(classes).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([k,v])=>`${k}:${v}`).join(" "));
}
const b = t.layers.building; if (b) { for (let i = 0; i < 5; i++) console.log("bld", JSON.stringify(b.feature(i).properties)); }
const p = t.layers.poi; if (p) { for (let i = 0; i < Math.min(p.length, 12); i++) { const f=p.feature(i).properties; console.log("poi", f.class, f.subclass, f.name, f.rank); } }
