// Generates the PWA icons procedurally (no image assets, no dependencies):
// a per-pixel drawing routine plus a minimal PNG encoder on top of zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const LEAVES = [  // x, y, angle, length, width, colour
  [-0.95, 0.75, -0.95, 1.5, 0.30, [0.10, 0.30, 0.13]], [0.95, 0.8, -2.2, 1.45, 0.28, [0.08, 0.26, 0.12]],
  [-0.9, -0.85, 0.75, 1.3, 0.27, [0.13, 0.40, 0.16]], [0.9, -0.9, 2.4, 1.35, 0.26, [0.16, 0.46, 0.18]],
  [0.05, 1.05, -1.6, 1.0, 0.24, [0.20, 0.52, 0.20]],
];
/** Colour of the icon at (x, y) in [-1, 1]. */
function shade(x, y) {
  const d = Math.hypot(x + 0.25, y + 0.35);
  let c = mix([0.16, 0.42, 0.27], [0.02, 0.06, 0.04], Math.min(1, d / 1.5));
  c = mix(c, [1.0, 0.86, 0.5], Math.max(0, 1 - Math.hypot(x + 0.45, y + 0.5) / 0.75) ** 2 * 0.55);          // sun through the canopy
  for (const [lx, ly, a, len, wid, col] of LEAVES) {
    const dx = x - lx, dy = y - ly, u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
    if (u < 0 || u > len) continue;
    const half = wid * Math.sin(Math.PI * (u / len)) ** 0.75;
    if (Math.abs(v) < half) c = mix(col, mix(col, [0.6, 0.85, 0.4], 0.5), Math.abs(v) < 0.018 ? 1 : (u / len) * 0.45);
  }
  const r = Math.hypot(x, y), amber = [1.0, 0.77, 0.36];
  if (Math.abs(r - 0.36) < 0.035) c = amber;                                                                 // sight ring
  if ((Math.abs(x) < 0.03 && Math.abs(y) > 0.2 && Math.abs(y) < 0.56) || (Math.abs(y) < 0.03 && Math.abs(x) > 0.2 && Math.abs(x) < 0.56)) c = amber;
  if (r < 0.05) c = [1, 0.35, 0.25];
  return c;
}
function draw(size, scale) {
  const out = Buffer.alloc(size * size * 4), SS = 3;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let acc = [0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = shade((((px + (sx + 0.5) / SS) / size) * 2 - 1) / scale, (((py + (sy + 0.5) / SS) / size) * 2 - 1) / scale);
      acc = acc.map((v, i) => v + c[i]);
    }
    const i = (py * size + px) * 4;
    for (let k = 0; k < 3; k++) out[i + k] = Math.round(Math.min(1, acc[k] / (SS * SS)) * 255);
    out[i + 3] = 255;
  }
  return png(size, out);
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', draw(192, 1));
writeFileSync('public/icons/icon-512.png', draw(512, 1));
writeFileSync('public/icons/icon-maskable-512.png', draw(512, 0.72));   // content kept inside the maskable safe zone
writeFileSync('public/icons/apple-touch-icon.png', draw(180, 0.9));
console.log('icons written to public/icons');
