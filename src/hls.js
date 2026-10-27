'use strict';
/**
 * HLS (.m3u8) downloader, the same job IDM does with CM3UParser + CTSReader/CMp4Converter.
 *
 *  - Master playlist -> picks the best variant (or a requested max height).
 *  - Media playlist  -> downloads segments in parallel, resumable (one file per segment).
 *  - AES-128 (clear-key) segments are decrypted with the key the playlist points to.
 *  - fMP4 (#EXT-X-MAP) init segments are prepended; byte-range segments are supported.
 *  - DRM (SAMPLE-AES, Widevine/FairPlay/PlayReady KEYFORMATs) is refused, never bypassed.
 *  - Separate audio renditions are downloaded too and merged with ffmpeg when available.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { getBuffer } = require('./http');
const { sleep, uniquePath, sanitizeFilename, filenameFromUrl } = require('./util');

function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function parseByteRange(s, prevEnd) {
  const [len, off] = s.split('@');
  const start = off != null ? Number(off) : prevEnd;
  return { start, end: start + Number(len) - 1 };
}

/** Parse an M3U8 playlist. Relative URIs are resolved against baseUrl. */
function parseM3U8(text, baseUrl) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new Error('Not an M3U8 playlist');
  const abs = (u) => new URL(u, baseUrl).href;
  const pl = { master: false, variants: [], renditions: [], segments: [], endList: false, mediaSequence: 0 };
  let pendingVariant = null;
  let duration = 0;
  let key = null;
  let map = null;
  let byterange = null;
  let lastEnd = {};
  let seq = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pl.master = true;
      const a = parseAttrs(line.slice(18));
      const [w, h] = (a.RESOLUTION || '').split('x').map(Number);
      pendingVariant = { bandwidth: Number(a.BANDWIDTH) || 0, width: w || null, height: h || null, codecs: a.CODECS || null, audio: a.AUDIO || null };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      pl.renditions.push({ type: a.TYPE, groupId: a['GROUP-ID'], name: a.NAME, language: a.LANGUAGE, default: a.DEFAULT === 'YES', uri: a.URI ? abs(a.URI) : null });
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      pl.mediaSequence = seq = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? abs(a.URI) : null, iv: a.IV || null, keyformat: a.KEYFORMAT || 'identity' };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      const uri = abs(a.URI);
      map = { uri, range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byterange = line.slice(17);
    } else if (line === '#EXT-X-ENDLIST') {
      pl.endList = true;
    } else if (!line.startsWith('#')) {
      const uri = abs(line);
      if (pendingVariant) {
        pl.variants.push({ ...pendingVariant, uri });
        pendingVariant = null;
      } else {
        let range = null;
        if (byterange) { range = parseByteRange(byterange, lastEnd[uri] ?? 0); lastEnd[uri] = range.end + 1; byterange = null; }
        pl.segments.push({ uri, duration, seq, key, map, range });
        seq++;
      }
    }
  }
  return pl;
}

function assertNoDrm(segments) {
  for (const s of segments) {
    if (!s.key) continue;
    const kf = (s.key.keyformat || 'identity').toLowerCase();
    if (s.key.method !== 'AES-128' || kf !== 'identity') {
      throw new Error(`This stream is DRM-protected (${s.key.method}, ${kf}). DRM-protected media cannot be downloaded.`);
    }
  }
}

function ivFor(seg) {
  if (seg.key.iv) return Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(seg.seq), 8); // IV defaults to the media sequence number
  return iv;
}

