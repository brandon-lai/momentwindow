// Horns: two-tone for ferries, a short toot for small boats. Sound starts
// only from a tap, so nothing plays until the visitor asks for it.
let ac: AudioContext | null = null;
export function horn(big: boolean) {
  try {
    ac = ac || new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ac.currentTime, out = ac.createGain(), lp = ac.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = big ? 520 : 900; out.connect(ac.destination); lp.connect(out);
    const dur = big ? 1.3 : 0.6;
    out.gain.setValueAtTime(0.0001, t); out.gain.exponentialRampToValueAtTime(0.13, t + 0.06); out.gain.setValueAtTime(0.13, t + (big ? 0.9 : 0.35)); out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const f of big ? [98, 147] : [196, 262]) { const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.connect(lp); o.start(t); o.stop(t + dur + 0.05); }
  } catch { /* sound is a bonus */ }
}
