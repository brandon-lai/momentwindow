// Landmarks: what a visitor would recognise. Wikipedia's geosearch finds the
// articles around a point; Wikidata says how famous each one is (how many
// language editions cover it), what it is (lattice tower, suspension bridge,
// cathedral...), how tall, and what colour and material it is officially.
// Overpass could answer the same questions, but it timed out or failed on
// three public servers when tried; these two APIs answer in about a second.

const UA = "Moment/1.0 (+https://github.com/brandon-lai/momentwindow; scene builder)";

export interface WikiLandmark {
  qid: string; name: string; lat: number; lon: number; links: number; ctype?: string; // Wikipedia's coordinate type (landmark, city...)
  notStructure: boolean; // has a population, a headquarters (places, organisations) or a date and participants (events): not a building
  types: string[]; height?: number; length?: number; colours: string[]; materials: string[];
}

// Things with coordinates that are not things you can see: organisations,
// events, people, administrative areas, streets, stations' operators...
const NOT_PHYSICAL = new Set([
  "Q43229", "Q245065", "Q79913", "Q4830453", "Q783794", "Q891723", "Q163740", "Q484652", "Q48204", "Q1616075", "Q2085381", "Q7210356",
  "Q5", "Q1656682", "Q172754", "Q667276", "Q464980", "Q2761147", "Q1190554", "Q178561", "Q645883", "Q198", "Q13406463",
  "Q515", "Q1549591", "Q200250", "Q123705", "Q2983893", "Q188509", "Q15284", "Q3957", "Q532", "Q486972", "Q1637706", "Q702492", "Q34442", "Q79007", "Q83620",
  "Q3918", "Q875538", "Q902104", "Q2385804", "Q38723", "Q1371037", "Q23002054", "Q5341295", "Q11032", "Q41298", "Q1002697", "Q15265344",
]);

export async function landmarksNear(lat: number, lon: number, radius: number): Promise<WikiLandmark[]> {
  // Up to 500 articles nearby, ranked by article length (a free proxy for
  // fame); the 50 nearest alone missed the Empire State Building in Midtown.
  const gs = new URL("https://en.wikipedia.org/w/api.php");
  for (const [k, v] of Object.entries({ action: "query", format: "json", generator: "geosearch", ggscoord: `${lat}|${lon}`, ggsradius: String(Math.min(10000, radius)), ggslimit: "500", prop: "coordinates|pageprops|info", ppprop: "wikibase_item", coprimary: "primary", coprop: "type", colimit: "max", pplimit: "max" })) gs.searchParams.set(k, v);
  const r = await fetch(gs, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`wikipedia ${r.status}`);
  const pages = Object.values(((await r.json()) as { query?: { pages: Record<string, any> } }).query?.pages ?? {}).sort((a: any, b: any) => (b.length ?? 0) - (a.length ?? 0));
  const byQ = new Map<string, { title: string; lat: number; lon: number; type?: string }>();
  for (const p of pages) {
    const q = p.pageprops?.wikibase_item, c = p.coordinates?.[0];
    if (!q || !c) continue;
    if (c.type && ["city", "adm1st", "adm2nd", "adm3rd", "country", "event", "edu", "railwaystation", "isle", "river", "waterbody", "airport"].includes(c.type)) continue;
    byQ.set(q, { title: p.title, lat: c.lat, lon: c.lon, type: c.type });
    if (byQ.size >= 45) break;
  }
  if (!byQ.size) return [];
  const wd = new URL("https://www.wikidata.org/w/api.php");
  for (const [k, v] of Object.entries({ action: "wbgetentities", format: "json", props: "claims|sitelinks|labels", languages: "en", ids: [...byQ.keys()].join("|") })) wd.searchParams.set(k, v);
  const w = await fetch(wd, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!w.ok) throw new Error(`wikidata ${w.status}`);
  const ents = ((await w.json()) as { entities: Record<string, any> }).entities ?? {};
  const ids = (e: any, p: string): string[] => (e.claims?.[p] ?? []).map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  const out: WikiLandmark[] = [];
  for (const [q, g] of byQ) {
    const e = ents[q]; if (!e) continue;
    const types = ids(e, "P31");
    if (types.some(t => NOT_PHYSICAL.has(t))) continue;
    const hClaim = (e.claims?.P2048 ?? [])[0]?.mainsnak?.datavalue?.value;
    // heights are mostly metres; feet (Q3710) converted
    const height = hClaim ? Number(hClaim.amount) * (String(hClaim.unit).endsWith("Q3710") ? 0.3048 : 1) : undefined;
    const lClaim = (e.claims?.P2043 ?? [])[0]?.mainsnak?.datavalue?.value; // length (bridges)
    const length = lClaim ? Number(lClaim.amount) * (String(lClaim.unit).endsWith("Q3710") ? 0.3048 : String(lClaim.unit).endsWith("Q828224") ? 1000 : 1) : undefined;
    out.push({
      qid: q, name: e.labels?.en?.value ?? g.title, lat: g.lat, lon: g.lon, links: Object.keys(e.sitelinks ?? {}).length, ctype: g.type,
      notStructure: ["P1082", "P159", "P36", "P1376", "P585", "P710", "P1120", "P1339"].some(p => (e.claims?.[p] ?? []).length > 0),
      types, height: height && height > 0 && height < 1000 ? height : undefined, length: length && length > 20 && length < 20000 ? length : undefined, colours: ids(e, "P462"), materials: ids(e, "P186"),
    });
  }
  return out.sort((a, b) => b.links - a.links);
}

