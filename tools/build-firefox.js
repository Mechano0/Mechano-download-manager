#!/usr/bin/env node
'use strict';
/**
 * Builds the Firefox version of the browser extension (same code; only the manifest differs):
 *   dist/firefox/                  folder: Firefox → about:debugging → This Firefox → Load Temporary Add-on → manifest.json
 *   dist/mechano-dm-firefox.xpi    package to upload to addons.mozilla.org for signing
 *
 *   node tools/build-firefox.js
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'dist', 'firefox');
const xpi = path.join(root, 'dist', 'mechano-dm-firefox.xpi');

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });

const m = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
delete m.minimum_chrome_version;
m.background = { scripts: ['background.js'] }; // Firefox runs MV3 backgrounds as event pages
m.browser_specific_settings = {
  gecko: { id: 'mechano-dm@mechano0.github.io', strict_min_version: '115.0', data_collection_permissions: { required: ['none'] } },
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');

// --- a small zip writer (deflate), entry names with forward slashes as Firefox wants
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const files = walk(out).sort();
const local = [], central = [];
let offset = 0;
const dosTime = 0, dosDate = (2026 - 1980) << 9 | 1 << 5 | 1; // fixed date: same input → same file
for (const f of files) {
  const name = Buffer.from(path.relative(out, f).split(path.sep).join('/'));
  const data = fs.readFileSync(f);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = zlib.crc32(data);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
  h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
  local.push(h, name, comp);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
  c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
  c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += 30 + name.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.writeFileSync(xpi, Buffer.concat([...local, cd, end]));
console.log(`Firefox extension: ${path.relative(root, xpi)} (${(fs.statSync(xpi).size / 1024).toFixed(0)} KB, ${files.length} files)`);
