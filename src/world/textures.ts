// Every texture in the game is synthesised here at start-up:
// tiling noise maps as raw pixel data, foliage sprites with the Canvas 2D API.
import * as THREE from 'three';
import { mulberry32, Rng, clamp } from '../core/math';

// ---------------------------------------------------------------- tiling noise
function tileNoise(size: number, cx: number, cy: number, rnd: Rng): Float32Array {
  const lat = new Float32Array(cx * cy);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cy, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty), iy1 = (iy + 1) % cy;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cx, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx), ix1 = (ix + 1) % cx;
      const a = lat[iy * cx + ix], b = lat[iy * cx + ix1], c = lat[iy1 * cx + ix], d = lat[iy1 * cx + ix1];
      out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
  }
  return out;
}

function tileFbm(size: number, cx: number, cy: number, oct: number, rnd: Rng): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5, tot = 0;
  for (let o = 0; o < oct; o++) {
    const n = tileNoise(size, Math.min(size, cx << o), Math.min(size, cy << o), rnd);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    tot += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

function dataTex(data: Uint8Array, w: number, h: number, srgb: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Colour + bump texture pair built from a per-pixel function returning [r,g,b,height] in 0..1. */
function proc(size: number, fn: (x: number, y: number) => [number, number, number, number]) {
  const col = new Uint8Array(size * size * 4), bmp = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const [r, g, b, h] = fn(x, y), i = (y * size + x) * 4;
    col[i] = clamp(r, 0, 1) * 255; col[i + 1] = clamp(g, 0, 1) * 255; col[i + 2] = clamp(b, 0, 1) * 255; col[i + 3] = 255;
    bmp[i] = bmp[i + 1] = bmp[i + 2] = clamp(h, 0, 1) * 255; bmp[i + 3] = 255;
  }
  return { map: dataTex(col, size, size, true), bump: dataTex(bmp, size, size, false) };
}

const mix3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Four independent tiling fbm channels; sampled by the terrain / water / sky shaders. */
export function makeNoiseTexture(): THREE.DataTexture {
  const S = 256, rnd = mulberry32(77);
  const ch = [tileFbm(S, 4, 4, 5, rnd), tileFbm(S, 6, 6, 5, rnd), tileFbm(S, 16, 16, 4, rnd), tileFbm(S, 5, 5, 3, rnd)];
  const d = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 4; c++) d[i * 4 + c] = ch[c][i] * 255;
  return dataTex(d, S, S, false);
}

export function makeGroundBump(): THREE.DataTexture {
  const S = 256, rnd = mulberry32(5);
  const a = tileFbm(S, 8, 8, 5, rnd), b = tileFbm(S, 40, 40, 2, rnd);
  const d = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) { const v = (a[i] * 0.6 + b[i] * 0.4) * 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  return dataTex(d, S, S, false);
}

export function makeBark() {
  const S = 256, rnd = mulberry32(11);
  const streak = tileFbm(S, 24, 3, 4, rnd), blotch = tileFbm(S, 5, 5, 4, rnd), fine = tileFbm(S, 64, 16, 2, rnd);
  return proc(S, (x, y) => {
    const i = y * S + x;
    const ridge = 1 - Math.abs(streak[i] - 0.5) * 2;              // furrows
    const h = Math.pow(ridge, 1.6) * 0.75 + fine[i] * 0.25;
    let c = mix3([0.13, 0.09, 0.065], [0.42, 0.36, 0.28], h);
    const lichen = clamp((blotch[i] - 0.56) * 6, 0, 1);
    c = mix3(c, [0.36, 0.44, 0.30], lichen * 0.55);
    const moss = clamp((1 - blotch[i] - 0.6) * 7, 0, 1);
    c = mix3(c, [0.10, 0.22, 0.05], moss * 0.7);
    return [c[0], c[1], c[2], h];
  });
}

