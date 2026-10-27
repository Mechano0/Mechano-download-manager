'use strict';
/**
 * Bridge to yt-dlp for YouTube and social-media sites.
 *
 * IDM keeps per-site parsers (YouTubeParser, FacebookParser, InstagramParser, VimeoParser...)
 * inside IDMNetMon.dll and updates them constantly. Sites change their players every few
 * weeks (YouTube signature/"n" challenges, PO tokens, SABR), so instead of maintaining our
 * own parsers we drive yt-dlp, which has 1,800+ maintained extractors.
 *
 * Requirements (see README):
 *   - yt-dlp.exe       https://github.com/yt-dlp/yt-dlp/releases
 *   - ffmpeg.exe       to merge separate video+audio streams (YouTube HD is always split)
 *   - a JS runtime     YouTube needs one for its challenges; we pass this Node.js (>=21 works)
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const toolCache = new Map();

/** Find an executable: explicit path, ./bin next to the app, then PATH. */
function findTool(name, explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const key = name + '|' + (explicit || '');
  if (toolCache.has(key)) return toolCache.get(key);
  let found = null;
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  // A folder build (bin\yt-dlp\yt-dlp.exe + _internal) starts in seconds; the one-file exe unpacks itself on every run.
  for (const local of [path.join(__dirname, '..', 'bin', name, exe), path.join(__dirname, '..', 'bin', exe)]) {
    if (!found && fs.existsSync(local)) found = local;
  }
  if (!found) {
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      found = execFileSync(cmd, [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null;
    } catch { found = null; }
  }
  toolCache.set(key, found);
  return found;
}

function resetToolCache() { toolCache.clear(); }

/** "2026.08.19" etc., or null if the tool can't run. Async: yt-dlp takes seconds to start. */
function toolVersion(exe) {
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (err, out) => {
      resolve(err ? null : String(out).trim().split(/\r?\n/)[0] || null);
    });
  });
}

/** True when this yt-dlp is the folder build (yt-dlp.exe next to an _internal folder). */
function isFolderBuild(exe) { return !!exe && fs.existsSync(path.join(path.dirname(exe), '_internal')); }

/** After yt-dlp is updated its options may change: re-detect them on next use. */
function resetRuntimeCache() { jsRuntimeFlag = undefined; jsRuntimeWarm = null; }

let jsRuntimeFlag;
let jsRuntimeWarm = null;
/** Find out in the background (at start) whether this yt-dlp has --js-runtimes, so no request waits for it. */
function warmUp(ytdlp) {
  if (!ytdlp || jsRuntimeFlag !== undefined) return Promise.resolve();
  if (!jsRuntimeWarm) {
    jsRuntimeWarm = new Promise((resolve) => {
      execFile(ytdlp, ['--help'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20, timeout: 60000 }, (err, out) => {
        if (jsRuntimeFlag === undefined) jsRuntimeFlag = !err && String(out).includes('--js-runtimes');
        resolve();
      });
    });
  }
  return jsRuntimeWarm;
}

/** Newer yt-dlp builds need --js-runtimes to use Node instead of the default Deno. */
function jsRuntimeArgs(ytdlp) {
  if (jsRuntimeFlag === undefined) {
    // only if a request comes before warmUp() finished
    try {
      const help = execFileSync(ytdlp, ['--help'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20 });
      jsRuntimeFlag = help.includes('--js-runtimes');
    } catch { jsRuntimeFlag = false; }
  }
  return jsRuntimeFlag ? ['--js-runtimes', `node:${process.execPath}`] : [];
}

/** Write browser cookies (from the extension) in Netscape cookies.txt format. */
function writeCookiesFile(file, cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Written by Mechano Download Manager; deleted after the job.'];
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
    lines.push([
      domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      Math.round(c.expirationDate || 0), c.name, c.value ?? '',
    ].join('\t'));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}

// Facebook titles look like "407K views · 1.8K reactions | Real title | Page name".
const FB_HOST = /(^|\.)(facebook\.com|fb\.watch)$/i;
const isFacebook = (url) => { try { return FB_HOST.test(new URL(url).hostname); } catch { return false; } };
const GENERIC_TITLE = /^(video|reels?|facebook|watch)$/i;
/**
 * Facebook titles: "407K views · 1.8K reactions | Real title | Page name", sometimes only
 * "Video" (logged in) or nothing but the page name (reels). Order of fixes:
 *   generic title -> post text; strip counters prefix and "| Page" suffix; empty -> post text;
 *   still empty -> "Facebook video <id>".
 * The same rules run inside yt-dlp (for the saved file name) via --parse/--replace-in-metadata.
 */
