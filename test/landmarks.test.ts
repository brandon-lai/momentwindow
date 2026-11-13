import { describe, expect, it } from "vitest";
import { landmarkKind } from "../builder/src/sources/wiki.ts";
import { axisOf, frameLandmark, theName, type Matched } from "../builder/src/landmarks.ts";

const wl = (name: string, links: number, types: string[] = []) => ({ qid: "Q" + links, name, lat: 0, lon: 0, links, types, colours: [], materials: [], notStructure: false });

describe("landmarks", () => {
  it("reads a shape from Wikidata types, bascule before suspension", () => {
    expect(landmarkKind(["Q1440476", "Q1440300"])).toBe("lattice"); // Eiffel Tower
    expect(landmarkKind(["Q911663", "Q12570"])).toBe("bascule"); // Tower Bridge
    expect(landmarkKind(["Q12570"])).toBe("suspension"); // Golden Gate
    expect(landmarkKind(["Q153562"])).toBe("shells"); // Sydney Opera House
    expect(landmarkKind(["Q7362268", "Q839954"])).toBeNull(); // the Colosseum stays a building
  });
  it("names landmarks the way people say them", () => {
    expect(theName("Eiffel Tower")).toBe("the Eiffel Tower");
    expect(theName("Colosseum")).toBe("the Colosseum");
    expect(theName("Statue of Liberty")).toBe("the Statue of Liberty");
    expect(theName("Big Ben")).toBe("Big Ben");
    expect(theName("Tower Bridge")).toBe("Tower Bridge");
  });
  it("finds a bridge's axis from all its points", () => {
    const [ax, ay] = axisOf([[0, 0], [10, 100], [5, 50], [12, 140]]);
    expect(Math.abs(ay)).toBeGreaterThan(0.95);
    void ax;
  });
  it("frames the most famous thing, and a bridge side-on", () => {
    const bridge: Matched = { w: wl("Golden Gate Bridge", 111, ["Q12570"]), kind: "suspension", x: 1200, y: 1200, line: [[1200, 0], [1200, 2400]] };
    const kiosk: Matched = { w: wl("A kiosk", 30), kind: "building", x: 1000, y: 1000 };
    const f = frameLandmark([kiosk, bridge], 1200, 1200, 930, 1400, () => false, 1500)!;
    expect(f.primary.w.name).toBe("Golden Gate Bridge");
    expect(["E", "W"]).toContain(f.heading); // a north-south bridge is seen from the side
  });
});