/** Weathered stone. `bricks` adds mortar courses for the ruins. */
export function makeStone(bricks: boolean) {
  const S = 256, rnd = mulberry32(bricks ? 23 : 29);
  const base = tileFbm(S, 5, 5, 5, rnd), crack = tileFbm(S, 9, 9, 4, rnd), moss = tileFbm(S, 4, 4, 4, rnd), fine = tileFbm(S, 64, 64, 2, rnd);
  return proc(S, (x, y) => {
    const i = y * S + x;
    let h = base[i] * 0.6 + fine[i] * 0.4;
    const cr = clamp(1 - Math.abs(crack[i] - 0.5) * 22, 0, 1);
    h -= cr * 0.5;
    let c = mix3([0.30, 0.29, 0.26], [0.60, 0.58, 0.52], base[i] * 0.7 + fine[i] * 0.3);
    if (bricks) {
      const row = Math.floor(y / 64), bx = (x + (row % 2) * 64) % 128;
      const m = Math.min(y % 64, 63 - (y % 64), bx, 127 - bx);
      const mort = clamp(1 - m / 3.5, 0, 1);
      h -= mort * 0.7; c = mix3(c, [0.12, 0.12, 0.10], mort * 0.8);
    }
    c = mix3(c, [0.10, 0.10, 0.09], cr * 0.7);
    const ms = clamp((moss[i] - 0.5) * 5, 0, 1);
    c = mix3(c, [0.13, 0.25, 0.07], ms * 0.75);
    return [c[0], c[1], c[2], clamp(h + ms * 0.15, 0, 1)];
  });
}

/** Rusty corrugated sheet metal for the outpost. */
export function makeMetal() {
  const S = 256, rnd = mulberry32(41);
  const rust = tileFbm(S, 5, 5, 5, rnd), fine = tileFbm(S, 48, 48, 2, rnd), drip = tileFbm(S, 32, 3, 3, rnd);
  return proc(S, (x, y) => {
    const i = y * S + x;
    const wave = Math.sin((x / S) * Math.PI * 2 * 16) * 0.5 + 0.5;
    let c = mix3([0.20, 0.27, 0.24], [0.33, 0.40, 0.35], wave * 0.6 + fine[i] * 0.4);
    const r = clamp((rust[i] * 0.7 + drip[i] * 0.5 - 0.52) * 5, 0, 1);
    c = mix3(c, mix3([0.28, 0.12, 0.05], [0.50, 0.26, 0.10], fine[i]), r);
    return [c[0], c[1], c[2], wave * 0.8 + fine[i] * 0.2 - r * 0.15];
  });
}

/** Planked wood for crates. */
export function makeWood() {
  const S = 256, rnd = mulberry32(53);
  const grain = tileFbm(S, 3, 40, 3, rnd), tone = tileFbm(S, 4, 4, 3, rnd);
  return proc(S, (x, y) => {
    const i = y * S + x;
    const plank = Math.min(y % 64, 63 - (y % 64));
    const gap = clamp(1 - plank / 2.5, 0, 1);
    const edge = Math.min(x, y, S - 1 - x, S - 1 - y) < 14 ? 0.75 : 1;   // darker frame
    let c = mix3([0.30, 0.21, 0.11], [0.56, 0.43, 0.25], grain[i] * 0.7 + tone[i] * 0.3);
    c = mix3(c, [0.06, 0.04, 0.03], gap);
    return [c[0] * edge, c[1] * edge, c[2] * edge, grain[i] * 0.5 + 0.5 - gap * 0.6];
  });
}

// ---------------------------------------------------------------- foliage sprites
/** Convert a canvas to a mip-mapped texture, bleeding colour into transparent
 *  pixels so alpha-tested edges do not get dark fringes. Canvas bottom = v 0. */
function canvasTex(cv: HTMLCanvasElement, repeatV = false): THREE.DataTexture {
  const w = cv.width, h = cv.height;
  const src = cv.getContext('2d')!.getImageData(0, 0, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < src.length; i += 4) if (src[i + 3] > 200) { r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
  r /= n || 1; g /= n || 1; b /= n || 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4, a = src[s + 3] / 255;
    out[d] = src[s] * a + r * (1 - a); out[d + 1] = src[s + 1] * a + g * (1 - a); out[d + 2] = src[s + 2] * a + b * (1 - a);
    out[d + 3] = src[s + 3];
  }
  const t = dataTex(out, w, h, true);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = repeatV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  return t;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  return [cv, cv.getContext('2d')!];
}

