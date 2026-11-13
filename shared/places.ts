// The PRD's ten test places (coordinates approximate; snapping picks the
// exact view). They are the regression set: every change is judged on them.
export interface TestPlace { id: string; name: string; type: string; lat: number; lon: number; tests: string }

export const TEST_PLACES: TestPlace[] = [
  { id: "battery", name: "The Battery, New York", type: "Waterfront city", lat: 40.703, lon: -74.016, tests: "Ferries, towers, reflections, parity with prototype" },
  { id: "aquatic", name: "Aquatic Park, San Francisco", type: "Hills and bay", lat: 37.806, lon: -122.421, tests: "Steep streets, fog, piers" },
  { id: "herengracht", name: "Herengracht, Amsterdam", type: "European canal city", lat: 52.371, lon: 4.888, tests: "Narrow gabled houses, canal boats, bikes, drizzle" },
  { id: "asakusa", name: "Asakusa and the Sumida River, Tokyo", type: "Asian city", lat: 35.711, lon: 139.799, tests: "Density, temple, rail bridge, dusk lights" },
  { id: "central", name: "Central, Hong Kong", type: "Dense high-rise", lat: 22.282, lon: 114.158, tests: "Very tall buildings against a steep hill" },
  { id: "levittown", name: "Levittown, New York", type: "Suburb", lat: 40.725, lon: -73.514, tests: "Repeating houses, pools, cul-de-sacs" },
  { id: "champlain", name: "Champlain Valley, Vermont", type: "Farmland", lat: 44.0, lon: -73.17, tests: "Fields from imagery, hedgerows, autumn, murmuration" },
  { id: "kansas", name: "Central Kansas", type: "Sparse rural", lat: 38.5, lon: -98.5, tests: "Little OSM detail; the painting relies on imagery alone" },
  { id: "grindelwald", name: "Grindelwald, Switzerland", type: "Mountains in snow", lat: 46.624, lon: 8.034, tests: "Relief, ridge against sky, snow, cable car" },
  { id: "naousa", name: "Naousa, Paros", type: "Island harbour", lat: 37.124, lon: 25.236, tests: "White cubes, blue domes, beach, breakwater" },
];
