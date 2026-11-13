// The edge's privacy rules, exercised through its fetch handler.
import { describe, expect, it, vi } from "vitest";
import worker from "../edge/src/index.ts";

const env = {
  SCENES: { get: async () => null, put: async () => {} } as unknown as KVNamespace,
  ASSETS: { fetch: async () => new Response("<html><head><!--BOOT--></head></html>") } as unknown as Fetcher,
  BUILDER_URL: "", BUILDER_SECRET: "", BUNDLE_VERSION: "1",
};
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (url: string, init?: RequestInit, cf?: Record<string, unknown>) => Object.assign(new Request(url, init), { cf });

describe("edge", () => {
  it("snaps browser coordinates to a cell and returns nothing else", async () => {
    const r = await worker.fetch(req("https://m.test/locate", { method: "POST", body: JSON.stringify({ lat: 51.50123, lon: -0.14256 }) }), env, ctx);
    const j = await r.json() as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["cell"]);
    expect(JSON.stringify(j)).not.toContain("51.50");
  });
  it("puts a cell, never coordinates, into the page", async () => {
    const r = await worker.fetch(req("https://m.test/", undefined, { latitude: "51.50123", longitude: "-0.14256", country: "GB" }), env, ctx);
    const html = await r.text();
    expect(html).toContain('"how":"ip"');
    expect(html).not.toContain("51.50123"); expect(html).not.toContain("-0.14256");
  });
  it("logs timing with a country and a coarse cell only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.fetch(req("https://m.test/t", { method: "POST", body: JSON.stringify({ marks: { painted: 2000 } }), headers: { "cf-connecting-ip": "203.0.113.9" } }, { latitude: "51.50123", longitude: "-0.14256", country: "GB" }), env, ctx);
    const line = String(log.mock.calls[0][0]); log.mockRestore();
    expect(line).toContain('"country":"GB"');
    expect(line).not.toContain("51.50"); expect(line).not.toContain("203.0.113.9");
    expect(JSON.parse(line).cell5).toMatch(/^85/);
  });
  it("refuses a malformed postcard", async () => {
    const r = await worker.fetch(req("https://m.test/postcard", { method: "POST", body: JSON.stringify({ cell: "nope" }) }), env, ctx);
    expect(r.status).toBe(400);
  });
});