/** One pointed leaf growing from the origin along +Y of the current transform. */
function leafShape(ctx: CanvasRenderingContext2D, len: number, wid: number, hue: number, light: number, veins = true) {
  const grad = ctx.createLinearGradient(0, 0, 0, len);
  grad.addColorStop(0, `hsl(${hue},58%,${light * 0.75}%)`);
  grad.addColorStop(1, `hsl(${hue + 8},62%,${light * 1.15}%)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid, len * 0.2, wid * 0.85, len * 0.7, 0, len);
  ctx.bezierCurveTo(-wid * 0.85, len * 0.7, -wid, len * 0.2, 0, 0);
  ctx.fill();
  if (veins) {
    ctx.strokeStyle = `hsla(${hue + 15},50%,${light * 1.6}%,0.55)`;
    ctx.lineWidth = Math.max(1, wid * 0.05);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, len * 0.96); ctx.stroke();
    ctx.lineWidth = Math.max(0.6, wid * 0.025);
    for (let k = 1; k < 6; k++) {
      const y = (len * k) / 7, s = wid * 0.62 * Math.sin((k / 7) * Math.PI);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y + len * 0.1); ctx.moveTo(0, y); ctx.lineTo(-s, y + len * 0.1); ctx.stroke();
    }
  }
}

function makeCluster(seed: number, hueBase: number): THREE.DataTexture {
  const S = 512, [cv, ctx] = canvas(S, S), rnd = mulberry32(seed);
  // back-to-front: dark inner leaves first, bright outer leaves last
  for (let pass = 0; pass < 3; pass++) {
    const count = [26, 22, 16][pass];
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 150;
      const len = 95 + rnd() * 70, wid = len * (0.22 + rnd() * 0.12);
      ctx.save();
      ctx.translate(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d);
      ctx.rotate(a - Math.PI / 2 + (rnd() - 0.5) * 1.6);
      ctx.translate(0, -len * 0.5);
      leafShape(ctx, len, wid, hueBase + rnd() * 30 - 8, 15 + pass * 7 + rnd() * 6);
      ctx.restore();
    }
  }
  return canvasTex(cv);
}

/** Pinnate frond (palm / fern): rib along the canvas, leaflets either side. */
function makeFrond(seed: number, step: number, leafW: number, hue: number, light: number): THREE.DataTexture {
  const W = 256, H = 512, [cv, ctx] = canvas(W, H), rnd = mulberry32(seed);
  for (let y = H - 14; y > 12; y -= step) {
    const t = 1 - y / H;                                   // 0 base .. 1 tip
    const prof = Math.pow(Math.sin(Math.PI * (0.1 + 0.88 * t)), 0.55) * (1 - t * 0.35);
    for (const side of [-1, 1]) {
      const len = W * 0.47 * prof * (0.88 + rnd() * 0.2);
      ctx.save();
      ctx.translate(W / 2, y);
      ctx.rotate(side * (-Math.PI / 2 + 0.38 + t * 0.35 + (rnd() - 0.5) * 0.12) + Math.PI);
      leafShape(ctx, len, leafW * (0.8 + rnd() * 0.5), hue + rnd() * 18, light + rnd() * 9, false);
      ctx.restore();
    }
  }
  ctx.strokeStyle = `hsl(${hue - 20},40%,${light * 0.9}%)`; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(W / 2, H); ctx.lineTo(W / 2, 10); ctx.stroke();
  return canvasTex(cv);
}

/** Single large banana-style leaf with torn edges. */
function makeBroad(): THREE.DataTexture {
  const W = 256, H = 512, [cv, ctx] = canvas(W, H), rnd = mulberry32(91);
  ctx.save(); ctx.translate(W / 2, H - 4); ctx.scale(1, -1);
  leafShape(ctx, H - 12, W * 0.62, 104, 24, false);
  ctx.strokeStyle = 'hsla(95,45%,42%,0.6)'; ctx.lineWidth = 1.4;
  for (let y = 30; y < H - 40; y += 9) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W * 0.5, y + 34); ctx.moveTo(0, y); ctx.lineTo(-W * 0.5, y + 34); ctx.stroke(); }
  ctx.strokeStyle = 'hsl(88,48%,46%)'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, H - 20); ctx.stroke();
  // tears
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 9; i++) {
    const y = 60 + rnd() * (H - 160), s = rnd() < 0.5 ? -1 : 1;
    ctx.beginPath(); ctx.moveTo(s * W * 0.5, y + 44); ctx.lineTo(s * (12 + rnd() * 40), y); ctx.lineTo(s * W * 0.5, y + 44 + 6 + rnd() * 10); ctx.fill();
  }
  ctx.restore();
  return canvasTex(cv);
}

/** Hanging vine strip, tiles vertically. */
function makeVine(): THREE.DataTexture {
  const W = 128, H = 512, [cv, ctx] = canvas(W, H), rnd = mulberry32(63);
  const sx = (y: number) => W / 2 + Math.sin((y / H) * Math.PI * 4) * 12 + Math.sin((y / H) * Math.PI * 10) * 4;
  ctx.strokeStyle = 'hsl(70,35%,17%)'; ctx.lineWidth = 6;
  ctx.beginPath(); for (let y = 0; y <= H; y += 4) ctx.lineTo(sx(y), y); ctx.stroke();
  ctx.strokeStyle = 'hsl(80,40%,24%)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); for (let y = 0; y <= H; y += 4) ctx.lineTo(sx(y) + 3 * Math.sin(y * 0.2), y); ctx.stroke();
  for (let y = 12; y < H - 30; y += 20 + rnd() * 16) {
    const side = rnd() < 0.5 ? -1 : 1;
    ctx.save(); ctx.translate(sx(y), y); ctx.rotate(side * (0.9 + rnd() * 0.7));
    leafShape(ctx, 30 + rnd() * 20, 12 + rnd() * 6, 92 + rnd() * 26, 20 + rnd() * 12);
    ctx.restore();
  }
  return canvasTex(cv, true);
}

/** Fan of grass blades. */
function makeGrass(): THREE.DataTexture {
  const S = 256, [cv, ctx] = canvas(S, S), rnd = mulberry32(17);
  for (let i = 0; i < 26; i++) {
    const x0 = S / 2 + (rnd() - 0.5) * 90, lean = (rnd() - 0.5) * 150, h = 110 + rnd() * 135, w = 5 + rnd() * 6;
    const g = ctx.createLinearGradient(0, S, 0, S - h);
    const hue = 78 + rnd() * 30, l = 14 + rnd() * 14;
    g.addColorStop(0, `hsl(${hue},55%,${l * 0.6}%)`); g.addColorStop(1, `hsl(${hue + 6},60%,${l * 1.5}%)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0 - w, S); ctx.quadraticCurveTo(x0 + lean * 0.3, S - h * 0.6, x0 + lean, S - h);
    ctx.quadraticCurveTo(x0 + lean * 0.3 + w, S - h * 0.55, x0 + w, S); ctx.fill();
  }
  return canvasTex(cv);
}

