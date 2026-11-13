// A scene bundle turned into the painter's world: everything rotated so the
// camera looks along +y, shifted so the window is [0, W] x [0, D], and
// coloured from the palette with the satellite samples pulled in.
import type { Building, SceneBundle } from "../../../shared/bundle.ts";
import { decodeHeights } from "../../../shared/bundle.ts";
import { palette, type Pal } from "./palette.ts";
import { ccw, centroid, hex, minRect, mix, mul, mulberry32, norm3, polyArea, pull, type C3, type P2 } from "./util.ts";
import type { Moment } from "../moment.ts";

export interface WBuilding { p: P2[]; h: number; z0: number; roof: string; roofH: number; tone: C3; roofTone: C3; label: string; landmark: boolean; c: P2; i: number; house: boolean }
export interface WTree { x: number; y: number; r: number; h: number; kind: "deciduous" | "conifer"; tone: C3 }
export interface WCover { type: string; poly: P2[]; col: C3; angle?: number; crop?: string }
export interface WRoad { pts: P2[]; w: number; kind: string; lit?: boolean; bridge?: boolean }
export interface World {
  W: number; D: number; S: number; heading: string; kind: string; cc: string;
  pal: Pal; seed: number; moment: Moment;
  H: (x: number, y: number) => number; relief: number; baseShift: number; absBase: number; // metres from the bundle's terrain base to the window's lowest point
  water: P2[][][]; land: P2[][]; roads: WRoad[]; buildings: WBuilding[]; trees: WTree[]; covers: WCover[];
  ferries: P2[][]; canals: P2[][]; cables: P2[][]; openWater: P2[][]; parks: P2[][]; paths: P2[][]; pasture: P2[][];
  sunV: C3; reliefV: C3; reliefDif: number; shW: { dx: number; dy: number; perM: number };
  camPitch: number; farScreen: number; farFade: number; rock: boolean; signs: boolean; distant: string | null;
  beyond: { az: number; dist: number[]; h: number[] }[];
  waterAt?: (x: number, y: number) => boolean;
  toView: (x: number, y: number) => P2; label: string; feature: P2;
}

const ASIAN = new Set(["JP", "CN", "HK", "TW", "KR", "TH", "VN", "SG", "MY", "PH", "MO"]);
const HEAD_AZ: Record<string, number> = { N: 0, E: 90, S: 180, W: 270 };

