'use strict';
// Draws the app icons (the DoseLoop loop mark) as PNGs with no image library.
//   node scripts/make-icons.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BG = [15, 107, 90], RING = [253, 248, 236], DOT = [240, 138, 75];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Coverage of one sample point; the mark is drawn in a 32-unit box like the favicon.
function shade(x, y, maskable) {
  // Background: rounded square, or full bleed for maskable icons (the OS applies the mask).
  const r = maskable ? 0 : 7, inset = 0;
  const qx = Math.max(Math.abs(x - 16) - (16 - r - inset), 0), qy = Math.max(Math.abs(y - 16) - (16 - r - inset), 0);
  if (Math.hypot(qx, qy) > r) return null;
  const s = maskable ? 0.72 : 1; // keep the mark inside the maskable safe zone
  const mx = (x - 16) / s + 16, my = (y - 16) / s + 16;
  // Dot at the open end of the loop.
  if (Math.hypot(mx - 23, my - 10.5) < 2.8) return DOT;
  // Ring: radius 8 around (16,16), open between -60 and -20 degrees (top right).
  const d = Math.hypot(mx - 16, my - 16);
  if (Math.abs(d - 8) < 1.6) {
    const a = (Math.atan2(my - 16, mx - 16) * 180) / Math.PI;
    if (!(a > -62 && a < -8)) return RING;
  }
  return BG;
}

function render(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade(((px + (sx + 0.5) / SS) / size) * 32, ((py + (sy + 0.5) / SS) / size) * 32, maskable);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      }
      const i = (py * size + px) * 4, n = SS * SS;
      if (a) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round((255 * a) / n);
    }
  }
  return png(size, buf);
}

const out = path.join(__dirname, '..', 'web', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true]]) {
  fs.writeFileSync(path.join(out, name), render(size, maskable));
  console.log(`wrote web/icons/${name}`);
}
