import { describe, expect, it } from "vitest";
import { minRect, pull, sunPos } from "../client/src/paint/util.ts";
import { makeMoment } from "../client/src/moment.ts";

describe("colour and light", () => {
  it("keeps the palette's lightness and moves hue only 40% toward the sample", () => {
    const pal = [88, 138, 178], dark = [13, 27, 23];
    const out = pull(dark, pal);
    const L = (c: number[]) => (Math.max(...c) + Math.min(...c)) / 2 / 255; // HSL lightness
    expect(Math.abs(L(out) - L(pal))).toBeLessThan(0.02);
    expect(out[2]).toBeGreaterThan(out[1] - 30); // still a blue water, not a green one
  });
  it("puts the sun high at noon in June and below the horizon at midnight", () => {
    expect(sunPos(Date.UTC(2026, 5, 21, 16, 0), 40.7, -74).alt).toBeGreaterThan(60);
    expect(sunPos(Date.UTC(2026, 5, 21, 4, 0), 40.7, -74).alt).toBeLessThan(0);
  });
  it("chooses the palette from the sun and the weather", () => {
    const w = { tz: "UTC", temp: 10, code: 61, cloud: 100, precip: 2, rain: 2, snowfall: 0, visibility: 9000, wind: 3, windDir: 200, snowDepth: 0, recent: 3, fetchedAt: 0 };
    expect(makeMoment(Date.UTC(2026, 5, 21, 16, 0), 40.7, -74, w).key).toBe("rain");
    expect(makeMoment(Date.UTC(2026, 5, 21, 4, 0), 40.7, -74, w).key).toBe("night");
    expect(makeMoment(Date.UTC(2026, 5, 21, 16, 0), 40.7, -74, { ...w, code: 0, cloud: 5, precip: 0, rain: 0, recent: 0, temp: 28 }).key).toBe("bright");
  });
  it("fits a rectangle with its long side first, for gable ridges", () => {
    const r = minRect([[0, 0], [10, 0], [10, 4], [0, 4]]);
    const l01 = Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]), l12 = Math.hypot(r[2][0] - r[1][0], r[2][1] - r[1][1]);
    expect(l01).toBeGreaterThan(l12);
  });
});