export function buildWorld(b: SceneBundle, m: Moment, seed: number): World {
  const S = b.size[0], W = b.view.w, D = b.view.d, ox = (S - W) / 2, oy = (S - D) / 2;
  const h = b.heading;
  const rotV = (x: number, y: number): P2 => h === "N" ? [x, y] : h === "S" ? [S - x, S - y] : h === "E" ? [S - y, x] : [y, S - x];
  const toView = (x: number, y: number): P2 => { const [u, v] = rotV(x, y); return [u - ox, v - oy]; };
  const toNorth = (X: number, Y: number): P2 => { const u = X + ox, v = Y + oy; return h === "N" ? [u, v] : h === "S" ? [S - u, S - v] : h === "E" ? [v, S - u] : [S - v, u]; };
  const T = b.terrain, hs = decodeHeights(T.heights, T.cols * T.rows);
  const Hn = (x: number, y: number) => {
    const fi = Math.max(0, Math.min(T.cols - 1.001, x / T.spacing)), fj = Math.max(0, Math.min(T.rows - 1.001, y / T.spacing));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j, c = T.cols;
    return (hs[j * c + i] * (1 - u) * (1 - v) + hs[j * c + i + 1] * u * (1 - v) + hs[(j + 1) * c + i] * (1 - u) * v + hs[(j + 1) * c + i + 1] * u * v) / 10;
  };
  // heights relative to the lowest point under the window, so a flat city sits at 0
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j <= 20; j++) for (let i = 0; i <= 20; i++) { const [x, y] = toNorth(i / 20 * W, j / 20 * D); const v = Hn(x, y); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const H = (X: number, Y: number) => { const [x, y] = toNorth(X, Y); return Hn(x, y) - lo; };
  const relief = hi - lo;

  const pal = palette(m.key, m.snowOnGround && m.key !== "snow");
  const pv = (pts: number[][]): P2[] => pts.map(p => toView(p[0], p[1]));
  const sample = b.sample;
  // the satellite's ground and water tint the palette, 60/40
  if (sample?.ground && !pal.snow) { pal.ground = pull(sample.ground, pal.ground); pal.groundRose = pull(sample.ground, pal.groundRose, 0.7); }
  if (sample?.water) { pal.water = pull(sample.water, pal.water); pal.waterGreen = pull(sample.water, pal.waterGreen, 0.7); }

  // sun in the view frame
  const sun = m.sun, azr = ((sun.az - HEAD_AZ[h]) * Math.PI) / 180, alt = (Math.max(sun.alt, 2) * Math.PI) / 180;
  const sunV = norm3([Math.sin(azr) * Math.cos(alt), Math.cos(azr) * Math.cos(alt), Math.sin(alt)]);
  const flat = pal.dif < 0.25;
  const reliefV = flat ? norm3([-0.45, 0.45, 0.77]) : sunV;

  const tr = mulberry32(seed * 3 + 1), pick = <T,>(a: T[]) => a[Math.floor(tr() * a.length)];
  const buildings: WBuilding[] = [];
  b.buildings.forEach((q: Building, i) => {
    let p = ccw(pv(q.p));
    const area = Math.abs(polyArea(p));
    let roof = q.roof, roofH = q.roofH;
    if (roof === "gable") { const r = minRect(p); if (r.length === 4) p = r; else roof = "flat"; }
    const c = centroid(p);
    const total = q.h + q.minH;
    const facade = q.facadeColour ? hex(q.facadeColour) : null;
    let tone: C3 = total >= 120 ? pick(pal.glass) : total >= 35 ? pick(tr() < 0.25 ? pal.glass : pal.warm) : pick(tr() < 0.6 ? pal.pale : pal.warm);
    if (facade) tone = pull(facade, tone, 0.72);
    if (b.place.cc === "GR" || b.place.cc === "CY") tone = mix([250, 250, 246], tone, total > 12 ? 0.4 : 0.08); // whitewash
    const rc = q.roofColour ? hex(q.roofColour) : null;
    let roofTone: C3 = roof === "flat" ? mix(tone, pal.paper, 0.3) : mul(tone, 0.78);
    if (roof === "dome") roofTone = b.place.cc === "GR" || b.place.cc === "CY" ? [64, 108, 184] : [160, 168, 176];
    else if (rc) roofTone = pull(rc, roofTone, 0.55);
    if (pal.snow && roof !== "flat" && roof !== "dome") roofTone = [244, 246, 250];
    const kindLabel = q.cls ? q.cls.replace(/_/g, " ") : roof === "gable" && area < 300 ? "House" : total >= 150 ? "Tower" : total >= 40 ? "High-rise" : total >= 12 ? "Building" : "Low building";
    const label = q.name ? `${q.name} · ${Math.round(total + roofH)} m` : `${cap(kindLabel)} · ${Math.round(total + roofH)} m`;
    buildings.push({ p, h: q.h, z0: H(c[0], c[1]) + q.minH, roof, roofH: roof === "flat" ? 0 : roofH, tone, roofTone, label, landmark: !!q.name, c, i, house: roof === "gable" && area < 320 });
  });

  const autumnish = (c: number[]) => c[0] > c[1] * 1.02 && c[0] > 60;
  const trees: WTree[] = b.trees.map(t => {
    const [x, y] = toView(t.x, t.y);
    const kind = t.kind === "conifer" ? "conifer" : "deciduous";
    // pull toward the nearest palette tree colour, so autumn stays autumn
    const target = kind === "conifer" ? pal.treeDark : autumnish(t.colour) ? nearest(t.colour, pal.autumn) : pal.tree;
    return { x, y, r: t.r, h: t.h, kind, tone: pull(t.colour, target) };
  });

  const coverBase = (type: string): C3 => ({
    park: pal.grass, yard: mix(pal.grass, pal.ground, 0.45), grass: mix(pal.grass, pal.ground, 0.25), pasture: [150, 176, 96] as C3, field: [222, 196, 128] as C3,
    grove: [206, 188, 140] as C3, forest: mix(pal.treeDark, pal.tree, 0.4), sand: [236, 214, 170] as C3, rock: [160, 160, 166] as C3, snow: [242, 244, 250] as C3,
    wetland: pal.blueGreen, farmyard: [198, 170, 124] as C3, cemetery: mix(pal.grass, pal.olive, 0.5), pitch: mix(pal.grass, [120, 180, 110], 0.5), track: [196, 104, 80] as C3,
    plaza: [214, 206, 190] as C3, pool: [104, 196, 214] as C3, parking: [170, 170, 176] as C3, scrub: pal.olive, bare: [176, 140, 104] as C3,
  } as Record<string, C3>)[type] ?? pal.groundDark;
  const covers: WCover[] = b.covers.map(c => {
    const poly = pv(c.poly);
    let col = coverBase(c.type);
    let crop: string | undefined;
    if (c.colour && c.type !== "pool" && c.type !== "snow") col = pull(c.colour, col);
    if (c.type === "field") {
      const s = c.colour ?? [200, 180, 120];
      const g = s[1] / Math.max(1, (s[0] + s[2]) / 2);
      crop = g > 1.15 ? "pasture" : s[0] + s[1] + s[2] < 210 ? "plowed" : s[0] > s[2] * 1.4 ? "stubble" : "corn";
    }
    if (pal.snow && ["field", "pasture", "grass", "park", "yard", "bare", "farmyard", "scrub"].includes(c.type)) col = mix(col, [244, 246, 250], 0.82);
    // angles are in the north-up frame; turn them with the view
    const angle = c.angle !== undefined ? c.angle - (HEAD_AZ[h] * Math.PI) / 180 * -1 : undefined;
    return { type: c.type, poly, col, angle, crop };
  });

  const roads: WRoad[] = b.roads.map(r => ({ pts: pv(r.pts), w: r.w, kind: r.kind, lit: r.lit, bridge: r.bridge }));
  for (const r of b.rail) roads.push({ pts: pv(r.pts), w: r.kind === "rail" ? 9 : 6, kind: "rail" });

  const [fx, fy] = toView(b.feature.x, b.feature.y);
  return {
    W, D, S, heading: h, kind: b.view.kind, cc: b.place.cc, pal, seed, moment: m, H, relief, baseShift: lo, absBase: b.terrain.base,
    water: b.water.map(poly => poly.map(r => pv(r))), land: b.land.map(pv), roads, buildings, trees, covers,
    ferries: b.ferries.map(pv), canals: b.spawn.canals.map(pv), cables: (b.spawn.cables ?? []).map(pv), openWater: b.spawn.openWater.map(pv), parks: b.spawn.parks.map(pv), paths: b.spawn.paths.map(pv), pasture: b.spawn.pasture.map(pv),
    sunV, reliefV, reliefDif: flat ? 0.55 : Math.max(pal.dif, 0.45),
    shW: { dx: -Math.sin(azr), dy: -Math.cos(azr), perM: Math.min(1 / Math.tan(Math.max(sun.alt, 7) * Math.PI / 180), 6) },
    camPitch: b.view.pitch, farScreen: b.view.kind === "mountain" ? 0.24 : 0.2, farFade: b.view.kind === "mountain" ? 0.015 : 0.1, rock: b.view.kind === "mountain" || relief > 250,
    signs: b.view.kind === "dense" && ASIAN.has(b.place.cc), distant: b.distant, beyond: b.beyond,
    toView, label: b.label, feature: [fx, fy],
  };
}

function nearest(c: number[], list: C3[]): C3 { let best = list[0], bd = Infinity; for (const l of list) { const d = (l[0] - c[0]) ** 2 + (l[1] - c[1]) ** 2 + (l[2] - c[2]) ** 2; if (d < bd) { bd = d; best = l; } } return best; }
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
