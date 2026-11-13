// Ripples: a height field on a 210 x 280 grid (rows squashed 2:1 so rings
// look flat in perspective), stepped on the page, shown by the water shader.
import { CW, CH, M, PI } from "../paint/util.ts";

export interface Sim { gw: number; gh: number; wet: Uint8Array; bytes: Uint8Array; energy: number; isWet(px: number, py: number): boolean; drop(px: number, py: number, amp: number, rad: number): void; step(): void; clear(): void }

export function makeSim(gw: number, gh: number, mask: CanvasImageSource): Sim {
  const c = document.createElement("canvas"); c.width = gw; c.height = gh; const g = c.getContext("2d")!; g.drawImage(mask, 0, 0, gw, gh);
  const d = g.getImageData(0, 0, gw, gh).data, wet = new Uint8Array(gw * gh);
  const cw = CW / gw, ch = CH / gh, mx = Math.ceil(M / cw) + 1, my = Math.ceil(M / ch) + 1;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { const i = y * gw + x; wet[i] = d[i * 4 + 3] > 140 && x > mx && x < gw - mx && y > my && y < gh - my ? 1 : 0; }
  let cur = new Float32Array(gw * gh), prev = new Float32Array(gw * gh);
  const bytes = new Uint8Array(gw * gh).fill(128);
  const sim: Sim = {
    gw, gh, wet, bytes, energy: 0,
    isWet(px, py) { const x = Math.floor(px / cw), y = Math.floor(py / ch); return x >= 0 && y >= 0 && x < gw && y < gh && wet[y * gw + x] === 1; },
    drop(px, py, amp, rad) {
      const gx = px / cw, gy = py / ch, r = Math.ceil(rad);
      for (let y = Math.floor(gy - r); y <= gy + r; y++) for (let x = Math.floor(gx - r); x <= gx + r; x++) {
        if (x < 1 || y < 1 || x >= gw - 1 || y >= gh - 1) continue;
        const i = y * gw + x; if (!wet[i]) continue;
        const dd = Math.hypot(x - gx, y - gy); if (dd > rad) continue;
        cur[i] += amp * (0.5 + 0.5 * Math.cos(PI * dd / rad));
      }
      sim.energy = 420;
    },
    step() {
      const damp = 0.984;
      for (let y = 1; y < gh - 1; y++) { let i = y * gw + 1; for (let x = 1; x < gw - 1; x++, i++) { if (!wet[i]) { prev[i] = 0; continue; } prev[i] = ((cur[i - 1] + cur[i + 1] + cur[i - gw] + cur[i + gw]) * 0.5 - prev[i]) * damp; } }
      const t = cur; cur = prev; prev = t;
      for (let i = 0; i < cur.length; i++) { const v = 128 + cur[i]; bytes[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
    },
    clear() { cur.fill(0); prev.fill(0); bytes.fill(128); },
  };
  return sim;
}