// Wikidata classes the painter has a shape for, checked against Wikidata's
// own labels. Order matters: Tower Bridge is both bascule and suspension,
// Tokyo Tower both lattice tower and transmitter mast.
export const LM_KIND: [string, string[]][] = [
  ["lattice", ["Q1440476"]], // lattice tower
  ["needle", ["Q11166728", "Q1068623"]], // television tower, transmitter mast
  ["bascule", ["Q911663"]],
  ["suspension", ["Q12570"]],
  ["cablestayed", ["Q158555"]],
  ["arch", ["Q158438"]],
  ["statue", ["Q179700", "Q1779653"]], // statue, colossal statue
  ["shells", ["Q153562"]], // opera house
  ["clock", ["Q853854", "Q1480017", "Q200334", "Q815448", "Q5191724"]], // clock tower, striking clock, bell tower, belfry, steeple
  ["obelisk", ["Q170980"]],
  ["ferris", ["Q202570"]],
  ["skyscraper", ["Q11303"]],
  ["dome", ["Q2977", "Q16970", "Q32815", "Q56242215", "Q56242250", "Q120560", "Q162875"]], // cathedrals, church, mosque, basilica, mausoleum
  ["bridge", ["Q12280", "Q12042110", "Q537127", "Q158218"]], // other bridges
];
export function landmarkKind(types: string[]): string | null {
  for (const [k, list] of LM_KIND) if (types.some(t => list.includes(t))) return k;
  return null;
}

// Wikidata colours and materials (P462, P186) to paint with.
export const WD_COLOUR: Record<string, [number, number, number]> = {
  Q3142: [184, 52, 44], Q39338: [222, 120, 50], Q47071: [118, 80, 54], Q1088: [70, 110, 190], Q3133: [80, 140, 90],
  Q23444: [248, 247, 242], Q23445: [40, 40, 44], Q943: [226, 190, 60], Q140371224: [192, 54, 36],
};
export const WD_MATERIAL: Record<string, [number, number, number]> = {
  Q23757: [222, 212, 188], Q82337: [228, 224, 210], Q20670733: [226, 214, 186], Q1421807: [226, 212, 176], Q40861: [242, 240, 234],
  Q22657: [198, 196, 190], Q184190: [198, 196, 190], Q11469: [150, 176, 200], Q11426: [150, 152, 158], Q753: [98, 160, 138],
  Q11427: [142, 146, 152], Q677: [112, 90, 72], Q860451: [124, 98, 72], Q2642947: [124, 98, 72], Q41177: [176, 170, 168],
  Q22731: [196, 188, 172], Q121649: [210, 200, 180], Q1124525: [214, 200, 168], Q484924: [178, 160, 128], Q40089: [168, 96, 76],
  Q13085: [208, 178, 136], Q287: [140, 100, 66],
};
