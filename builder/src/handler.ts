// The builder's HTTP contract, independent of the host: POST {cell, date?}
// with the shared secret, answered as newline-delimited JSON: the quick
// streets-and-footprints bundle first, then the full bundle.
import { buildScene, CellError, OceanError } from "./build.ts";

export interface Out { status(code: number): void; header(k: string, v: string): void; write(s: string): void; end(): void }

export async function handle(auth: string | undefined, body: { cell?: string; date?: string }, out: Out, secret: string | undefined) {
  if (!secret || auth !== `Bearer ${secret}`) { out.status(401); out.header("content-type", "application/json"); out.write(JSON.stringify({ error: "Not allowed." })); out.end(); return; }
  const cell = String(body.cell ?? "");
  const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? new Date(body.date + "T12:00:00Z") : undefined;
  let started = false;
  const start = () => { if (!started) { started = true; out.status(200); out.header("content-type", "application/x-ndjson"); out.header("cache-control", "no-store"); } };
  try {
    const full = await buildScene(cell, { date, onLite: b => { start(); b.built.notes.push("lite"); out.write(JSON.stringify(b) + "\n"); } });
    start(); out.write(JSON.stringify(full) + "\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof OceanError ? 404 : err instanceof CellError ? 400 : 502;
    if (!started) { out.status(code); out.header("content-type", "application/json"); out.write(JSON.stringify({ error: msg, code })); }
    else out.write(JSON.stringify({ error: msg, code }) + "\n");
    console.error("build failed", cell, msg);
  }
  out.end();
}
