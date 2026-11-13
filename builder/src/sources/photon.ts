// City and country names for the label, from Photon (komoot's public
// OpenStreetMap geocoder). Called once per cell build, never per visitor.
export interface Place { city?: string; district?: string; county?: string; state?: string; country?: string; cc?: string }

export async function reverseGeocode(lat: number, lon: number): Promise<Place | null> {
  const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&lang=en&limit=1`, {
    headers: { "user-agent": "Moment/1.0 (+https://github.com/brandon-lai/momentwindow; scene builder)" },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { features?: { properties: Record<string, string> }[] };
  const p = j.features?.[0]?.properties; if (!p) return null;
  return { city: p.city || p.town || p.village || p.locality, district: p.district || p.locality, county: p.county, state: p.state, country: p.country, cc: p.countrycode };
}