function cleanTitle(title, url, description, id) {
  if (!isFacebook(url)) return title;
  const firstLine = () => String(description || '').split('\n').map((s) => s.trim()).find((s) => s.length >= 3 && s !== 'NA');
  let t = String(title || '').replace(/[ㅤ⠀ᅟᅠ​-‏⁠﻿ ]/g, '').trim();
  if (GENERIC_TITLE.test(t) && firstLine()) t = firstLine();
  t = t.replace(/^[\d.,]+[KMB]?\s+(views|plays)\s+·\s+[\d.,]+[KMB]?\s+reactions\s+\|\s*/i, '')
    .replace(/\s*\|\s*[^|]{1,80}$/, '')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) t = ''; // only blanks / invisible symbols left
  if (!t) t = (firstLine() || '').slice(0, 100);
  return t || `Facebook video ${id || ''}`.trim();
}

function baseArgs(o) {
  // --encoding utf-8: Arabic / non-English titles come through intact (Windows defaults to a legacy code page)
  const args = ['--no-playlist', '--no-warnings', '--windows-filenames', '--encoding', 'utf-8'];
  if (isFacebook(o.url)) {
    const desc = '(?P<title>(?!NA$)[^\\n]{3,100})';
    args.push(
      '--parse-metadata', `%(title)s|%(description)s:^(?i:video|reels?|facebook|watch)\\|\\s*${desc}`,
      '--replace-in-metadata', 'title', '^[\\d.,]+[KMB]?\\s+(views|plays)\\s+·\\s+[\\d.,]+[KMB]?\\s+reactions\\s+\\|\\s*', '',
      '--replace-in-metadata', 'title', '\\s*\\|\\s*[^|]{1,80}$', '',
      // Invisible filler characters Facebook uses as "blank" text (Hangul filler, braille blank, zero-width...)
      '--replace-in-metadata', 'title', '[\\u3164\\u2800\\u115f\\u1160\\u200b-\\u200f\\u2060\\ufeff\\u00a0]', '',
      '--replace-in-metadata', 'title', '^\\s+|\\s+$', '',
      '--replace-in-metadata', 'title', '^\\W*$', '', // only symbols left -> empty
      '--parse-metadata', `%(title)s|%(description)s:^\\|\\s*${desc}`,
      '--parse-metadata', '%(title)s|Facebook video %(id)s:^\\|(?P<title>.+)',
    );
  }
  if (o.cookiesFile) args.push('--cookies', o.cookiesFile);
  if (o.ffmpeg) args.push('--ffmpeg-location', o.ffmpeg);
  if (o.referer) args.push('--referer', o.referer);
  if (o.userAgent) args.push('--user-agent', o.userAgent);
  return args.concat(jsRuntimeArgs(o.ytdlp));
}

/**
 * Width, height, codecs and total size of a progressive MP4, read from its first 256 KB (Facebook puts
 * the "moov" box at the start). Facebook's "sd" (360p) and "hd" (720p) H.264 files come from yt-dlp
 * without a height, so without this they are missing from the quality list.
 */
async function probeMp4(url, headers = {}, timeoutMs = 6000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...headers, range: 'bytes=0-262143' }, signal: ac.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const total = Number((res.headers.get('content-range') || '').split('/')[1]) || null;
    let width = null, height = null;
    for (let i = buf.indexOf('tkhd'); i >= 4; i = buf.indexOf('tkhd', i + 1)) {
      const start = i - 4, end = start + buf.readUInt32BE(start);
      if (end > buf.length || end - start < 84) continue;
      const w = buf.readUInt32BE(end - 8) / 65536, h = buf.readUInt32BE(end - 4) / 65536; // 16.16 fixed point
      if (w > 0 && h > 0) { width = Math.round(w); height = Math.round(h); break; } // the audio track is 0 x 0
    }
    if (!height) return null;
    return { width, height, size: total, vcodec: buf.includes('avc1') ? 'avc1' : null, acodec: buf.includes('mp4a') ? 'mp4a' : null };
  } catch { return null; } finally { clearTimeout(t); }
}

