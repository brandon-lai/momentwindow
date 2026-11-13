// The moment: real time, real sun, real weather, and the words for them.
import { sunPos } from "./paint/util.ts";

export interface Weather {
  tz: string; temp: number; code: number; cloud: number; precip: number; rain: number; snowfall: number;
  visibility: number; wind: number; windDir: number; snowDepth: number; recent: number; fetchedAt: number; source?: string;
}

export interface Moment {
  utc: number; lat: number; lon: number; tz: string;
  key: string; // palette key
  sun: { alt: number; az: number };
  weather: Weather | null;
  rain: boolean; drizzle: boolean; snowing: boolean; fog: boolean; partly: boolean; snowOnGround: boolean;
  phrase: string; // "clearing after rain"
}

const RAIN = new Set([61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const DRIZZLE = new Set([51, 53, 55, 56, 57]);
const SNOW = new Set([71, 73, 75, 77, 85, 86]);
const FOG = new Set([45, 48]);

export function makeMoment(utc: number, lat: number, lon: number, w: Weather | null, opts: { snowCover?: number; weatherOverride?: string | null } = {}): Moment {
  const sun = sunPos(utc, lat, lon);
  const ov = opts.weatherOverride;
  const code = w?.code ?? 2;
  const rain = ov ? ov === "rain" : RAIN.has(code) || (w?.rain ?? 0) > 0.4;
  const drizzle = ov ? ov === "drizzle" : !rain && (DRIZZLE.has(code) || ((w?.precip ?? 0) > 0 && (w?.snowfall ?? 0) === 0));
  const snowing = ov ? ov === "snow" : SNOW.has(code) || (w?.snowfall ?? 0) > 0;
  const fog = ov ? ov === "fog" : FOG.has(code) || (w ? w.visibility < 1500 : false);
  const cloud = ov === "clear" ? 5 : w?.cloud ?? 40;
  const partly = !rain && !drizzle && !snowing && !fog && cloud >= 25 && cloud <= 80;
  const snowOnGround = (w?.snowDepth ?? 0) > 0.03 || (opts.snowCover ?? 0) > 0.35 || snowing;
  let key = "clearing";
  if (sun.alt < -6) key = "night";
  else if (sun.alt < 3) key = "dusk";
  else if (snowing) key = "snow";
  else if (fog) key = "fog";
  else if (rain) key = "rain";
  else if (drizzle) key = "drizzle";
  else if (sun.alt < 12 && cloud < 75) key = "golden";
  else if (cloud > 85) key = "overcast";
  else if (cloud < 30 && sun.alt > 45 && (w?.temp ?? 15) > 22) key = "bright";
  else if (cloud < 30) key = "clear";
  else if (snowOnGround) key = "snow";
  const phrase = describe({ sun, rain, drizzle, snowing, fog, cloud, w, snowOnGround });
  return { utc, lat, lon, tz: w?.tz ?? "UTC", key, sun, weather: w, rain, drizzle, snowing, fog, partly, snowOnGround, phrase };
}

function describe(o: { sun: { alt: number }; rain: boolean; drizzle: boolean; snowing: boolean; fog: boolean; cloud: number; w: Weather | null; snowOnGround: boolean }): string {
  const { sun, w } = o;
  const light = sun.alt < -6 ? "night" : sun.alt < 3 ? "dusk" : sun.alt < 12 ? "low sun" : "";
  if (o.snowing) return (w?.snowfall ?? 0) > 1 ? "snow falling" : "light snow falling";
  if (o.rain) return (w?.rain ?? 0) > 2.5 ? "steady rain" : "rain";
  if (o.drizzle) return "light drizzle";
  if (o.fog) return light === "night" ? "fog under the lamps" : "fog lying low";
  if (w && w.recent > 0.2 && w.precip === 0) return light === "night" ? "dry again after rain" : "clearing after rain";
  if (light === "night") return o.cloud < 30 ? "a clear night" : "a cloudy night";
  if (light === "dusk") return o.cloud < 60 ? "dusk, lights coming on" : "grey dusk";
  if (light === "low sun") return o.cloud < 75 ? "low golden sun" : "low light under cloud";
  if (o.snowOnGround) return o.cloud < 40 ? "bright after snow" : "snow on the ground";
  if (o.cloud > 85) return "overcast";
  if (o.cloud > 50) return "cloud coming and going";
  if (o.cloud > 25) return "sun between clouds";
  return (w?.temp ?? 15) < 5 ? "clear and cold" : (w?.temp ?? 15) > 27 ? "bright and hot" : "clear and bright";
}

// "Thursday 1:40 p.m."
export function clockLine(utc: number, tz: string): string {
  const d = new Date(utc);
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d); }
  catch { parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(d); }
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  const ap = get("dayPeriod").toLowerCase().startsWith("p") ? "p.m." : "a.m.";
  return `${get("weekday")} ${get("hour")}:${get("minute")} ${ap}`;
}

export function localHour(utc: number, tz: string): number {
  try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(utc))) % 24; } catch { return new Date(utc).getUTCHours(); }
}
