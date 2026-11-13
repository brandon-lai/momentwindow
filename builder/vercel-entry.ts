// Vercel function: the scene builder (stands in for the PRD's Python
// container; see README).
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "./src/handler.ts";

export const config = { maxDuration: 60 };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  let body: { cell?: string; date?: string } = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* empty */ }
  await handle(req.headers.authorization, body, {
    status: c => { res.statusCode = c; }, header: (k, v) => res.setHeader(k, v), write: s => { res.write(s); }, end: () => res.end(),
  }, process.env.BUILDER_SECRET);
}