/** Fill in Facebook's progressive formats that yt-dlp leaves without a height (in parallel, a few seconds at most). */
async function completeFormats(url, formats) {
  if (!isFacebook(url)) return;
  const todo = formats.filter((f) => !f.height && f.url && /^https?$/.test(f.protocol || '') && (!f.vcodec || f.vcodec === 'unknown'));
  await Promise.all(todo.map(async (f) => {
    const p = await probeMp4(f.url, f.http_headers || {});
    if (!p) return;
    // Facebook's progressive files always carry sound; on long videos its marker can be past the first 256 KB
    Object.assign(f, { width: p.width, height: p.height, vcodec: p.vcodec || f.vcodec, acodec: p.acodec || f.acodec || 'mp4a', probed: true });
    if (!f.filesize && p.size) f.filesize = p.size;
  }));
}

/** List title + formats without downloading. */
function info(url, o) {
  return warmUp(o.ytdlp).then(() => new Promise((resolve, reject) => {
    if (!o.ytdlp) return reject(new Error('yt-dlp was not found. See README: "Install yt-dlp".'));
    const p = spawn(o.ytdlp, [...baseArgs({ ...o, url }), '-J', url], { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8'); // decode whole characters even when a chunk splits one
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(lastError(err) || `yt-dlp exited with ${code}`));
      try {
        const j = JSON.parse(out);
        completeFormats(url, j.formats || []).then(() => resolve({
          title: cleanTitle(j.title, url, j.description, j.id), id: j.id, extractor: j.extractor_key, duration: j.duration, thumbnail: j.thumbnail,
          uploader: j.uploader, webpage_url: j.webpage_url,
          formats: (j.formats || []).filter((f) => f.format_id && !/storyboard|mhtml/.test(f.ext || '') && f.protocol !== 'mhtml').map((f) => ({
            id: f.format_id, ext: f.ext, width: f.width || null, height: f.height || null, fps: f.fps || null,
            vcodec: f.vcodec, acodec: f.acodec, size: f.filesize || f.filesize_approx || null,
            tbr: f.tbr || null, note: f.format_note || '', protocol: f.protocol, probed: !!f.probed,
          })),
        }), reject);
      } catch (e) { reject(e); }
    });
  }));
}

/** True for links that point at a playlist (YouTube list=..., /playlist pages). */
function isPlaylistUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/.test(u.hostname) && (u.searchParams.has('list') || u.pathname === '/playlist');
  } catch { return false; }
}

/** Playlist title + video list without downloading (fast "flat" listing). */
function playlistInfo(url, o) {
  return new Promise((resolve, reject) => {
    if (!o.ytdlp) return reject(new Error('yt-dlp was not found. See README: "Install yt-dlp".'));
    const args = baseArgs({ ...o, url }).filter((a) => a !== '--no-playlist').concat('--yes-playlist', '--flat-playlist', '-J', url);
    const p = spawn(o.ytdlp, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8'); // decode whole characters even when a chunk splits one
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(lastError(err) || `yt-dlp exited with ${code}`));
      try {
        const j = JSON.parse(out);
        const entries = (j.entries || []).filter(Boolean);
        resolve({
          playlist: true, title: j.title, id: j.id, uploader: j.uploader || j.channel || null,
          count: entries.length,
          entries: entries.slice(0, 1000).map((e, i) => ({
            id: e.id, idx: e.playlist_index || i + 1, title: e.title || e.id, duration: e.duration || null,
            // flat entries of YouTube lists only carry the video id
            url: /^https?:/.test(e.url || '') ? e.url : e.webpage_url || (/youtube/i.test(j.extractor_key || j.extractor || '') ? `https://www.youtube.com/watch?v=${e.id}` : e.url),
          })),
          duration: entries.reduce((s, e) => s + (e.duration || 0), 0) || null,
        });
      } catch (e) { reject(e); }
    });
  });
}

function lastError(stderr) {
  const lines = String(stderr).split(/\r?\n/).filter((l) => /ERROR/.test(l));
  return lines.pop()?.replace(/^.*ERROR:\s*/, '') || String(stderr).trim().split(/\r?\n/).pop();
}

/** Pick a sensible default format string depending on whether ffmpeg is available. */
function defaultFormat(o) {
  if (o.audioOnly) return o.ffmpeg ? 'ba/b' : 'ba[ext=m4a]/ba/b';
  return o.ffmpeg ? 'bv*+ba/b' : 'b'; // without ffmpeg only pre-merged files; quality is chosen by -S below
}