class HlsDownload extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.url        playlist URL (master or media)
   * @param {string} o.dir
   * @param {string} [o.target]   exact output path (resume)
   * @param {string} [o.filename]
   * @param {object} [o.headers]
   * @param {number} [o.concurrency]  parallel segment downloads (default 6)
   * @param {number} [o.maxHeight]    prefer variants up to this height
   * @param {string} [o.ffmpeg]       path to ffmpeg for audio merge / remux
   * @param {import('./limiter').RateLimiter} [o.limiter]
   */
  constructor(o) {
    super();
    this.o = { concurrency: 6, ...o };
    this.stopped = false;
    this.downloaded = 0;
    this.keys = new Map();
  }

  async fetch(url, range) {
    const headers = { ...this.o.headers };
    if (range) headers.range = `bytes=${range.start}-${range.end}`;
    for (let attempt = 1; ; attempt++) {
      try {
        return (await getBuffer(url, { headers, signal: this.ac.signal })).body;
      } catch (e) {
        if (this.stopped || attempt >= 6) throw e;
        await sleep(400 * 2 ** attempt, this.ac.signal);
      }
    }
  }

  async start() {
    if (this.userPaused) return { paused: true };
    this.stopped = false;
    this.ac = new AbortController();
    const o = this.o;
    let pl = parseM3U8((await this.fetch(o.url)).toString('utf8'), o.url);
    let audioPl = null;

    if (pl.master) {
      if (!pl.variants.length) throw new Error('Master playlist has no variants');
      const sorted = [...pl.variants].sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
      const v = (o.maxHeight && sorted.find((x) => (x.height || 0) <= o.maxHeight)) || sorted[0];
      this.emit('log', `Variant: ${v.width || '?'}x${v.height || '?'} @ ${Math.round(v.bandwidth / 1000)} kbps`);
      const audio = v.audio && pl.renditions.find((r) => r.type === 'AUDIO' && r.groupId === v.audio && r.uri && r.default) ||
        (v.audio && pl.renditions.find((r) => r.type === 'AUDIO' && r.groupId === v.audio && r.uri));
      if (audio) audioPl = parseM3U8((await this.fetch(audio.uri)).toString('utf8'), audio.uri);
      pl = parseM3U8((await this.fetch(v.uri)).toString('utf8'), v.uri);
    }
    if (!pl.segments.length) throw new Error('Playlist contains no segments');
    if (!pl.endList) this.emit('log', 'Live stream: downloading the segments currently listed');
    assertNoDrm(pl.segments);
    if (audioPl) assertNoDrm(audioPl.segments);

    const fmp4 = !!pl.segments[0].map;
    if (!o.target) {
      await fsp.mkdir(o.dir, { recursive: true });
      let name = o.filename || filenameFromUrl(o.url) || 'video';
      name = sanitizeFilename(name.replace(/\.m3u8?$/i, '')) + (fmp4 ? '.mp4' : '.ts');
      o.target = uniquePath(o.dir, name);
    }
    this.target = o.target;
    // pieces wait in the job's work folder (old jobs: next to the file), not in the save folder
    this.work = o.workDir ? path.join(o.workDir, 'hls') : this.target + '.mdmhls';
    await fsp.mkdir(this.work, { recursive: true });

    const tracks = [{ name: 'v', segments: pl.segments }];
    if (audioPl) tracks.push({ name: 'a', segments: audioPl.segments });
    this.total = tracks.reduce((n, t) => n + t.segments.length, 0);
    this.done = 0;
    this.emit('meta', { target: this.target, filename: path.basename(this.target), segments: this.total });

    const timer = this.progressTimer();
    try {
      for (const t of tracks) await this.downloadTrack(t);
    } finally {
      clearInterval(timer);
    }
    if (this.userPaused) { this.emit('paused'); return { paused: true }; }

    const vOut = await this.concat(tracks[0], this.target + '.video.tmp');
    let finalPath;
    if (tracks[1]) {
      const aOut = await this.concat(tracks[1], this.target + '.audio.tmp');
      finalPath = await this.mergeAudio(vOut, aOut);
    } else {
      finalPath = await this.finalize(vOut);
    }
    await fsp.rm(this.work, { recursive: true, force: true });
    this.emit('done', { file: finalPath, size: fs.statSync(finalPath).size });
    return { file: finalPath };
  }

  segPath(track, i) { return path.join(this.work, `${track}${String(i).padStart(6, '0')}.seg`); }

  async downloadTrack(track) {
    let next = 0;
    const worker = async () => {
      while (!this.stopped && next < track.segments.length) {
        const i = next++;
        const out = this.segPath(track.name, i);
        if (fs.existsSync(out)) { this.done++; this.downloaded += fs.statSync(out).size; continue; }
        const seg = track.segments[i];
        let data = await this.fetch(seg.uri, seg.range);
        if (seg.key) data = await this.decrypt(seg, data);
        if (this.o.limiter) await this.o.limiter.take(data.length, this.ac.signal);
        await fsp.writeFile(out + '.tmp', data);
        await fsp.rename(out + '.tmp', out);
        this.downloaded += data.length;
        this.done++;
      }
    };
    const n = Math.min(this.o.concurrency, track.segments.length);
    const results = await Promise.allSettled(Array.from({ length: n }, worker));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && !this.userPaused) throw failed.reason;
  }

  async decrypt(seg, data) {
    let key = this.keys.get(seg.key.uri);
    if (!key) { key = await this.fetch(seg.key.uri); this.keys.set(seg.key.uri, key); }
    if (key.length !== 16) throw new Error('Unexpected AES-128 key length');
    const d = crypto.createDecipheriv('aes-128-cbc', key, ivFor(seg));
    return Buffer.concat([d.update(data), d.final()]);
  }

  async concat(track, outPath) {
    const ws = fs.createWriteStream(outPath);
    const writtenMaps = new Set();
    const write = (buf) => new Promise((res, rej) => (ws.write(buf, (e) => (e ? rej(e) : res()))));
    for (let i = 0; i < track.segments.length; i++) {
      const map = track.segments[i].map;
      const mapKey = map && `${map.uri}|${map.range?.start}`;
      if (map && !writtenMaps.has(mapKey)) { writtenMaps.add(mapKey); await write(await this.fetch(map.uri, map.range)); }
      await write(await fsp.readFile(this.segPath(track.name, i)));
    }
    await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
    return outPath;
  }

  async finalize(tmp) {
    const ff = this.o.ffmpeg;
    if (ff && this.target.endsWith('.ts') && this.o.remux !== false) {
      const mp4 = uniquePath(path.dirname(this.target), path.basename(this.target, '.ts') + '.mp4');
      if (await runFfmpeg(ff, ['-y', '-i', tmp, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', mp4])) {
        await fsp.rm(tmp, { force: true });
        return mp4;
      }
    }
    await fsp.rename(tmp, this.target);
    return this.target;
  }

  async mergeAudio(v, a) {
    const ff = this.o.ffmpeg;
    const base = path.basename(this.target, path.extname(this.target));
    if (ff) {
      const out = uniquePath(path.dirname(this.target), base + '.mp4');
      if (await runFfmpeg(ff, ['-y', '-i', v, '-i', a, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', out])) {
        await fsp.rm(v, { force: true });
        await fsp.rm(a, { force: true });
        return out;
      }
    }
    // No ffmpeg: keep the two tracks side by side.
    const ext = path.extname(this.target);
    const vOut = uniquePath(path.dirname(this.target), `${base}.video${ext}`);
    const aOut = uniquePath(path.dirname(this.target), `${base}.audio${ext}`);
    await fsp.rename(v, vOut);
    await fsp.rename(a, aOut);
    this.emit('log', 'Audio and video saved separately (install ffmpeg to merge automatically)');
    return vOut;
  }

  progressTimer() {
    let last = 0;
    let lastT = Date.now();
    this.speed = 0;
    return setInterval(() => {
      const now = Date.now();
      const inst = ((this.downloaded - last) * 1000) / Math.max(1, now - lastT);
      this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst;
      last = this.downloaded; lastT = now;
      const avgSeg = this.done ? this.downloaded / this.done : 0;
      const size = avgSeg ? Math.round(avgSeg * this.total) : null; // estimate
      this.emit('progress', {
        downloaded: this.downloaded, size, speed: this.speed,
        eta: size && this.speed > 0 ? Math.round((size - this.downloaded) / this.speed) : null,
        segmentsDone: this.done, segmentsTotal: this.total, connections: this.o.concurrency,
      });
    }, 500);
  }

  pause() { this.userPaused = true; this.stopped = true; this.ac?.abort(); }
  stop() { this.pause(); }
}

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

module.exports = { HlsDownload, parseM3U8, runFfmpeg };
