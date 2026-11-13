// WebGL, ported from the prototype: the 3D ground (terrain mesh textured
// with the ground painting, lit at 2x contrast, hazed with distance) and the
// living water (the painting displaced by a ripple height field inside the
// water mask, with slow ambient flow).
import { CW, CH, SC, canvas, cx, mix, type Cnv } from "./util.ts";
import type { World } from "./scene.ts";
import type { Cam, GroundOut } from "./paint.ts";

export interface GLR {
  canvas: Cnv;
  renderGround(sc: World, cam: Cam, gd: GroundOut): { color: Cnv; water: Cnv };
  attach(paint: TexImageSource, mask: TexImageSource, gw: number, gh: number, bytes: Uint8Array): void;
  present(t: number, flow: number, light: [number, number], seed: number, bytes: Uint8Array | null, gw: number, gh: number): void;
}

export function createGLR(target?: Cnv): GLR | null {
  try {
    const cvs = target ?? canvas(Math.round(CW * SC), Math.round(CH * SC));
    const gl = (cvs as HTMLCanvasElement).getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: true, alpha: true, depth: true }) as WebGLRenderingContext | null;
    if (!gl) return null;
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic") || gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
    const sh = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader"); return s; };
    const program = (vs: string, fs: string, attribs: string[]) => {
      const p = gl.createProgram()!; gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
      const u: Record<string, WebGLUniformLocation> = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i)!; u[info.name] = gl.getUniformLocation(p, info.name)!; }
      return { p, u };
    };
    const texture = (src: TexImageSource | null, opts: { mip?: boolean } = {}) => {
      const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      if (opts.mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT))); }
      else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const pot = (src: Cnv, w: number, h: number) => { const c = canvas(w, h), g = cx(c); g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, w, h); return c; };

    const groundP = program(`
      attribute vec3 aPos; attribute vec3 aNrm;
      uniform vec3 uCam; uniform float uCos, uSin, uF; uniform vec2 uHalf, uSize;
      varying vec2 vUv; varying vec3 vN; varying float vDist; varying vec2 vW;
      void main(){
        vec3 d = aPos - uCam;
        float yc = d.y * uSin + d.z * uCos, zc = d.y * uCos - d.z * uSin;
        vUv = vec2(aPos.x / uSize.x, 1.0 - aPos.y / uSize.y);
        vN = aNrm; vDist = zc; vW = aPos.xy;
        float n = 5.0, f = 400000.0;
        gl_Position = vec4(uF * d.x / uHalf.x, uF * yc / uHalf.y, (f + n) / (f - n) * zc - 2.0 * f * n / (f - n), zc);
      }`, `
      precision highp float;
      uniform sampler2D uTex, uWater;
      uniform vec3 uSun, uShadowCol, uWarm, uHaze, uRockCol;
      uniform float uRock, uAmb, uDif, uHazeAmt, uNear, uFar, uMode, uFade;
      uniform vec2 uSize;
      varying vec2 vUv; varying vec3 vN; varying float vDist; varying vec2 vW;
      void main(){
        float a = smoothstep(uSize.y, uSize.y - uFade, vW.y) * smoothstep(0.0, uSize.x * 0.035, vW.x) * smoothstep(uSize.x, uSize.x * 0.965, vW.x);
        if (uMode > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, texture2D(uWater, vUv).a * a); return; }
        vec3 c = texture2D(uTex, vUv).rgb;
        vec3 n = normalize(vN);
        float lit = uAmb + uDif * max(dot(n, uSun), 0.0), flt = uAmb + uDif * max(uSun.z, 0.0), k = lit / flt;
        c = mix(c, uRockCol, smoothstep(0.3, 0.62, 1.0 - n.z) * uRock);
        c = mix(c, c * uShadowCol, clamp((1.0 - k) * 2.0, 0.0, 0.85));
        c = mix(c, uWarm, clamp((k - 1.0) * 0.6, 0.0, 0.22));
        c = mix(c, uHaze, smoothstep(uNear, uFar, vDist) * uHazeAmt);
        gl_FragColor = vec4(c, a);
      }`, ["aPos", "aNrm"]);

    function renderGround(sc: World, cam: Cam, gd: GroundOut) {
      const pal = sc.pal, H = sc.H, nx = 170, ny = 120;
      const pos = new Float32Array((nx + 1) * (ny + 1) * 3), nrm = new Float32Array(pos.length), e = 2;
      for (let j = 0, k = 0; j <= ny; j++) for (let i = 0; i <= nx; i++, k += 3) {
        const x = i / nx * sc.W, y = j / ny * sc.D;
        pos[k] = x; pos[k + 1] = y; pos[k + 2] = H(x, y);
        const gx = -(H(x + e, y) - H(x - e, y)) / (2 * e), gy = -(H(x, y + e) - H(x, y - e)) / (2 * e), l = Math.hypot(gx, gy, 1);
        nrm[k] = gx / l; nrm[k + 1] = gy / l; nrm[k + 2] = 1 / l;
      }
      const idx = new Uint16Array(nx * ny * 6);
      for (let j = 0, k = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx.set([a, b, c, b, d, c], k); k += 6; }
      const bufs = [gl!.createBuffer(), gl!.createBuffer(), gl!.createBuffer()];
      gl!.bindBuffer(gl!.ARRAY_BUFFER, bufs[0]); gl!.bufferData(gl!.ARRAY_BUFFER, pos, gl!.STATIC_DRAW); gl!.enableVertexAttribArray(0); gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, bufs[1]); gl!.bufferData(gl!.ARRAY_BUFFER, nrm, gl!.STATIC_DRAW); gl!.enableVertexAttribArray(1); gl!.vertexAttribPointer(1, 3, gl!.FLOAT, false, 0, 0);
      gl!.bindBuffer(gl!.ELEMENT_ARRAY_BUFFER, bufs[2]); gl!.bufferData(gl!.ELEMENT_ARRAY_BUFFER, idx, gl!.STATIC_DRAW);
      gl!.activeTexture(gl!.TEXTURE0); const tTex = texture(pot(gd.tex, 2048, 2048) as TexImageSource, { mip: true });
      gl!.activeTexture(gl!.TEXTURE1); const tWat = texture(pot(gd.wmask, 1024, 1024) as TexImageSource, { mip: true });
      const { p, u } = groundP; gl!.useProgram(p);
      gl!.uniform1i(u.uTex, 0); gl!.uniform1i(u.uWater, 1);
      gl!.uniform3f(u.uCam, cam.x, cam.y, cam.z); gl!.uniform1f(u.uCos, cam.cos); gl!.uniform1f(u.uSin, cam.sin); gl!.uniform1f(u.uF, cam.F);
      gl!.uniform2f(u.uHalf, CW / 2, CH / 2); gl!.uniform2f(u.uSize, sc.W, sc.D);
      const L = sc.reliefV; gl!.uniform3f(u.uSun, L[0], L[1], L[2]);
      const shc = mix(pal.shadow, [255, 255, 255], 0.25).map(v => v / 255); gl!.uniform3f(u.uShadowCol, shc[0], shc[1], shc[2]);
      gl!.uniform3f(u.uWarm, pal.warmLight[0] / 255, pal.warmLight[1] / 255, pal.warmLight[2] / 255); gl!.uniform3f(u.uHaze, pal.haze[0] / 255, pal.haze[1] / 255, pal.haze[2] / 255);
      gl!.uniform1f(u.uAmb, Math.min(pal.amb, 0.5)); gl!.uniform1f(u.uDif, sc.reliefDif); gl!.uniform1f(u.uHazeAmt, pal.hazeAmt * 0.85);
      gl!.uniform1f(u.uNear, cam.near); gl!.uniform1f(u.uFar, cam.far * 1.05); gl!.uniform1f(u.uFade, sc.D * sc.farFade); gl!.uniform1f(u.uRock, sc.rock ? 1 : 0); gl!.uniform3f(u.uRockCol, 0.55, 0.56, 0.62);
      gl!.viewport(0, 0, cvs.width, cvs.height); gl!.enable(gl!.DEPTH_TEST); gl!.disable(gl!.BLEND);
      const grab = () => { const c = canvas(cvs.width, cvs.height); cx(c).drawImage(cvs as any, 0, 0); return c; };
      gl!.clearColor(0, 0, 0, 0);
      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT); gl!.uniform1f(u.uMode, 0); gl!.drawElements(gl!.TRIANGLES, idx.length, gl!.UNSIGNED_SHORT, 0);
      const color = grab();
      gl!.clear(gl!.COLOR_BUFFER_BIT | gl!.DEPTH_BUFFER_BIT); gl!.uniform1f(u.uMode, 1); gl!.drawElements(gl!.TRIANGLES, idx.length, gl!.UNSIGNED_SHORT, 0);
      const water = grab();
      gl!.disable(gl!.DEPTH_TEST); gl!.disableVertexAttribArray(1);
      bufs.forEach(b => gl!.deleteBuffer(b)); gl!.deleteTexture(tTex); gl!.deleteTexture(tWat);
      return { color, water };
    }

    const rippleP = program(`attribute vec2 p; varying vec2 vUv; void main(){ vUv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.,1.); }`, `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uPaint, uMask, uH;
      uniform vec2 uHTexel, uLight;
      uniform float uTime, uFlow, uSeed;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
        return mix(mix(hash(i), hash(i+vec2(1.,0.)), f.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), f.x), f.y); }
      void main(){
        vec2 uv = vUv;
        float m = texture2D(uMask, uv).a;
        float hx = texture2D(uH, uv + vec2(uHTexel.x, 0.)).r - texture2D(uH, uv - vec2(uHTexel.x, 0.)).r;
        float hy = texture2D(uH, uv + vec2(0., uHTexel.y)).r - texture2D(uH, uv - vec2(0., uHTexel.y)).r;
        vec2 g = vec2(hx, hy);
        vec2 q = uv * vec2(7., 4.6) + uSeed;
        vec2 flow = vec2(noise(q + vec2(uTime*0.07, uTime*0.02)) - 0.5, noise(q*1.3 + vec2(4.1, -uTime*0.05)) - 0.5);
        vec2 off = m * (g * 0.014 + flow * 0.003 * uFlow);
        vec3 c = texture2D(uPaint, uv + off).rgb;
        float s = dot(g, uLight) * 7.0 * m;
        vec3 paper = vec3(0.976, 0.969, 0.949), deep = vec3(0.16, 0.25, 0.5);
        c = mix(c, paper, clamp(s, 0., 1.) * 0.42);
        c = mix(c, c * deep * 1.7, clamp(-s, 0., 1.) * 0.3);
        c *= 1.0 - m * (noise(uv * 3.0 + vec2(uTime * 0.03, -uTime * 0.02)) - 0.5) * 0.05 * uFlow;
        gl_FragColor = vec4(c, 1.);
      }`, ["p"]);
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    let tex: { paint: WebGLTexture; mask: WebGLTexture; h: WebGLTexture } | null = null;

    function attach(paint: TexImageSource, mask: TexImageSource, gw: number, gh: number, bytes: Uint8Array) {
      if (tex) { gl!.deleteTexture(tex.paint); gl!.deleteTexture(tex.mask); gl!.deleteTexture(tex.h); }
      gl!.activeTexture(gl!.TEXTURE0);
      tex = { paint: texture(paint), mask: texture(mask), h: gl!.createTexture()! };
      gl!.bindTexture(gl!.TEXTURE_2D, tex.h);
      for (const [k, v] of [[gl!.TEXTURE_MIN_FILTER, gl!.LINEAR], [gl!.TEXTURE_MAG_FILTER, gl!.LINEAR], [gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE], [gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE]]) gl!.texParameteri(gl!.TEXTURE_2D, k, v);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.LUMINANCE, gw, gh, 0, gl!.LUMINANCE, gl!.UNSIGNED_BYTE, bytes);
    }
    function present(t: number, flow: number, light: [number, number], seed: number, bytes: Uint8Array | null, gw: number, gh: number) {
      if (!tex) return;
      const { p, u } = rippleP; gl!.useProgram(p);
      gl!.bindBuffer(gl!.ARRAY_BUFFER, quad); gl!.enableVertexAttribArray(0); gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 0, 0); gl!.disableVertexAttribArray(1);
      gl!.activeTexture(gl!.TEXTURE0); gl!.bindTexture(gl!.TEXTURE_2D, tex.paint);
      gl!.activeTexture(gl!.TEXTURE1); gl!.bindTexture(gl!.TEXTURE_2D, tex.mask);
      gl!.activeTexture(gl!.TEXTURE2); gl!.bindTexture(gl!.TEXTURE_2D, tex.h);
      if (bytes) gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, gw, gh, gl!.LUMINANCE, gl!.UNSIGNED_BYTE, bytes);
      gl!.uniform1i(u.uPaint, 0); gl!.uniform1i(u.uMask, 1); gl!.uniform1i(u.uH, 2);
      gl!.uniform2f(u.uHTexel, 1 / gw, 1 / gh);
      gl!.uniform2f(u.uLight, light[0], light[1]);
      gl!.uniform1f(u.uTime, t); gl!.uniform1f(u.uFlow, flow); gl!.uniform1f(u.uSeed, seed);
      gl!.viewport(0, 0, cvs.width, cvs.height); gl!.disable(gl!.DEPTH_TEST);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    }
    return { canvas: cvs, renderGround, attach, present };
  } catch (err) {
    console.error(err);
    return null;
  }
}
