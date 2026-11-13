// Bundles the scene builder into a Vercel Build Output API function, so the
// TypeScript sources (with their .ts import specifiers) never meet Vercel's
// own TypeScript handling.
import { build } from "esbuild";
import fs from "node:fs";

const out = ".vercel/output/functions/api/scene.func";
fs.rmSync(".vercel/output", { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await build({
  entryPoints: ["builder/vercel-entry.ts"], bundle: true, platform: "node", target: "node22", format: "esm",
  outfile: `${out}/index.mjs`, minify: false, sourcemap: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
fs.writeFileSync(`${out}/.vc-config.json`, JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 60, memory: 1769, regions: ["pdx1"] }, null, 1));
fs.writeFileSync(".vercel/output/config.json", JSON.stringify({ version: 3, routes: [{ src: "/", status: 404, dest: "/404" }] }, null, 1));
console.log("bundled", (fs.statSync(`${out}/index.mjs`).size / 1024).toFixed(0), "KB");