/** Soft radial glow used for the muzzle flash and beacons. */
export function makeGlow(): THREE.CanvasTexture {
  const S = 128, [cv, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,220,160,0.75)'); g.addColorStop(1, 'rgba(255,120,30,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  // star streaks
  ctx.globalCompositeOperation = 'lighter'; ctx.translate(S / 2, S / 2);
  for (let i = 0; i < 5; i++) {
    ctx.rotate((Math.PI * 2) / 5 + 0.3);
    const lg = ctx.createLinearGradient(0, 0, S / 2, 0); lg.addColorStop(0, 'rgba(255,240,200,0.9)'); lg.addColorStop(1, 'rgba(255,160,60,0)');
    ctx.fillStyle = lg; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(S / 2, 0); ctx.lineTo(0, 5); ctx.fill();
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export interface TextureSet {
  noise: THREE.DataTexture; groundBump: THREE.DataTexture;
  bark: { map: THREE.DataTexture; bump: THREE.DataTexture };
  rock: { map: THREE.DataTexture; bump: THREE.DataTexture };
  brick: { map: THREE.DataTexture; bump: THREE.DataTexture };
  metal: { map: THREE.DataTexture; bump: THREE.DataTexture };
  wood: { map: THREE.DataTexture; bump: THREE.DataTexture };
  cluster: THREE.DataTexture; cluster2: THREE.DataTexture;
  palm: THREE.DataTexture; fern: THREE.DataTexture; broad: THREE.DataTexture;
  vine: THREE.DataTexture; grass: THREE.DataTexture; glow: THREE.Texture;
}

export function makeTextures(): TextureSet {
  return {
    noise: makeNoiseTexture(), groundBump: makeGroundBump(),
    bark: makeBark(), rock: makeStone(false), brick: makeStone(true), metal: makeMetal(), wood: makeWood(),
    cluster: makeCluster(3, 98), cluster2: makeCluster(8, 82),
    palm: makeFrond(21, 15, 13, 96, 22), fern: makeFrond(22, 9, 7, 104, 25), broad: makeBroad(),
    vine: makeVine(), grass: makeGrass(), glow: makeGlow(),
  };
}
