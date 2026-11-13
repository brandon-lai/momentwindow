// The painting's Web Worker. Layers go back to the page as ImageBitmaps.
import { paintAll, type Layer, type PaintMeta } from "./pipeline.ts";
import type { SceneBundle } from "../../../shared/bundle.ts";
import type { Moment } from "../moment.ts";

interface Job { id: number; bundle: SceneBundle; moment: Moment; seed: number; scale: number }
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<Job>) => {
  const { id, bundle, moment, seed, scale } = ev.data;
  try {
    if (typeof OffscreenCanvas === "undefined" || !new OffscreenCanvas(1, 1).getContext("webgl")) { post({ id, kind: "unsupported" }); return; }
    await paintAll(bundle, moment, seed, scale, {
      async layer(name: Layer, c) { const bm = await createImageBitmap(c as OffscreenCanvas); post({ id, kind: "layer", name, bm }, [bm]); },
      meta(m: PaintMeta) { post({ id, kind: "meta", meta: m }, [m.zbuf.buffer]); },
    });
    post({ id, kind: "done" });
  } catch (err) {
    post({ id, kind: "error", message: String((err as Error)?.stack ?? err) });
  }
};
