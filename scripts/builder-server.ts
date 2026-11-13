// Local stand-in for the Vercel builder, for wrangler dev.
import http from "node:http";
import { handle } from "../builder/src/handler.ts";
const port = Number(process.env.PORT ?? 8790);
http.createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { /* empty */ }
  const t0 = Date.now();
  await handle(req.headers.authorization, body, { status: c => { res.statusCode = c; }, header: (k, v) => res.setHeader(k, v), write: s => { res.write(s); }, end: () => res.end() }, process.env.BUILDER_SECRET ?? "dev-secret");
  console.log(new Date().toISOString(), (body as any).cell, res.statusCode, Date.now() - t0, "ms");
}).listen(port, () => console.log("builder on", port));
