import { describe, expect, it } from "vitest";
import { area, clipLine, clipRing, grid, ringsToPolygons, simplify, trace } from "../builder/src/geom.ts";
import { cardinal } from "../builder/src/snap.ts";

describe("geometry", () => {
  it("clips a ring to a rectangle", () => {
    const r = clipRing([[-10, -10], [10, -10], [10, 10], [-10, 10]], 0, 0, 20, 20);
    expect(Math.abs(area(r))).toBeCloseTo(100);
  });
  it("splits a line into the runs inside a rectangle", () => {
    const runs = clipLine([[-5, 5], [5, 5], [15, 5], [25, 5]], 0, 0, 20, 20);
    expect(runs).toHaveLength(1);
    expect(runs[0][0][0]).toBeCloseTo(0); expect(runs[0][runs[0].length - 1][0]).toBeCloseTo(20);
  });
  it("traces a filled square counter-clockwise and a hole clockwise", () => {
    const g = grid(100, 10);
    for (let j = 1; j < 9; j++) for (let i = 1; i < 9; i++) g.data[j * g.w + i] = 1;
    for (let j = 4; j < 6; j++) for (let i = 4; i < 6; i++) g.data[j * g.w + i] = 0;
    const rings = trace(g, 0.5);
    const polys = ringsToPolygons(rings);
    expect(polys).toHaveLength(1);
    expect(area(polys[0][0])).toBeGreaterThan(0);
    expect(polys[0]).toHaveLength(2);
    expect(area(polys[0][1])).toBeLessThan(0);
  });
  it("simplifies a straight line to its ends", () => {
    expect(simplify([[0, 0], [1, 0.01], [2, 0], [3, 0.01], [4, 0]], 0.1)).toHaveLength(2);
  });
  it("maps angles to the four headings", () => {
    expect(cardinal(Math.PI / 2)).toBe("N"); expect(cardinal(0)).toBe("E"); expect(cardinal(Math.PI)).toBe("W"); expect(cardinal(-Math.PI / 2)).toBe("S");
  });
});