/**
 * Format sort order. "res:720" = the best resolution not above 720p, judged by the SHORT side
 * (so a 720x1280 portrait reel counts as 720p), falling back to the closest one if none is lower.
 * At equal resolution prefer H.264 + AAC (plays everywhere).
 */
function sortOrder(o) {
  const parts = [o.maxHeight ? `res:${o.maxHeight}` : 'res'];
  if (o.ffmpeg) parts.push('vcodec:h264', 'acodec:aac');
  return parts.join(',');
}

/** Which formats to take: -f, the sort order and the merged container (shared by both download paths). */
function selectionArgs(o) {
  const args = ['-f', o.format || defaultFormat(o)];
  if (!o.format && !o.audioOnly) {
    // MP4/H.264 plays everywhere (Windows players, PowerPoint, video editors); VP9/AV1 .webm often doesn't.
    args.push('-S', sortOrder(o));
    if (o.ffmpeg) args.push('--merge-output-format', 'mp4');
  }
  return args;
}

/** yt-dlp's output name pattern for a single video or a playlist. */
function outTemplate(o) {
  return o.outTemplate || (o.playlist
    ? '%(playlist_title,playlist_id).80B/%(playlist_index)03d - %(title).100B [%(id)s].%(ext)s'
    : '%(title).120B [%(id)s].%(ext)s');
}

/**
 * Run "yt-dlp -J" with the same choices a download would make: the result tells which formats
 * it picked (requested_formats), their direct links + headers, and the final file name.
 */
function resolve(o) {
  return new Promise((resolveP, reject) => {
    if (!o.ytdlp) return reject(new Error('yt-dlp was not found. See README: "Install yt-dlp".'));
    // line 1: the final file name (with the merged extension), line 2: the info as JSON
    const args = [...baseArgs(o), ...selectionArgs(o), '-P', o.dir, '-o', outTemplate(o),
      '--print', 'filename', '--print', '%()j', o.url];
    const p = spawn(o.ytdlp, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(lastError(err) || `yt-dlp exited with ${code}`));
      try {
        const lines = out.split(/\r?\n/).filter((l) => l.trim());
        const jsonAt = lines.findIndex((l) => l.startsWith('{'));
        const j = JSON.parse(lines[jsonAt]);
        if (jsonAt > 0) j.filename = lines[jsonAt - 1].trim();
        resolveP(j);
      } catch (e) { reject(e); }
    });
  });
}

class YtdlpDownload extends EventEmitter {
  /**
   * @param {object} o  { url, dir, ytdlp, ffmpeg, format, cookiesFile, referer, userAgent,
   *                      maxHeight, audioOnly, rateLimit (bytes/s), fragments }
   */
  constructor(o) { super(); this.o = o; }

  /**
   * Some sites (e.g. Facebook Reels) serve logged-in visitors a page yt-dlp cannot parse.
   * Try with the browser's cookies first (needed for private videos); on failure retry once without.
   */
  start() {
    return this.run().catch((err) => {
      if (!this.o.cookiesFile || this.userPaused || this.retriedWithoutCookies) throw err;
      this.retriedWithoutCookies = true;
      this.emit('log', `Failed with browser cookies (${err.message}); retrying without them`);
      this.o = { ...this.o, cookiesFile: null };
      return this.run();
    });
  }

