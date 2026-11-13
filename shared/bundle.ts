// The scene bundle: everything the browser needs to paint one window, baked
// once per H3 cell. Local metres: x east, y north, origin at the scene
// square's south-west corner. This is the PRD's contract with the extensions
// listed at the bottom (each one says why it exists).

export const BUNDLE_VERSION = 2; // 2: landmarks

export type Pt = [number, number];
export type Ring = Pt[];
export type RGB = [number, number, number];
export type Heading = "N" | "E" | "S" | "W";

export interface Road { pts: Pt[]; w: number; kind: string; lit: boolean; name?: string; bridge?: boolean }
export interface Rail { pts: Pt[]; kind: "rail" | "tram" | "light_rail"; bridge?: boolean }
export interface Cover { type: string; poly: Ring; colour: RGB | null; angle?: number }
export interface Building {
  p: Ring; h: number; minH: number; roof: string; roofH: number; roofDir?: number;
  roofColour?: string; facadeColour?: string; name?: string; cls?: string;
  lm?: string; // Wikidata id of the landmark this footprint belongs to (extension)
}

// A famous landmark in or near the window (extension): what Wikidata says it
// is, so the painter can give it its real shape.
export interface Landmark {
  qid: string; name: string; links: number;
  kind: string; // lattice, needle, suspension, cablestayed, arch, bascule, bridge, statue, shells, clock, obelisk, ferris, skyscraper, dome, building
  x: number; y: number; h?: number; colour?: RGB;
  base?: Ring; line?: Pt[];
}
export interface Tree { x: number; y: number; h: number; r: number; kind: "broadleaf" | "conifer"; colour: RGB }

export interface SceneBundle {
  version: number;
  cell: string;
  centre: [number, number]; // window centre [lat, lon], a public place, never a visitor's point
  size: [number, number]; // scene square [w, d] in metres
  heading: Heading;
  terrain: { cols: number; rows: number; spacing: number; heights: string /* base64 Int16, decimetres above `base` */; base: number };
  water: Ring[][]; // polygons, each [outer, ...holes]
  land: Ring[]; // piers and breakwaters added back as land
  roads: Road[];
  rail: Rail[];
  ferries: Pt[][];
  covers: Cover[];
  buildings: Building[];
  trees: Tree[];
  spawn: { parks: Ring[]; paths: Pt[][]; openWater: Ring[]; pasture: Ring[]; canals: Pt[][]; cables?: Pt[][] }; // cables: aerialways (extension)
  attribution: string[];

  // --- extensions to the PRD contract ---
  // The window inside the square, in the camera's frame (after turning to
  // `heading`): w wide, d deep, centred in the square. Pitch 34, or 28 in
  // mountains. The PRD fixes these per scene kind; the client needs them.
  view: { w: number; d: number; pitch: number; kind: SceneKind };
  // "Around the Battery, New York": neighbourhood level only (privacy rules).
  label: string;
  place: { name: string; city: string; country: string; cc: string };
  // Median Sentinel-2 colours for the bare ground and the water, before the
  // client pulls them 60% toward its palette (the palette depends on the
  // weather at paint time, the sample does not).
  sample: { ground: RGB | null; water: RGB | null; snowCover: number; month: string };
  distant: "skyline" | "hills" | "island" | "ridge" | null;
  // Terrain beyond the far edge, for real ridges against the sky: heights
  // along rays fanning out past the window, metres above `terrain.base`.
  beyond: { az: number; dist: number[]; h: number[] }[];
  feature: { kind: "waterfront" | "park" | "landmark" | "street" | "centre"; name?: string; x: number; y: number; depth?: number };
  landmarks?: Landmark[];
  built: { at: string; ms: number; sources: Record<string, number>; month: string; notes: string[] };
}

export type SceneKind = "dense" | "suburb" | "country" | "mountain";

// Sizes from the PRD: 2 km dense cities, 3 km suburbs, 5 km countryside and
// mountains. The window sizes are the prototype's, which were tuned so a
// house still reads at phone width.
export const KIND: Record<SceneKind, { square: number; w: number; d: number; pitch: number }> = {
  dense: { square: 2000, w: 1400, d: 930, pitch: 34 },
  suburb: { square: 3000, w: 1150, d: 760, pitch: 34 },
  country: { square: 5000, w: 2900, d: 1900, pitch: 34 },
  mountain: { square: 5000, w: 2500, d: 1650, pitch: 28 },
};

export const LANDMARK_CLASSES = new Set([
  "place_of_worship", "museum", "castle", "monument", "attraction", "town_hall", "railway", "theatre",
  "stadium", "library", "college", "university", "art_gallery", "lighthouse", "tower", "bridge", "ferry_terminal",
]);

export function decodeHeights(b64: string, n: number): Int16Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, n);
}
