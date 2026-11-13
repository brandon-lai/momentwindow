// One base palette with overrides per weather and light (the prototype's,
// plus rain, overcast and night, which the prototype never needed).
import type { C3 } from "./util.ts";

export interface Pal {
  paper: C3; water: C3; waterDeep: C3; waterLight: C3; waterGreen: C3; waterShallow: C3 | null;
  ground: C3; groundRose: C3; groundDark: C3; warmLight: C3; coolAir: C3;
  grass: C3; olive: C3; blueGreen: C3; tree: C3; treeDark: C3; autumn: C3[];
  shadow: C3; shadowAlpha: number; amb: number; dif: number;
  sky: [C3, C3]; haze: C3; hazeAmt: number;
  glass: C3[]; warm: C3[]; pale: C3[]; roofFlat: C3[];
  sunlit: C3; pencil: C3; lights: C3;
  night: boolean; glints: boolean; clouds: boolean; groundTint: C3 | null; snow?: boolean; key: string; dark?: number;
}

export const BASE: Pal = {
  key: "clearing",
  paper: [249, 247, 242],
  water: [88, 138, 178], waterDeep: [38, 62, 122], waterLight: [152, 192, 214], waterGreen: [98, 150, 150], waterShallow: null,
  ground: [222, 206, 178], groundRose: [214, 186, 176], groundDark: [150, 128, 104],
  warmLight: [240, 212, 166], coolAir: [196, 198, 226],
  grass: [138, 168, 106], olive: [160, 166, 100], blueGreen: [108, 150, 122],
  tree: [82, 120, 84], treeDark: [62, 96, 80], autumn: [[176, 112, 60], [196, 150, 70], [150, 92, 62], [126, 124, 70]],
  shadow: [112, 112, 186], shadowAlpha: 0.42, amb: 0.64, dif: 0.44,
  sky: [[168, 196, 222], [228, 232, 234]], haze: [214, 222, 232], hazeAmt: 0.55,
  glass: [[122, 158, 202], [142, 174, 212], [112, 146, 196]],
  warm: [[222, 162, 132], [226, 188, 114], [206, 144, 124], [198, 182, 174], [218, 174, 150]],
  pale: [[232, 214, 188], [222, 208, 204], [236, 214, 170]],
  roofFlat: [[200, 194, 188], [184, 182, 184], [210, 198, 182]],
  sunlit: [238, 196, 122], pencil: [62, 60, 70], lights: [255, 196, 120],
  night: false, glints: true, clouds: true, groundTint: null,
};

