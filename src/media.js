'use strict';
/**
 * Fast video downloads (YouTube, Facebook, Instagram, TikTok, X, Vimeo...).
 *
 * yt-dlp is only asked WHICH files make up the video ("yt-dlp -J": it solves YouTube's
 * challenges and returns direct links for the picture and the sound). The files themselves are
 * then downloaded by our own multi-connection engine (segmented.js), picture and sound at the
 * same time, and joined with ffmpeg in "copy" mode (seconds, no quality loss).
 *
 * That is much faster than letting yt-dlp download: it uses one connection per file, and
 * YouTube slows a single connection down to playback speed. For YouTube's servers every
 * connection asks for 10 MB at a time, which keeps them at full speed.
 *
 * Anything this path can't do (live streams, sites that only offer HLS/DASH pieces, no ffmpeg
 * for a two-part video, a link that refuses us at once) goes to the classic YtdlpDownload.
 *
 * Resume: the parts keep fixed names next to the final file
 * ("<name>.f<format>.<ext>.mdmpart" + its segment table), so a pause, crash or restart continues
 * them. The direct links expire after a few hours: every start asks yt-dlp for fresh ones.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { SegmentedDownload } = require('./segmented');
const { YtdlpDownload, resolve } = require('./ytdlp');
const { HttpError } = require('./http');
const { uniquePath } = require('./util');

const YOUTUBE_CDN = /(^|\.)googlevideo\.com$/i;
const SLICE = 10 * 1024 * 1024; // bytes per request on throttling servers

class Unsupported extends Error {}

class MediaDownload extends EventEmitter {
  /**
   * @param {object} o  the YtdlpDownload options plus { limiter, connections, cookieFor(url) }
   */
  constructor(o) {
    super();
    this.o = o;
    this.parts = [];
  }

  start() {
    if (this.userPaused) return Promise.resolve({ paused: true });
    return this.fast().catch((err) => {
      if (this.userPaused) return { paused: true };
      if (this.bytesDone() > 0 && !(err instanceof Unsupported)) throw err; // real progress was made: report it
      this.emit('log', err instanceof Unsupported
        ? `Using yt-dlp's own downloader (${err.message})`
        : `Fast download failed (${err.message}); using yt-dlp's own downloader`);
      return this.classic();
    });
  }

  /** The classic path: yt-dlp downloads and merges by itself. */
  classic() {
    const d = new YtdlpDownload(this.o);
    this.fallback = d;
    for (const ev of ['progress', 'meta', 'log']) d.on(ev, (x) => this.emit(ev, x));
    if (this.userPaused) d.pause();
    return d.start();
  }

  async info() {
    try {
      return await resolve(this.o);
    } catch (err) {
      // Same rule as YtdlpDownload: a page that fails with the browser's cookies is tried without.
      if (!this.o.cookiesFile) throw err;
      this.emit('log', `Failed with browser cookies (${err.message}); retrying without them`);
      this.o = { ...this.o, cookiesFile: null };
      return resolve(this.o);
    }
  }

  async fast() {
    const o = this.o;
    if (o.playlist) throw new Unsupported('whole playlist');
    fs.mkdirSync(o.dir, { recursive: true });

    let resolved = 0;
    for (;;) {
      const j = await this.info();
      resolved++;
      if (this.userPaused) return { paused: true };
      const plan = this.plan(j);
      this.emit('meta', { filename: path.basename(plan.final) });
      try {
        return await this.download(plan);
      } catch (err) {
        // The links expired (HTTP 403/410 after a long pause): get fresh ones once and continue.
        const expired = err instanceof HttpError && [403, 404, 410].includes(err.status);
        if (this.userPaused || !expired || resolved > 1 || this.bytesDone() === 0) throw err;
        this.emit('log', 'The video links expired; getting fresh ones and continuing');
      }
    }
  }

  /** What to download for yt-dlp's answer `j`, or Unsupported. */
  plan(j) {
    const o = this.o;
    if (j._type === 'playlist' || j.entries) throw new Unsupported('several videos in one post');
    if (j.is_live || j.live_status === 'is_live' || j.live_status === 'is_upcoming') throw new Unsupported('live stream');
    const formats = j.requested_formats || [j];
    for (const f of formats) {
      if (!f.url || !/^https?$/.test(f.protocol || '')) throw new Unsupported(`${f.protocol || 'unknown'} stream`);
    }
    if (formats.length > 1 && !o.ffmpeg) throw new Unsupported('no ffmpeg to join picture and sound');
    let final = j.filename || j._filename;
    if (!final) throw new Unsupported('no file name');
    if (!path.isAbsolute(final)) final = path.join(o.dir, final);
    const audioToMp3 = o.audioOnly && o.ffmpeg && !/^mp3$/i.test(formats[0].ext || '');
    if (audioToMp3) final = final.replace(/\.[^.\\/]+$/, '') + '.mp3';
    const parts = formats.map((f) => ({
      f,
      target: `${final}.f${String(f.format_id).replace(/[^\w.-]/g, '_')}.${f.ext || 'bin'}`,
      video: !!(f.vcodec && f.vcodec !== 'none'),
    }));
    return { final, parts, merge: formats.length > 1, audioToMp3, title: j.title };
  }

  headersFor(f) {
    const h = {};
    for (const [k, v] of Object.entries(f.http_headers || {})) h[k.toLowerCase()] = v;
    // yt-dlp lists cookies a link needs (TikTok, Instagram) as "name=value; Domain=...; ..." strings
    const pairs = [];
    for (const item of String(f.cookies || '').split(/;\s*/)) {
      const m = /^([^=\s]+)=(.*)$/.exec(item);
      if (m && !/^(domain|path|expires|max-age|samesite)$/i.test(m[1])) pairs.push(`${m[1]}=${m[2]}`);
    }
    const fromBrowser = this.o.cookieFor ? this.o.cookieFor(f.url) : null;
    if (fromBrowser) pairs.push(fromBrowser);
    if (pairs.length) h.cookie = pairs.join('; ');
    return h;
  }

  async download(plan) {
    const o = this.o;
    const total = Math.max(1, o.connections || 8);
    this.parts = plan.parts.map((p) => {
      let host = '';
      try { host = new URL(p.f.url).hostname; } catch { /* keep empty */ }
      const conns = plan.merge && !p.video ? Math.max(2, Math.ceil(total / 4)) : total;
      const done = fs.existsSync(p.target) && !fs.existsSync(p.target + '.mdmpart');
      const seg = done ? null : new SegmentedDownload({
        url: p.f.url, target: p.target, headers: this.headersFor(p.f), connections: conns,
        limiter: o.limiter, maxRequest: YOUTUBE_CDN.test(host) ? SLICE : 0, maxRetries: 6,
      });
      const size = done ? fs.statSync(p.target).size : p.f.filesize || p.f.filesize_approx || null;
      return { ...p, seg, size, doneBytes: done ? size : 0 };
    });
    if (this.userPaused) return { paused: true };

    const timer = setInterval(() => this.reportProgress(), 500);
    let results;
    try {
      results = await Promise.all(this.parts.map(async (p) => {
        if (!p.seg) return { file: p.target };
        p.seg.on('meta', (m) => { if (m.size) p.size = m.size; });
        p.seg.on('log', (l) => this.emit('log', `${p.video ? 'picture' : 'sound'}: ${l}`));
        return p.seg.start();
      }));
    } catch (err) {
      for (const p of this.parts) p.seg?.pause();
      throw err;
    } finally {
      clearInterval(timer);
    }
    if (this.userPaused || results.some((r) => r && r.paused)) { this.emit('paused'); return { paused: true }; }
    this.reportProgress();

    const files = this.parts.map((p) => p.target);
    let out = plan.final;
    if (fs.existsSync(out)) out = uniquePath(path.dirname(out), path.basename(out));
    const tmp = out + '.joining' + path.extname(out);
    if (plan.merge) {
      this.emit('log', 'Joining picture and sound...');
      const v = this.parts.find((p) => p.video) || this.parts[0];
      const a = this.parts.find((p) => p !== v);
      await runFfmpeg(o.ffmpeg, ['-i', v.target, '-i', a.target, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
        ...(/\.(mp4|m4a|mov)$/i.test(out) ? ['-movflags', '+faststart'] : []), '-f', muxerFor(out), tmp]);
    } else if (plan.audioToMp3) {
      this.emit('log', 'Making the MP3 file...');
      await runFfmpeg(o.ffmpeg, ['-i', files[0], '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', tmp]);
    } else {
      await fsp.rename(files[0], tmp);
    }
    await fsp.rename(tmp, out);
    for (const f of files) await fsp.rm(f, { force: true });
    const size = fs.statSync(out).size;
    this.emit('done', { file: out, size });
    return { file: out, size };
  }

  bytesDone() {
    return this.parts.reduce((n, p) => n + (p.seg ? p.seg.downloaded : p.doneBytes || 0), 0);
  }

  reportProgress() {
    let downloaded = 0;
    let size = 0;
    let speed = 0;
    let connections = 0;
    let known = true;
    for (const p of this.parts) {
      downloaded += p.seg ? p.seg.downloaded : p.doneBytes;
      if (p.size) size += p.size; else known = false;
      if (p.seg) { speed += p.seg.speed || 0; connections += p.seg.segments.filter((s) => s.busy).length; }
    }
    const segs = this.parts.length === 1 && this.parts[0].seg ? this.parts[0].seg.progress().segments : null;
    this.emit('progress', {
      downloaded, size: known ? size : null, speed, connections, segments: segs,
      eta: known && speed > 0 ? Math.round((size - downloaded) / speed) : null,
    });
  }

  pause() {
    this.userPaused = true;
    for (const p of this.parts) p.seg?.pause();
    this.fallback?.pause();
  }

  stop() { this.pause(); }
}

/** ffmpeg's muxer name for the final extension (the temporary name hides it). */
function muxerFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return { mp4: 'mp4', m4a: 'mp4', mov: 'mov', mkv: 'matroska', webm: 'webm', mp3: 'mp3', ogg: 'ogg', opus: 'opus' }[ext] || 'matroska';
}

function runFfmpeg(ffmpeg, args) {
  return new Promise((resolveP, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(`ffmpeg failed: ${err.trim().split(/\r?\n/).pop() || code}`))));
  });
}

module.exports = { MediaDownload, Unsupported, muxerFor };
