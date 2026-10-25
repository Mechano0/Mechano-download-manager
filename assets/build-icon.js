// Builds every app icon from one source image (assets/logo-source.png):
//   assets/mdm.ico                 Windows icon (16-256 px, PNG frames) for the .exe, shortcuts, tray
//   assets/logo-256.png, logo-64   window header + favicon fallback
//   extension/icons/icon*.png      browser extension
// Steps: find the black rounded square in the image, crop it, make everything outside its rounded
// corners transparent (removes the white background), then resize with ffmpeg (Lanczos).
// Small sizes (16-32 px) use only the "M + arrow" mark, because the "mechano dm" text would be unreadable.
//
// Usage: node assets/build-icon.js <ffmpeg.exe>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ffmpeg = process.argv[2] || 'ffmpeg';
const dir = __dirname;
const src = path.join(dir, 'logo-source.png');
const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mdm-icon-'));

function readRgba(file) {
  const probe = execFileSync(ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().split(',').map(Number);
  const [w, h] = probe;
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  return { w, h, px: raw };
}

function writePng(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

// 1) Find the dark rounded square: rows/columns where most pixels are dark.
const img = readRgba(src);
const dark = (x, y) => { const o = (y * img.w + x) * 4; return img.px[o + 3] > 200 && img.px[o] + img.px[o + 1] + img.px[o + 2] < 120; };
let top = -1, bottom = -1, left = -1, right = -1;
const cx = img.w >> 1, cy = img.h >> 1;
for (let y = 0; y < img.h && top < 0; y++) if (dark(cx - 300, y) || dark(cx + 300, y)) top = y;
for (let y = img.h - 1; y >= 0 && bottom < 0; y--) if (dark(cx - 300, y) || dark(cx + 300, y)) bottom = y;
for (let x = 0; x < img.w && left < 0; x++) if (dark(x, cy - 300) || dark(x, cy + 300)) left = x;
for (let x = img.w - 1; x >= 0 && right < 0; x--) if (dark(x, cy - 300) || dark(x, cy + 300)) right = x;
const size = Math.max(right - left, bottom - top) + 1;
console.log(`square found at x=${left}..${right}, y=${top}..${bottom} (${size}px)`);

// 2) Crop to the square and cut the rounded corners with a smooth (anti-aliased) mask.
function roundedCrop(x0, y0, s, radiusFrac) {
  const out = Buffer.alloc(s * s * 4);
  const r = s * radiusFrac;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const sx = x0 + x, sy = y0 + y;
      const o = (y * s + x) * 4;
      if (sx >= 0 && sy >= 0 && sx < img.w && sy < img.h) img.px.copy(out, o, (sy * img.w + sx) * 4, (sy * img.w + sx) * 4 + 4);
      // distance outside the rounded rectangle → alpha (1px soft edge)
      const qx = Math.max(r - x - 0.5, 0, x + 0.5 - (s - r));
      const qy = Math.max(r - y - 0.5, 0, y + 0.5 - (s - r));
      const d = Math.hypot(qx, qy) - r;
      const a = Math.max(0, Math.min(1, 0.5 - d));
      out[o + 3] = Math.round(out[o + 3] * a);
    }
  }
  return out;
}

const full = roundedCrop(left, top, size, 0.235);
writePng(path.join(tmp, 'full.png'), size, size, full);

// Mark only (M + arrow), for 16-32 px: a square around the upper 2/3 of the tile, kept black.
// The M + arrow sit around 50.6% across and 40.4% down the tile; the text starts at ~74% down.
const markSize = Math.round(size * 0.64);
const markX = left + Math.round(size * 0.506 - markSize / 2);
const markY = top + Math.round(size * 0.404 - markSize / 2);
const mark = roundedCrop(markX, markY, markSize, 0.235); // lies fully inside the black tile
if (process.env.MDM_ICON_DEBUG) writePng(path.join(dir, 'debug-mark.png'), markSize, markSize, mark);
writePng(path.join(tmp, 'mark.png'), markSize, markSize, mark);

// 3) Resize with ffmpeg (Lanczos keeps edges crisp).
const resized = (master, px) => {
  const out = path.join(tmp, `${path.basename(master, '.png')}-${px}.png`);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', master, '-vf', `scale=${px}:${px}:flags=lanczos`, '-pix_fmt', 'rgba', out]);
  return out;
};
const frame = (px) => fs.readFileSync(resized(path.join(tmp, px <= 32 ? 'mark.png' : 'full.png'), px));

// 4) .ico with PNG frames (supported since Windows Vista).
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const frames = SIZES.map(frame);
const head = Buffer.alloc(6 + 16 * SIZES.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(SIZES.length, 4);
let offset = head.length;
SIZES.forEach((s, i) => {
  const e = 6 + i * 16;
  head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(frames[i].length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += frames[i].length;
});
fs.writeFileSync(path.join(dir, 'mdm.ico'), Buffer.concat([head, ...frames]));
fs.writeFileSync(path.join(dir, 'logo-256.png'), frame(256));
fs.writeFileSync(path.join(dir, 'logo-64.png'), frame(64));
// Window header (shown at 32 px, 64 px for sharp high-DPI screens): the M + arrow mark only
fs.copyFileSync(resized(path.join(tmp, 'mark.png'), 64), path.join(dir, 'logo-mark-64.png'));
const ext = path.join(dir, '..', 'extension', 'icons');
fs.mkdirSync(ext, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(ext, `icon${s}.png`), frame(s));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote assets/mdm.ico, assets/logo-256.png, assets/logo-64.png, extension/icons/*.png');
