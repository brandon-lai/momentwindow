// The edge: locates the visitor from request.cf, snaps to an H3 cell (the
// raw point is used in memory and dropped), and serves the page, the scene
// bundles (from KV, or built once and stored), the weather, place search and
// postcards. The raw IP address is never read, stored or logged here.
import { cellToLatLng, cellToParent, getResolution, isValidCell, latLngToCell } from "h3-js";
import { TEST_PLACES } from "../../shared/places.ts";

export interface Env {
  SCENES: KVNamespace;
  ASSETS: Fetcher;
  BUILDER_URL: string;
  BUILDER_SECRET: string;
  BUNDLE_VERSION: string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const monthOf = (d: Date) => d.toISOString().slice(0, 7);

// ---------- where is the visitor ----------
interface Located { cell: string; how: "ip" | "place" | "cell" | "none"; country: string }
function locate(req: Request, url: URL): Located {
  const cf = (req as unknown as { cf?: IncomingRequestCfProperties }).cf;
  const country = String(cf?.country ?? "");
  const place = url.searchParams.get("place");
  const tp = place ? TEST_PLACES.find(p => p.id === place) : null;
  if (tp) return { cell: latLngToCell(tp.lat, tp.lon, 8), how: "place", country };
  const c = url.searchParams.get("cell");
  if (c && isValidCell(c) && getResolution(c) === 8) return { cell: c, how: "cell", country };
  const lat = Number(cf?.latitude), lon = Number(cf?.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) return { cell: latLngToCell(lat, lon, 8), how: "ip", country };
  // no location at all (local dev, some VPNs): the Battery, labelled as such
  return { cell: latLngToCell(TEST_PLACES[0].lat, TEST_PLACES[0].lon, 8), how: "none", country };
}

async function page(env: Env, req: Request, boot: unknown, head = ""): Promise<Response> {
  const r = await env.ASSETS.fetch(new Request(new URL("/index.html", req.url)));
  let html = await r.text();
  const safe = JSON.stringify(boot).replace(/</g, "\\u003c");
  html = html.replace("<!--BOOT-->", `${head}<script id="boot" type="application/json">${safe}</script>`);
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
}

// ---------- scenes ----------
async function scene(env: Env, ctx: ExecutionContext, cell: string, url: URL): Promise<Response> {
  if (!isValidCell(cell) || getResolution(cell) !== 8) return json({ error: "Not a scene cell." }, 400);
  const monthQ = url.searchParams.get("month"), dateQ = url.searchParams.get("date");
  const date = dateQ && /^\d{4}-\d{2}-\d{2}$/.test(dateQ) ? dateQ : null;
  const month = monthQ && /^\d{4}-\d{2}$/.test(monthQ) ? monthQ : date ? date.slice(0, 7) : monthOf(new Date());
  const key = `scene:v${env.BUNDLE_VERSION}:${cell}:${month}`;
  const hit = await env.SCENES.get(key, "stream");
  if (hit) return new Response(hit, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600", "x-moment-cache": "hit" } });
  // a postcard asks for its own month: fall back to the newest bundle if that one is gone
  if (monthQ && monthQ !== monthOf(new Date())) {
    const now = await env.SCENES.get(`scene:v${env.BUNDLE_VERSION}:${cell}:${monthOf(new Date())}`, "stream");
    if (now) return new Response(now, { headers: { "content-type": "application/json; charset=utf-8", "x-moment-cache": "fallback" } });
  }
  if (!env.BUILDER_URL || !env.BUILDER_SECRET) return json({ error: "The scene builder is not configured." }, 503);
  const body = JSON.stringify({ cell, date: date ?? (monthQ ? `${monthQ}-15` : undefined) });
  const br = await fetch(env.BUILDER_URL, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.BUILDER_SECRET}` }, body });
  if (!br.ok || !br.body) {
    const j = await br.json().catch(() => ({ error: `builder ${br.status}` })) as { error?: string };
    return json({ error: j.error ?? "The scene could not be built." }, br.status === 404 ? 404 : br.status === 400 ? 400 : 502);
  }
  // stream to the visitor as it arrives; keep what follows the first line
  // (the full bundle) for KV. No parsing, no compression: the worker only
  // looks for one newline byte.
  const [toClient, toStore] = br.body.tee();
  ctx.waitUntil((async () => {
    const reader = toStore.getReader(); const parts: Uint8Array[] = []; let n = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
    const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const nl = all.indexOf(10);
    const rest = nl >= 0 ? all.subarray(nl + 1) : all;
    // only a complete second line, never an error line
    if (rest.length < 2000 || rest[rest.length - 1] !== 10 || rest.indexOf(10) !== rest.length - 1) return;
    await env.SCENES.put(key, rest, { metadata: { built: new Date().toISOString() } });
  })().catch(err => console.log(JSON.stringify({ msg: "kv store failed", err: String(err) }))));
  return new Response(toClient, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store, no-transform", "content-encoding": "identity", "x-moment-cache": "miss" } });
}

// ---------- weather: Open-Meteo, per resolution-6 cell, 15 minutes ----------
const weatherCache = new Map<string, { at: number; body: string }>();
async function weather(cell: string): Promise<Response> {
  if (!isValidCell(cell)) return json({ error: "Not a cell." }, 400);
  const parent = getResolution(cell) > 6 ? cellToParent(cell, 6) : cell;
  const hit = weatherCache.get(parent);
  if (hit && Date.now() - hit.at < 15 * 60e3) return new Response(hit.body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
  const [lat, lon] = cellToLatLng(parent);
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", lat.toFixed(3)); u.searchParams.set("longitude", lon.toFixed(3));
  u.searchParams.set("current", "temperature_2m,weather_code,cloud_cover,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m,visibility,snow_depth");
  u.searchParams.set("hourly", "precipitation"); u.searchParams.set("past_hours", "3"); u.searchParams.set("forecast_hours", "1");
  u.searchParams.set("wind_speed_unit", "ms"); u.searchParams.set("timezone", "auto");
  const r = await fetch(u.toString(), { headers: { "user-agent": "Moment/1.0 (non-commercial)" } });
  if (!r.ok) return json({ error: "No weather right now." }, 502);
  const j = await r.json() as { timezone: string; current: Record<string, number>; hourly?: { precipitation?: number[] } };
  const c = j.current;
  const recent = (j.hourly?.precipitation ?? []).slice(0, 3).reduce((s, v) => s + (v || 0), 0);
  const body = JSON.stringify({ tz: j.timezone, temp: c.temperature_2m, code: c.weather_code, cloud: c.cloud_cover, precip: c.precipitation, rain: c.rain, snowfall: c.snowfall, visibility: c.visibility ?? 20000, wind: c.wind_speed_10m, windDir: c.wind_direction_10m, snowDepth: c.snow_depth ?? 0, recent, source: "Open-Meteo" });
  weatherCache.set(parent, { at: Date.now(), body }); if (weatherCache.size > 2000) weatherCache.delete(weatherCache.keys().next().value!);
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=600" } });
}

// ---------- place search (Photon); coordinates become cells here ----------
async function search(q: string): Promise<Response> {
  if (!q || q.length > 120) return json({ results: [] });
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`, { headers: { "user-agent": "Moment/1.0 (+https://github.com/brandon-lai/momentwindow)" } });
  if (!r.ok) return json({ error: "Search is not answering right now." }, 502);
  const j = await r.json() as { features: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] };
  const seen = new Set<string>(); const results: { label: string; cell: string }[] = [];
  for (const f of j.features ?? []) {
    const p = f.properties; if (p.type === "house" || p.housenumber) continue; // places, not addresses
    const [lon, lat] = f.geometry.coordinates; const cell = latLngToCell(lat, lon, 8);
    if (seen.has(cell)) continue; seen.add(cell);
    const label = [p.name, p.city && p.city !== p.name ? p.city : null, p.state && p.state !== p.city ? p.state : null, p.country].filter(Boolean).join(", ");
    results.push({ label, cell });
  }
  return json({ results });
}

