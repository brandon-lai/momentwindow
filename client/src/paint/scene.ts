// A scene bundle turned into the painter's world: everything rotated so the
// camera looks along +y, shifted so the window is [0, W] x [0, D], and
// coloured from the palette with the satellite samples pulled in.
import type { Building, SceneBundle } from "../../../shared/bundle.ts";
import { decodeHeights } from "../../../shared/bundle.ts";
import { palette, type Pal } from "./palette.ts";
import { ccw, centroid, hex, minRect, mix, mul, mulberry32, norm3, polyArea, pull, type C3, type P2 } from "./util.ts";
import type { Moment } from "../moment.ts";

export interface WBuilding { p: P2[]; h: number; z0: number; roof: string; roofH: number; tone: C3; roofTone: C3; label: string; landmark: boolean; c: P2; i: number; house: boolean; lm?: string }
export interface WLandmark { qid: string; name: string; kind: string; links: number; x: number; y: number; h?: number; colour?: C3; base?: P2[]; line?: P2[]; bands?: boolean; standOn?: number }
export interface WTree { x: number; y: number; r: number; h: number; kind: "deciduous" | "conifer"; tone: C3 }
export interface WCover { type: string; poly: P2[]; col: C3; angle?: number; crop?: string }
export interface WRoad { pts: P2[]; w: number; kind: string; lit?: boolean; bridge?: boolean }
export interface World {
  W: number; D: number; S: number; heading: string; kind: string; cc: string;
  pal: Pal; seed: number; moment: Moment;
  H: (x: number, y: number) => number; relief: number; baseShift: number; absBase: number; // metres from the bundle's terrain base to the window's lowest point
  water: P2[][][]; land: P2[][]; roads: WRoad[]; buildings: WBuilding[]; trees: WTree[]; covers: WCover[];
  ferries: P2[][]; canals: P2[][]; cables: P2[][]; landmarks: WLandmark[]; openWater: P2[][]; parks: P2[][]; paths: P2[][]; pasture: P2[][];
  sunV: C3; reliefV: C3; reliefDif: number; shW: { dx: number; dy: number; perM: number };
  camPitch: number; farScreen: number; farFade: number; rock: boolean; signs: boolean; distant: string | null;
  beyond: { az: number; dist: number[]; h: number[] }[];
  waterAt?: (x: number, y: number) => boolean;
  toView: (x: number, y: number) => P2; label: string; feature: P2;
}

const ASIAN = new Set(["JP", "CN", "HK", "TW", "KR", "TH", "VN", "SG", "MY", "PH", "MO"]);