  run() {
    const o = this.o;
    if (this.userPaused) return Promise.resolve({ paused: true });
    if (!o.ytdlp) return Promise.reject(new Error('yt-dlp was not found. See README: "Install yt-dlp".'));
    fs.mkdirSync(o.dir, { recursive: true });
    let base = baseArgs(o);
    if (o.playlist) {
      // Whole playlist: one sub-folder named after the playlist, files numbered in playlist order.
      // --ignore-errors skips private/deleted videos instead of stopping the whole playlist.
      base = base.filter((a) => a !== '--no-playlist').concat('--yes-playlist', '--ignore-errors');
    }
    const args = [
      ...base,
      ...selectionArgs(o),
      '-P', o.dir,
      // .part / -Frag / .ytdl files wait in the job's work folder; yt-dlp moves only the finished file here
      ...(o.workDir ? ['-P', `temp:${o.workDir}`] : []),
      '-o', outTemplate(o),
      '-N', String(o.fragments || 4),
      '--newline', '--progress', '--no-simulate',
      '--progress-template', 'download:MDM|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      '--print', o.playlist
        ? 'before_dl:MDMITEM|%(playlist_index)s|%(n_entries,playlist_count)s|%(playlist_title,playlist_id)s|%(title)s'
        : 'before_dl:MDMTITLE|%(title)s',
      '--print', 'after_move:MDMFILE|%(filepath)s',
    ];
    if (o.audioOnly && o.ffmpeg) args.push('-x', '--audio-format', 'mp3');
    if (o.rateLimit) args.push('-r', String(Math.round(o.rateLimit)));
    args.push(o.url);

    return new Promise((resolve, reject) => {
      this.proc = spawn(o.ytdlp, args, { windowsHide: true });
      let stderr = '';
      let file = null;
      const files = [];
      let errors = 0;
      let buf = '';
      let partBase = 0; // yt-dlp downloads video then audio; keep the bar monotonic
      let lastTotal = 0;
      let lastD = 0;
      let item = null; // playlist position { index, count, title }
      const onLine = (line) => {
        if (line.startsWith('MDM|')) {
          const [, d, t, te, sp, eta] = line.split('|').map((x) => (x === 'NA' || x === 'None' ? null : Number(x)));
          const total = t || te || null;
          // Next stream (video then audio): the byte count restarts near zero. HLS/DASH fragments
          // change total_bytes_estimate on every update, so a changing total alone is not a new stream.
          if (lastTotal && d != null && d < 0.5 * lastD && d < 0.05 * (total || lastTotal)) partBase += lastTotal;
          if (total) lastTotal = total;
          if (d != null) lastD = d;
          this.emit('progress', {
            downloaded: partBase + (d || 0), size: total ? partBase + total : null, speed: sp || 0, eta: eta ?? null,
            connections: o.fragments || 4,
            playlistIndex: item ? item.index : null, playlistCount: item ? item.count : null, playlistDone: files.length,
          });
        } else if (line.startsWith('MDMTITLE|')) {
          this.emit('meta', { filename: line.slice(9) });
        } else if (line.startsWith('MDMITEM|')) {
          const [, idx, count, plTitle, ...rest] = line.split('|');
          item = { index: Number(idx) || null, count: Number(count) || null, title: rest.join('|') };
          partBase = 0; lastTotal = 0; lastD = 0; // new video: restart the per-video bar
          this.emit('meta', { filename: `${plTitle} (${item.count || '?'} videos)`, playlistTitle: plTitle, playlistCount: item.count });
          this.emit('log', `Video ${item.index || '?'} of ${item.count || '?'}: ${item.title}`);
        } else if (line.startsWith('MDMFILE|')) {
          file = line.slice(8).trim();
          files.push(file);
        } else if (line.trim()) {
          if (/ERROR/.test(line)) errors++;
          this.emit('log', line.trim());
        }
      };
      const feed = (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
      };
      this.proc.stdout.setEncoding('utf8');
      this.proc.stderr.setEncoding('utf8');
      this.proc.stdout.on('data', feed);
      this.proc.stderr.on('data', (d) => { stderr += d; feed(d); });
      this.proc.on('error', reject);
      this.proc.on('close', (code) => {
        if (this.userPaused) { this.emit('paused'); return resolve({ paused: true }); }
        if (o.playlist && files.length) {
          // A playlist counts as done when at least one video arrived; skipped ones are reported.
          const folder = path.dirname(files[files.length - 1]);
          const size = files.reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
          if (errors) this.emit('log', `${errors} video(s) could not be downloaded (private, deleted or blocked) and were skipped`);
          this.emit('done', { file: folder, size, count: files.length });
          return resolve({ file: folder, size, count: files.length, skipped: errors });
        }
        if (code === 0) {
          const size = file && fs.existsSync(file) ? fs.statSync(file).size : null;
          this.emit('done', { file, size });
          return resolve({ file, size });
        }
        reject(new Error(lastError(stderr) || `yt-dlp exited with code ${code}`));
      });
    });
  }

  /** yt-dlp keeps .part files, so a later start() continues where it stopped. */
  pause() {
    this.userPaused = true;
    const p = this.proc;
    if (!p || p.exitCode != null) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); // also stops ffmpeg children
    } else {
      p.kill('SIGTERM');
    }
  }

  stop() { this.pause(); }
}

module.exports = {
  YtdlpDownload, info, playlistInfo, isPlaylistUrl, findTool, resetToolCache, resetRuntimeCache,
  writeCookiesFile, defaultFormat, toolVersion, isFolderBuild, warmUp, probeMp4, resolve, selectionArgs, cleanTitle,
};
