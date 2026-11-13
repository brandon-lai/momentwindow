import { fromUrl } from "geotiff";
const urls = process.argv.slice(2);
for (const u of urls) {
  const t0 = Date.now();
  try {
    const tif = await fromUrl(u);
    const n = await tif.getImageCount();
    const im = await tif.getImage(0);
    const fd = im.fileDirectory;
    console.log(u.split("/").slice(-1)[0], { n, w: im.getWidth(), h: im.getHeight(), tile: [im.getTileWidth(), im.getTileHeight()], spp: im.getSamplesPerPixel(), bps: im.getBitsPerSample?.(), compression: fd.Compression ?? fd.getValue?.("Compression"), origin: im.getOrigin(), res: im.getResolution(), epsg: im.geoKeys?.ProjectedCSTypeGeoKey || im.geoKeys?.GeographicTypeGeoKey, ms: Date.now() - t0 });
    const t1 = Date.now(); const r = await im.readRasters({ window: [1000, 1000, 1200, 1200] });
    console.log("  read 200x200 in", Date.now() - t1, "ms, bands", r.length, "sample", r[0][0]);
  } catch (e) { console.log(u, "ERR", e.message); }
}
