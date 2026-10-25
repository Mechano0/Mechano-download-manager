'use strict';
const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// Windows-safe file name (also fine on macOS/Linux).
function sanitizeFilename(name) {
  let s = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s || 'download';
}

// "file.zip" -> "file (1).zip" if it exists (or if its .mdmpart exists).
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate) || fs.existsSync(candidate + '.mdmpart'); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

function formatBytes(n) {
  if (n == null || !isFinite(n)) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// RFC 6266 Content-Disposition: prefer filename*=UTF-8''..., then filename="...".
function filenameFromDisposition(header) {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  if (plain) return (plain[2] ?? plain[1]).trim();
  return null;
}

function filenameFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const last = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
    return last || null;
  } catch { return null; }
}

const MIME_EXT = {
  'application/zip': '.zip', 'application/pdf': '.pdf', 'application/x-msdownload': '.exe',
  'application/x-7z-compressed': '.7z', 'application/vnd.rar': '.rar', 'application/x-rar-compressed': '.rar',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/mp2t': '.ts',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'text/plain': '.txt', 'application/json': '.json', 'application/octet-stream': '',
};

function extFromMime(mime) {
  if (!mime) return '';
  return MIME_EXT[mime.split(';')[0].trim().toLowerCase()] ?? '';
}

// IDM-style categories -> sub-folder of the download directory.
const CATEGORIES = {
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'arj', 'lzh'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'epub', 'dwg', 'rvt', 'rfa', 'ifc'],
  Music: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'],
  Programs: ['exe', 'msi', 'msix', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'bat'],
  Video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'ts', 'm4v', '3gp', 'mpg', 'mpeg'],
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic'],
};

function categorize(filename) {
  const ext = path.extname(filename || '').slice(1).toLowerCase();
  for (const [cat, list] of Object.entries(CATEGORIES)) if (list.includes(ext)) return cat;
  return 'General';
}

module.exports = {
  sleep, sanitizeFilename, uniquePath, formatBytes, filenameFromDisposition,
  filenameFromUrl, extFromMime, categorize, CATEGORIES,
};