// What cities are actually built of, by region: the random pastel facades
// made Paris look like Midtown. Daylight colours; the palette darkens them
// for dusk and night.
interface Region { walls: C3[]; tall: C3[]; roofFlat: C3[]; roofPitched: C3[] }
const R_ = (walls: C3[], tall: C3[], roofFlat: C3[], roofPitched: C3[]): Region => ({ walls, tall, roofFlat, roofPitched });
const REGIONS: Record<string, Region> = {
  limestone: R_([[232, 222, 200], [224, 214, 190], [238, 230, 212], [216, 206, 186]], [[176, 186, 198], [200, 204, 206]], [[156, 162, 170], [168, 170, 172]], [[110, 122, 136], [98, 108, 120], [124, 132, 142]]),
  mediterranean: R_([[224, 184, 136], [214, 162, 114], [232, 202, 154], [204, 146, 104], [238, 216, 178], [226, 196, 160]], [[196, 196, 190], [176, 184, 194]], [[200, 180, 150], [190, 170, 140]], [[186, 106, 74], [172, 98, 70], [198, 122, 86]]),
  british: R_([[168, 98, 80], [152, 88, 72], [186, 120, 94], [228, 222, 206], [214, 206, 188]], [[170, 182, 196], [196, 200, 204], [150, 166, 186]], [[150, 150, 154], [166, 164, 162]], [[96, 100, 108], [112, 114, 120]]),
  northern: R_([[152, 80, 64], [124, 66, 54], [178, 106, 80], [198, 170, 142], [226, 214, 196], [94, 92, 90]], [[176, 186, 196], [200, 202, 204]], [[150, 150, 152]], [[96, 88, 86], [118, 82, 70], [80, 78, 82]]),
  american: R_([[178, 106, 84], [162, 94, 76], [216, 206, 188], [200, 192, 178], [152, 122, 102], [226, 220, 210]], [[152, 172, 192], [172, 182, 192], [198, 198, 194], [124, 144, 170]], [[152, 152, 154], [172, 170, 166]], [[112, 110, 112], [98, 102, 108], [134, 116, 102]]),
  eastasia: R_([[224, 224, 222], [208, 210, 212], [232, 228, 220], [198, 200, 206], [216, 208, 198]], [[162, 178, 198], [188, 198, 208], [142, 162, 188]], [[160, 164, 168], [180, 182, 184]], [[120, 126, 134], [96, 104, 112], [150, 90, 70]]),
  arid: R_([[228, 208, 172], [216, 194, 154], [238, 224, 198]], [[170, 186, 200], [206, 206, 200]], [[220, 204, 176]], [[200, 160, 120]]),
};
const REGION_OF: Record<string, string> = {
  FR: "limestone", MC: "limestone", LU: "limestone",
  IT: "mediterranean", ES: "mediterranean", PT: "mediterranean", HR: "mediterranean", MT: "mediterranean", SM: "mediterranean", VA: "mediterranean",
  GB: "british", IE: "british",
  NL: "northern", BE: "northern", DE: "northern", DK: "northern", PL: "northern", SE: "northern", NO: "northern", FI: "northern", CZ: "northern", AT: "northern", CH: "northern", EE: "northern", LV: "northern", LT: "northern",
  US: "american", CA: "american", AU: "american", NZ: "american",
  JP: "eastasia", KR: "eastasia", CN: "eastasia", HK: "eastasia", TW: "eastasia", SG: "eastasia", MO: "eastasia",
  AE: "arid", SA: "arid", QA: "arid", EG: "arid", MA: "arid", JO: "arid", IL: "arid", IR: "arid", KW: "arid", OM: "arid", BH: "arid", TN: "arid", DZ: "arid", LY: "arid",
};
// the few icons whose colour is not in Wikidata but is the whole point
const ICON: Record<string, { colour?: C3; bands?: boolean }> = {
  Q183536: { bands: true }, // Tokyo Tower: orange and white
  Q243: { colour: [128, 100, 76] }, // Eiffel Tower: its bronze-brown
  Q9202: { colour: [110, 168, 146] }, // Statue of Liberty: copper green
};
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
    const region = REGIONS[REGION_OF[b.place.cc] ?? ""];
    if (region) {
      // the material by day, mostly the palette's light after dark
      const day = total >= 60 ? pick(region.tall) : pick(region.walls);
      tone = mix(day, tone, pal.night ? 0.7 : 0.18);
    } else if (facade) tone = pull(facade, tone, 0.72);
    if (b.place.cc === "GR" || b.place.cc === "CY") tone = mix([250, 250, 246], tone, total > 12 ? 0.4 : 0.08); // whitewash
    const rc = q.roofColour ? hex(q.roofColour) : null;
    let roofTone: C3 = roof === "flat" ? mix(tone, pal.paper, 0.3) : mul(tone, 0.78);
    if (region) roofTone = mix(roof === "flat" ? pick(region.roofFlat) : pick(region.roofPitched), roofTone, pal.night ? 0.7 : 0.15);
    if (roof === "dome") roofTone = b.place.cc === "GR" || b.place.cc === "CY" ? [64, 108, 184] : [160, 168, 176];
    else if (rc) roofTone = pull(rc, roofTone, region ? 0.7 : 0.55);
    if (pal.snow && roof !== "flat" && roof !== "dome") roofTone = [244, 246, 250];
    const kindLabel = q.cls ? q.cls.replace(/_/g, " ") : roof === "gable" && area < 300 ? "House" : total >= 150 ? "Tower" : total >= 40 ? "High-rise" : total >= 12 ? "Building" : "Low building";
    const label = q.name ? `${q.name} · ${Math.round(total + roofH)} m` : `${cap(kindLabel)} · ${Math.round(total + roofH)} m`;
    const lmInfo = q.lm ? b.landmarks?.find(l => l.qid === q.lm) : undefined;
    // a long church's nave carries a steep roof (Notre-Dame, Westminster Abbey)
    if (lmInfo?.kind === "dome" && roof === "flat" && q.minH < 3 && area > 600) {
      const r = minRect(p), lng = Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]), wid = Math.hypot(r[2][0] - r[1][0], r[2][1] - r[1][1]);
      if (lng / Math.max(1, wid) > 2.2 && r.length === 4) { p = r; roof = "gable"; roofH = Math.min(wid * 0.7, 30); }
    }
    // a round part of a domed church is its dome (St Paul's, the Pantheon)
    if (lmInfo?.kind === "dome" && q.h > 15) {
      let per = 0; for (let k = 0; k < p.length; k++) per += Math.hypot(p[(k + 1) % p.length][0] - p[k][0], p[(k + 1) % p.length][1] - p[k][1]);
      const roundness = (4 * Math.PI * area) / Math.max(1, per * per);
      if (roundness > 0.82 && p.length >= 8) { roof = "dome"; roofH = Math.sqrt(area / Math.PI) * 0.95; }
    }
    if (lmInfo?.colour) { tone = mix(lmInfo.colour as C3, tone, pal.night ? 0.6 : 0.1); roofTone = mix(lmInfo.colour as C3, roofTone, 0.4); }
    const lmLabel = lmInfo ? `${lmInfo.name} · ${Math.round(lmInfo.h ?? total + roofH)} m` : label;
    buildings.push({ p, h: q.h, z0: H(c[0], c[1]) + q.minH, roof, roofH: roof === "flat" ? 0 : roofH, tone, roofTone, label: lmLabel, landmark: !!q.name, c, i, house: roof === "gable" && area < 320, ...(q.lm ? { lm: q.lm } : {}) });
  });

  const autumnish = (c: number[]) => c[0] > c[1] * 1.02 && c[0] > 60;
  // Phones draw at most 3,000 trees (the PRD's mobile cap). The bundle lists
  // trees in an evenly thinned order, so the first 3,000 cover the window.
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : null;
  const phone = !!nav && ((nav.deviceMemory ?? 8) <= 4 || (nav.hardwareConcurrency ?? 8) <= 6 || /Android|iPhone|iPad/i.test(nav.userAgent));
  const trees: WTree[] = (phone ? b.trees.slice(0, 3000) : b.trees).map(t => {
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
  const landmarks: WLandmark[] = (b.landmarks ?? []).map(l => {
    const [x, y] = toView(l.x, l.y), icon = ICON[l.qid] ?? {};
    const parts = buildings.filter(w => w.lm === l.qid);
    const standOn = parts.length ? Math.max(...parts.map(w => w.z0 + w.h + w.roofH)) : undefined;
    return { qid: l.qid, name: l.name, kind: l.kind, links: l.links, x, y, h: l.h, colour: (icon.colour ?? l.colour) as C3 | undefined, bands: icon.bands, base: l.base ? ccw(pv(l.base)) : undefined, line: l.line ? pv(l.line) : undefined, standOn };
  });
  return {
    W, D, S, heading: h, kind: b.view.kind, cc: b.place.cc, pal, seed, moment: m, H, relief, baseShift: lo, absBase: b.terrain.base,
    water: b.water.map(poly => poly.map(r => pv(r))), land: b.land.map(pv), roads, buildings, trees, covers,
    ferries: b.ferries.map(pv), canals: b.spawn.canals.map(pv), cables: (b.spawn.cables ?? []).map(pv), landmarks, openWater: b.spawn.openWater.map(pv), parks: b.spawn.parks.map(pv), paths: b.spawn.paths.map(pv), pasture: b.spawn.pasture.map(pv),
    sunV, reliefV, reliefDif: flat ? 0.55 : Math.max(pal.dif, 0.45),
    shW: { dx: -Math.sin(azr), dy: -Math.cos(azr), perM: Math.min(1 / Math.tan(Math.max(sun.alt, 7) * Math.PI / 180), 6) },
    camPitch: b.view.pitch, farScreen: b.view.kind === "mountain" ? 0.24 : 0.2, farFade: b.view.kind === "mountain" ? 0.015 : 0.1, rock: b.view.kind === "mountain" || relief > 250,
    signs: b.view.kind === "dense" && ASIAN.has(b.place.cc), distant: b.distant, beyond: b.beyond,
    toView, label: b.label, feature: [fx, fy],
  };
}

function nearest(c: number[], list: C3[]): C3 { let best = list[0], bd = Infinity; for (const l of list) { const d = (l[0] - c[0]) ** 2 + (l[1] - c[1]) ** 2 + (l[2] - c[2]) ** 2; if (d < bd) { bd = d; best = l; } } return best; }
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
