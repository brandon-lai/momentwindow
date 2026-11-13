// Minimal CDP driver: open a page, run a JS expression against it, print the
// JSON result, and optionally screenshot. Dependency-free — no puppeteer.
//
//   node probe.mjs <url> '<expr>' [width] [height]
//   SHOT=/tmp/out.png node probe.mjs <url> '"ok"' 360 760
//
// Viewport is emulated rather than sized, because Chrome refuses window widths
// below roughly 500px and would otherwise hand you a 500px "mobile" check that
// silently proves nothing.
//
// Prefer this over `chrome --headless --screenshot --virtual-time-budget`:
// virtual time reorders layout effects and produces screenshots that do not
// match what a real browser renders.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , url, expr = '"ok"', width = "1200", height = "900"] = process.argv;
if (!url) {
  console.error("usage: node probe.mjs <url> '<expr>' [width] [height]");
  process.exit(2);
}

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// A fixed port collides with a probe that did not shut down cleanly.
const PORT = 9200 + Math.floor(Math.random() * 700);
const profile = join(tmpdir(), `cdp-probe-${PORT}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    // HEADFUL=1 opens a real window with the real GPU: the only way to time
    // WebGL painting as a laptop does (headless means SwiftShader, on the CPU).
    ...(process.env.HEADFUL ? ["--window-position=40,40"] : ["--headless=new"]),
    /*
     * Headless Chrome has no GPU, and --disable-gpu turns WebGL off entirely:
     * three.js throws "Error creating WebGL context" and the page never
     * renders, so a screenshot of a 3D app proves nothing. GL=1 swaps in
     * ANGLE's SwiftShader software rasteriser -- slow, but it produces the
     * pixels a real browser would.
     */
    ...(process.env.HEADFUL ? [] : process.env.GL
      ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle"]
      : ["--disable-gpu"]),
    /*
     * CAM=1 grants camera permission automatically and feeds a synthetic test
     * pattern, so a getUserMedia flow can be driven headless: the permission
     * path, the "no person detected" path and the teardown are all reachable.
     * It cannot test whether a real body is tracked correctly -- the fake
     * device contains no person -- which is exactly why it is useful for the
     * failure paths.
     *
     * The flag is --use-fake-device-for-media-STREAM. A misspelt variant
     * ("...-media-capture") is silently ignored, and --use-fake-ui auto-grants
     * permission, so the page gets the machine's REAL webcam. That happened
     * once; check the track label is "fake_device_0" before trusting a run.
     */
    ...(process.env.CAM
      ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]
      : []),
    "--hide-scrollbars",
    "--no-first-run",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

function done(code) {
  try { chrome.kill(); } catch {}
  process.exit(code);
}

let target;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {
    // Chrome is not listening yet.
  }
  await sleep(250);
}
if (!target) {
  console.error(`chrome never opened a debugging port (tried ${CHROME})`);
  done(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((resolve) => (ws.onopen = resolve));

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: Number(process.env.DPR ?? 1),
  mobile: Number(width) < 700,
});
await send("Page.navigate", { url });
await sleep(Number(process.env.SETTLE_MS ?? 4000));

// PRE runs before the screenshot, for apps whose first-run state hides the
// thing you came to look at (an onboarding sheet, a cookie banner) or that need
// driving before there is anything to see (clicking, dragging, painting). It
// may reload or await; PRE_SETTLE_MS covers what happens after.
if (process.env.PRE) {
  await send("Runtime.evaluate", { expression: process.env.PRE, awaitPromise: true });
  await sleep(Number(process.env.PRE_SETTLE_MS ?? 2500));
}

if (process.env.SHOT) {
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, "base64"));
}

const out = await send("Runtime.evaluate", {
  expression: `JSON.stringify(${expr})`,
  returnByValue: true,
  awaitPromise: true,
});
const value = out.result?.result?.value;
console.log(value ?? JSON.stringify(out.result));

ws.close();
done(0);
