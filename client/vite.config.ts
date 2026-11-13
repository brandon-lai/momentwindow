import { defineConfig } from "vite";
const edge = "http://127.0.0.1:8787";
export default defineConfig({
  root: "client",
  build: { outDir: "../dist/client", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
  worker: { format: "es" },
  server: { port: 5199, proxy: Object.fromEntries(["/scene", "/weather", "/boot", "/locate", "/search", "/postcard", "/p/", "/t"].map(p => [p, edge])) },
});
