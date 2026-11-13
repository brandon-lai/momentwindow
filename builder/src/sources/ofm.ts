// OpenStreetMap vector data via OpenFreeMap (OpenMapTiles schema). Each tile
// is decoded into local metres and clipped to its own exact bounds, so the
// buffer every vector tile carries does not duplicate features where tiles
// meet.
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { Pt, Ring } from "../../../shared/bundle.ts";
import { type Local, tileXToLon, tileYToLat, tilesFor } from "../../../shared/geo.ts";
import { clipLine, clipRing } from "../geom.ts";

export interface OsmPoly { rings: Ring[]; cls: string; sub?: string; name?: string }
export interface OsmLine { pts: Pt[]; cls: string; sub?: string; brunnel?: string; name?: string; layer?: number }
export interface OsmBuilding { rings: Ring[]; h: number; minH: number; colour?: string; hide?: boolean }
export interface OsmPoint { x: number; y: number; cls: string; sub?: string; name?: string; rank?: number }
export interface OsmData {
  water: OsmPoly[]; landcover: OsmPoly[]; landuse: OsmPoly[]; park: OsmPoly[]; piers: OsmPoly[]; areas: OsmPoly[];
  transport: OsmLine[]; waterways: OsmLine[]; names: OsmLine[];
  buildings: OsmBuilding[]; pois: OsmPoint[]; places: OsmPoint[];
  tiles: number; bytes: number;
}

const UA = "Moment/1.0 (+https://github.com/brandon-lai/momentwindow; scene builder)";
let template: { url: string; at: number } | null = null;

async function tileTemplate(): Promise<string> {
  if (template && Date.now() - template.at < 6 * 3600e3) return template.url;
  const r = await fetch("https://tiles.openfreemap.org/planet", { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`openfreemap tilejson ${r.status}`);
  const j = (await r.json()) as { tiles: string[] };
  template = { url: j.tiles[0], at: Date.now() };
  return template.url;
}

const cache = new Map<string, Promise<ArrayBuffer | null>>();
async function getTile(z: number, x: number, y: number): Promise<ArrayBuffer | null> {
  const tpl = await tileTemplate();
  const key = `${tpl}|${z}/${x}/${y}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await fetch(tpl.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(12000) }).catch(() => null);
        if (r && r.status === 404) return null;
        if (r && r.ok) return r.arrayBuffer();
        await new Promise(res => setTimeout(res, 300 * (attempt + 1)));
      }
      throw new Error(`openfreemap tile ${z}/${x}/${y} failed`);
    })());
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
  }
  return cache.get(key)!;
}

type GJGeom = { type: string; coordinates: any };

export async function fetchOSM(L: Local, bb: { s: number; w: number; n: number; e: number }, z: number): Promise<OsmData> {
  const tiles = tilesFor(bb, z);
  const out: OsmData = { water: [], landcover: [], landuse: [], park: [], piers: [], areas: [], transport: [], waterways: [], names: [], buildings: [], pois: [], places: [], tiles: tiles.length, bytes: 0 };
  const bufs = await Promise.all(tiles.map(([x, y]) => getTile(z, x, y)));
  tiles.forEach(([tx, ty], k) => {
    const buf = bufs[k]; if (!buf) return;
    out.bytes += buf.byteLength;
    const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
    // tile bounds in local metres
    const [x0, y1] = L.toXY(tileYToLat(ty, z), tileXToLon(tx, z));
    const [x1, y0] = L.toXY(tileYToLat(ty + 1, z), tileXToLon(tx + 1, z));
    const P = (c: [number, number]): Pt => L.toXY(c[1], c[0]);
    const polys = (g: GJGeom): Ring[][] => {
      const list: number[][][][] = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      const res: Ring[][] = [];
      for (const poly of list) {
        const rings = poly.map(r => clipRing(r.map(c => P(c as [number, number])), x0, y0, x1, y1)).filter(r => r.length >= 3);
        if (rings.length && poly.length) res.push(rings);
      }
      return res;
    };
    const lines = (g: GJGeom): Pt[][] => {
      const list: number[][][] = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      return list.flatMap(l => clipLine(l.map(c => P(c as [number, number])), x0, y0, x1, y1));
    };
    const points = (g: GJGeom): Pt[] => {
      const list: number[][] = g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" ? g.coordinates : [];
      return list.map(c => P(c as [number, number])).filter(([x, y]) => x >= x0 && x < x1 && y >= y0 && y < y1);
    };
    const each = (name: string, fn: (f: { properties: Record<string, any>; geometry: GJGeom }) => void) => {
      const layer = vt.layers[name]; if (!layer) return;
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i).toGeoJSON(tx, ty, z) as any;
        fn(f);
      }
    };
    // a name the label can show: English, then Latin script, then nothing
    // (the label falls back to a place name rather than print a script the
    // handwriting font cannot draw)
    const latin = (v: unknown) => typeof v === "string" && /[A-Za-z\u00C0-\u024F]/.test(v) ? v : undefined;
    const nm = (p: Record<string, any>) => latin(p["name:en"]) || latin(p.name_en) || latin(p["name:latin"]) || latin(p.name_int) || latin(p.name) || undefined;
    each("water", f => { for (const rings of polys(f.geometry)) out.water.push({ rings, cls: f.properties.class, sub: f.properties.intermittent ? "intermittent" : undefined }); });
    each("landcover", f => { for (const rings of polys(f.geometry)) out.landcover.push({ rings, cls: f.properties.class, sub: f.properties.subclass }); });
    each("landuse", f => { for (const rings of polys(f.geometry)) out.landuse.push({ rings, cls: f.properties.class }); });
    each("park", f => { for (const rings of polys(f.geometry)) out.park.push({ rings, cls: f.properties.class, name: nm(f.properties) }); });
    each("building", f => {
      const p = f.properties;
      for (const rings of polys(f.geometry)) out.buildings.push({ rings, h: +p.render_height || 0, minH: +p.render_min_height || 0, colour: p.colour, hide: !!p.hide_3d });
    });
    each("transportation", f => {
      const p = f.properties;
      if (f.geometry.type.endsWith("Polygon")) {
        for (const rings of polys(f.geometry)) (p.class === "pier" ? out.piers : out.areas).push({ rings, cls: p.class, sub: p.subclass });
        return;
      }
      for (const pts of lines(f.geometry)) out.transport.push({ pts, cls: p.class, sub: p.subclass, brunnel: p.brunnel, layer: p.layer });
    });
    each("transportation_name", f => { for (const pts of lines(f.geometry)) out.names.push({ pts, cls: f.properties.class, sub: f.properties.subclass, name: nm(f.properties) }); });
    each("waterway", f => { for (const pts of lines(f.geometry)) out.waterways.push({ pts, cls: f.properties.class, brunnel: f.properties.brunnel, name: nm(f.properties) }); });
    each("poi", f => { for (const [x, y] of points(f.geometry)) out.pois.push({ x, y, cls: f.properties.class, sub: f.properties.subclass, name: nm(f.properties), rank: f.properties.rank }); });
    each("place", f => { for (const [x, y] of points(f.geometry)) out.places.push({ x, y, cls: f.properties.class, name: nm(f.properties), rank: f.properties.rank }); });
  });
  return out;
}
