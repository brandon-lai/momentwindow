// A postcard replays life by stepping the same seed the same number of
// fixed steps: the positions must come out identical.
import { describe, expect, it } from "vitest";
import { createLife, stepLife } from "../client/src/live/life.ts";
import { makeMoment } from "../client/src/moment.ts";
import type { World } from "../client/src/paint/scene.ts";
import { palette } from "../client/src/paint/palette.ts";

function world(): World {
  const m = makeMoment(Date.UTC(2026, 10, 12, 18, 40), 40.7, -74, null);
  const road = (y: number) => ({ pts: [[0, y], [1400, y]] as [number, number][], w: 12, kind: "street", lit: true });
  return {
    W: 1400, D: 930, S: 2000, heading: "N", kind: "dense", cc: "US", pal: palette("clearing"), seed: 1, moment: m, H: () => 0, relief: 0, baseShift: 0, absBase: 0,
    water: [[[[0, 0], [1400, 0], [1400, 300], [0, 300]]]], land: [], roads: [road(400), road(600), { pts: [[700, 300], [700, 930]], w: 12, kind: "street", lit: true }], buildings: [], trees: [], covers: [],
    ferries: [[[100, 100], [1300, 200]]], canals: [], cables: [], openWater: [[[0, 0], [1400, 0], [1400, 300], [0, 300]]], parks: [], paths: [[[0, 500], [1400, 520]]], pasture: [],
    sunV: [0, 0, 1], reliefV: [0, 0, 1], reliefDif: 0.5, shW: { dx: 0, dy: -1, perM: 1 }, camPitch: 34, farScreen: 0.2, farFade: 0.1, rock: false, signs: false, distant: null, beyond: [],
    waterAt: (x, y) => y < 300 && x > 0 && x < 1400, toView: (x, y) => [x, y], label: "", feature: [700, 300],
  };
}
const snapshot = (l: ReturnType<typeof createLife>) => JSON.stringify([l.boats.map(b => b.r.pos().map((v: number) => v.toFixed(3))), l.cars.map(c => c.r.pos().map((v: number) => v.toFixed(3))), l.walkers.map(w => (w.free ? [w.x, w.y] : w.r.pos()).map((v: number) => v.toFixed(3)))]);

describe("life", () => {
  it("replays exactly from a seed and a step count", () => {
    const run = () => { const w = world(), l = createLife(w, 12345); let t = 0; for (let i = 0; i < 900; i++) { stepLife(w, l, t, 1 / 30, () => {}); t += 1 / 30; } return snapshot(l); };
    expect(run()).toBe(run());
  });
  it("runs ferries on the ferry route and cars on the streets", () => {
    const w = world(), l = createLife(w, 7);
    expect(l.boats.some(b => b.kind === "ferry")).toBe(true);
    expect(l.cars.length).toBeGreaterThan(1);
  });
});