const O: Record<string, Partial<Pal>> = {
  clearing: {},
  fog: { water: [140, 162, 178], waterDeep: [92, 112, 142], waterLight: [192, 206, 214], waterGreen: [140, 162, 160], shadowAlpha: 0.16, amb: 0.82, dif: 0.16,
    sky: [[210, 214, 220], [238, 238, 236]], haze: [238, 238, 236], hazeAmt: 0.82, glints: false, clouds: false, groundTint: [244, 244, 244] },
  drizzle: { water: [104, 128, 132], waterDeep: [58, 74, 92], waterLight: [162, 178, 180], waterGreen: [110, 132, 120], ground: [206, 202, 192], groundRose: [200, 190, 184],
    shadowAlpha: 0.12, amb: 0.84, dif: 0.1, sky: [[192, 198, 204], [222, 224, 226]], haze: [220, 222, 224], hazeAmt: 0.66, glints: false, clouds: false, grass: [126, 150, 104], groundTint: [238, 238, 240] },
  rain: { water: [92, 112, 122], waterDeep: [48, 62, 84], waterLight: [148, 164, 170], waterGreen: [98, 120, 112], ground: [194, 192, 186], groundRose: [190, 182, 178], groundDark: [120, 112, 108],
    shadowAlpha: 0.08, amb: 0.86, dif: 0.08, sky: [[164, 172, 182], [208, 210, 214]], haze: [204, 208, 212], hazeAmt: 0.72, glints: false, clouds: false, grass: [118, 140, 102], groundTint: [228, 230, 234] },
  overcast: { water: [112, 140, 152], waterDeep: [62, 80, 104], waterLight: [170, 186, 196], shadowAlpha: 0.14, amb: 0.82, dif: 0.14,
    sky: [[198, 204, 212], [230, 230, 230]], haze: [222, 224, 228], hazeAmt: 0.6, glints: false, clouds: false, groundTint: [242, 242, 244] },
  dusk: { water: [62, 74, 128], waterDeep: [30, 34, 80], waterLight: [124, 112, 164], waterGreen: [70, 86, 124], ground: [156, 146, 182], groundRose: [174, 146, 174], groundDark: [92, 82, 124],
    warmLight: [214, 170, 190], coolAir: [124, 124, 184], shadowAlpha: 0, amb: 0.58, dif: 0, sky: [[52, 62, 128], [238, 156, 118]], haze: [170, 142, 174], hazeAmt: 0.45,
    glass: [[100, 108, 156], [116, 122, 168], [92, 100, 150]], warm: [[156, 120, 146], [138, 112, 140], [166, 132, 134], [126, 118, 150]], pale: [[176, 160, 182], [164, 154, 176]],
    roofFlat: [[124, 118, 154], [112, 110, 144]], tree: [60, 72, 98], treeDark: [46, 52, 82], autumn: [[112, 80, 100], [124, 92, 96]], grass: [98, 112, 124], pencil: [40, 36, 64],
    night: true, glints: false, clouds: false, groundTint: [196, 188, 226] },
  // Night: a moonlit indigo, a step darker than dusk, never black. The lamps
  // and windows carry it. (PRD open question: answered here.)
  night: { water: [44, 52, 98], waterDeep: [22, 24, 60], waterLight: [92, 96, 140], waterGreen: [50, 64, 100], ground: [120, 116, 156], groundRose: [132, 118, 150], groundDark: [70, 64, 104],
    warmLight: [170, 150, 190], coolAir: [96, 100, 160], shadowAlpha: 0, amb: 0.5, dif: 0, sky: [[26, 30, 74], [84, 84, 140]], haze: [110, 106, 150], hazeAmt: 0.4,
    glass: [[76, 84, 130], [88, 96, 142], [70, 76, 124]], warm: [[118, 100, 130], [108, 94, 126], [126, 108, 122], [100, 98, 132]], pale: [[136, 128, 160], [128, 124, 156]],
    roofFlat: [[96, 94, 132], [88, 88, 124]], tree: [44, 54, 82], treeDark: [34, 40, 70], autumn: [[86, 66, 88], [94, 74, 84]], grass: [72, 86, 104], pencil: [30, 28, 54],
    night: true, glints: false, clouds: false, groundTint: [168, 164, 210], dark: 1 },
  clear: { ground: [176, 196, 124], groundRose: [190, 200, 140], groundDark: [110, 130, 80], sky: [[146, 188, 226], [228, 236, 240]], shadowAlpha: 0.46 },
  golden: { warmLight: [250, 200, 120], sky: [[150, 176, 214], [250, 214, 170]], haze: [244, 216, 180], ground: [214, 196, 150], shadow: [118, 104, 170], shadowAlpha: 0.5,
    amb: 0.6, dif: 0.52, water: [96, 140, 160], groundTint: [252, 240, 222] },
  snow: { ground: [240, 242, 248], groundRose: [232, 236, 246], groundDark: [150, 160, 190], water: [110, 140, 152], waterDeep: [60, 84, 104], waterLight: [170, 190, 200],
    shadow: [120, 132, 190], shadowAlpha: 0.18, amb: 0.8, dif: 0.16, sky: [[198, 204, 214], [232, 234, 238]], haze: [234, 236, 240], hazeAmt: 0.72, glints: false, clouds: false,
    tree: [52, 82, 72], treeDark: [40, 64, 62], snow: true },
  bright: { water: [56, 150, 190], waterDeep: [24, 74, 150], waterLight: [120, 206, 214], waterGreen: [70, 184, 184], waterShallow: [120, 214, 206],
    ground: [230, 214, 178], groundRose: [226, 200, 170], groundDark: [170, 150, 110], shadow: [120, 140, 210], shadowAlpha: 0.5, amb: 0.62, dif: 0.48,
    sky: [[110, 170, 224], [222, 234, 240]], haze: [214, 228, 236], hazeAmt: 0.42, olive: [138, 146, 96] },
};

export function palette(key: string, snowOnGround = false): Pal {
  const p = { ...BASE, ...(O[key] || {}), key } as Pal;
  if (snowOnGround && !p.snow) {
    // snow lying under a clear or dark sky: the ground and roofs go white,
    // the sky keeps the light of the moment
    Object.assign(p, { ground: p.night ? [176, 178, 214] : [240, 242, 248], groundRose: p.night ? [168, 170, 206] : [232, 236, 246], groundDark: [150, 160, 190], snow: true });
  }
  return p;
}