// ---------- postcards ----------
interface PostcardIn { cell: string; month: string; utc: number; weather: unknown; lifeSeed: number; steps: number; note: string; label: string; image: string }
async function createPostcard(env: Env, req: Request): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? 0); if (len > 900_000) return json({ error: "That postcard is too large." }, 413);
  let b: PostcardIn; try { b = await req.json(); } catch { return json({ error: "Bad postcard." }, 400); }
  if (!isValidCell(b.cell) || getResolution(b.cell) !== 8 || !/^\d{4}-\d{2}$/.test(b.month) || !Number.isFinite(b.utc) || !Number.isInteger(b.lifeSeed) || !Number.isInteger(b.steps) || typeof b.image !== "string") return json({ error: "Bad postcard." }, 400);
  const note = String(b.note ?? "").slice(0, 140);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const bin = Uint8Array.from(atob(b.image), c => c.charCodeAt(0));
  if (bin.length < 2000 || bin[0] !== 0xff || bin[1] !== 0xd8) return json({ error: "The postcard image did not come through." }, 400);
  const record = { id, cell: b.cell, month: b.month, utc: b.utc, weather: b.weather ?? null, lifeSeed: b.lifeSeed, steps: Math.max(0, Math.min(b.steps, 36000)), note, label: String(b.label ?? "").slice(0, 160), created: new Date().toISOString() };
  await env.SCENES.put(`pci:${id}`, bin, { metadata: { type: "image/jpeg" } });
  await env.SCENES.put(`pc:${id}`, JSON.stringify(record));
  return json({ id });
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url), path = url.pathname;
    try {
      if (path === "/" && req.method === "GET") { const l = locate(req, url); return page(env, req, { cell: l.cell, how: l.how, country: l.country }); }
      if (path === "/boot") { const l = locate(req, url); return json({ cell: l.cell, how: l.how, country: l.country }); }
      if (path === "/health") return json({ ok: true, builder: !!env.BUILDER_URL, version: env.BUNDLE_VERSION });
      let m = path.match(/^\/scene\/([0-9a-f]{15})$/); if (m && req.method === "GET") return scene(env, ctx, m[1], url);
      m = path.match(/^\/weather\/([0-9a-f]{15})$/); if (m) return weather(m[1]);
      if (path === "/search") return search(url.searchParams.get("q") ?? "");
      if (path === "/locate" && req.method === "POST") {
        const b = await req.json().catch(() => null) as { lat?: number; lon?: number } | null;
        const lat = Number(b?.lat), lon = Number(b?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: "No position came through." }, 400);
        return json({ cell: latLngToCell(lat, lon, 8) }); // the coordinates go no further
      }
      if (path === "/postcard" && req.method === "POST") return createPostcard(env, req);
      m = path.match(/^\/p\/([0-9a-f]{12})\.jpg$/);
      if (m) { const img = await env.SCENES.get(`pci:${m[1]}`, "arrayBuffer"); return img ? new Response(img, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } }) : new Response("Not found", { status: 404 }); }
      m = path.match(/^\/p\/([0-9a-f]{12})$/);
      if (m) {
        const rec = await env.SCENES.get(`pc:${m[1]}`, "json") as Record<string, unknown> | null;
        if (!rec) return new Response("This postcard is not here any more.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        const title = esc(String(rec.label || "A moment")), desc = esc(rec.note ? `“${rec.note}”` : "A live watercolour moment, sent from somewhere real.");
        const img = `${url.origin}/p/${m[1]}.jpg`;
        const head = `<meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:image" content="${img}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:url" content="${url.origin}/p/${m[1]}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${title}"><meta name="twitter:description" content="${desc}"><meta name="twitter:image" content="${img}">`;
        return page(env, req, { postcard: rec }, head);
      }
      if (path === "/t" && req.method === "POST") {
        // timing only: country and a resolution-5 cell (about 250 km2)
        const l = locate(req, url); const body = await req.text();
        let marks: unknown = null; try { marks = JSON.parse(body).marks; } catch { /* ignore */ }
        console.log(JSON.stringify({ msg: "timing", country: l.country, cell5: l.how === "ip" ? cellToParent(l.cell, 5) : null, marks }));
        return new Response(null, { status: 204 });
      }
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.log(JSON.stringify({ msg: "error", path, err: String(err) }));
      return json({ error: "Something went wrong." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
