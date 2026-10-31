'use strict';
/**
 * Multi-connection segmented downloader with IDM-style dynamic segmentation.
 *
 * How it works (mirrors IDM's CDownload / CFilePart / HTTPConnection design):
 *  1. Probe the URL for size, range support and validators.
 *  2. Pre-allocate "<target>.mdmpart" to the full size.
 *  3. Start N workers. The first takes the whole file [0, size). Every later worker
 *     (and every worker that finishes early) SPLITS the segment with the most bytes
 *     left in half and takes the second half. Fast connections therefore keep
 *     helping slow ones until the file is done; no connection idles at the end.
 *  4. Every worker writes at its own file offset (positional writes, no merging step).
 *  5. Segment table is saved to "<target>.mdmpart.json" so a pause, crash or reboot
 *     resumes from the exact byte. If-Range + ETag/Last-Modified detect a changed file.
 *  6. Servers that refuse ranges fall back to one sequential connection.
 *  7. HTTP 429/503 lowers the connection count for this download (IDM: CMaxConnNumbers).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { request, HttpError } = require('./http');
const { probe } = require('./probe');
const { sleep, uniquePath } = require('./util');

class RangeUnsupported extends Error {}
class EntityChanged extends Error {}

const MIN_SPLIT = 256 * 1024; // never split a segment that has < 2 x this left

class SegmentedDownload extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.url
   * @param {string} o.dir            destination folder (used when o.target not given)
   * @param {string} [o.target]       exact destination path (used to resume)
   * @param {string} [o.filename]     override detected file name
   * @param {object} [o.headers]      extra request headers (cookie, referer, user-agent...)
   * @param {number} [o.connections]  max parallel connections (default 8)
   * @param {import('./limiter').RateLimiter} [o.limiter]
   * @param {number} [o.maxRetries]   per-segment consecutive failures before giving up
   */
  constructor(o) {
    super();
    this.o = { connections: 8, maxRetries: 8, ...o };
    this.segments = [];
    this.stopped = false;
    this.single = false;
    this.speed = 0;
  }

  get downloaded() {
    return this.segments.reduce((sum, s) => sum + (Math.min(s.pos, s.end + 1) - s.start), 0);
  }

  async start() {
    if (this.userPaused) return { paused: true };
    this.stopped = false;
    this.ac = new AbortController();
    const o = this.o;
    const info = await probe(o.url, { headers: o.headers, signal: this.ac.signal });
    this.info = info;
    this.url = info.finalUrl;
    this.size = info.size;

    if (!o.target) {
      await fsp.mkdir(o.dir, { recursive: true });
      const name = o.filename || info.filename;
      const same = path.join(o.dir, name);
      // An unfinished download of the same URL already exists here -> continue it.
      let prior = null;
      const priorState = o.workDir ? path.join(o.workDir, name + '.mdmpart.json') : same + '.mdmpart.json';
      try { prior = JSON.parse(fs.readFileSync(priorState, 'utf8')); } catch { /* none */ }
      // "Replace" (the user chose it): same name; otherwise "file (1).zip" when the name is taken
      o.target = (prior && prior.url === o.url) || o.overwrite ? same : uniquePath(o.dir, name);
    }
    this.target = o.target;
    // Unfinished data lives in the job's work folder (inside Mechano DM), so the save folder only
    // ever gets the finished file. Older downloads without one keep "<target>.mdmpart" next to it.
    this.part = o.workDir ? path.join(o.workDir, path.basename(this.target) + '.mdmpart') : this.target + '.mdmpart';
    this.statePath = this.part + '.json';
    this.emit('meta', { target: this.target, size: this.size, resumable: info.resumable, filename: path.basename(this.target) });

    const saved = await this.loadState();
    const sameEntity = saved && saved.size === info.size && info.resumable &&
      (!saved.etag || !info.etag || saved.etag === info.etag) &&
      (!saved.lastModified || !info.lastModified || saved.lastModified === info.lastModified) &&
      fs.existsSync(this.part);

    if (sameEntity) {
      this.segments = saved.segments.map((s) => ({ start: s.start, end: s.end, pos: s.pos }));
      this.emit('log', `Resuming at ${this.downloaded} / ${this.size} bytes`);
    } else {
      this.single = !info.resumable;
      this.segments = [{ start: 0, end: this.single ? Infinity : info.size - 1, pos: 0 }];
    }
    this.validator = info.etag || info.lastModified;
    return this.run(!sameEntity);
  }

  async run(fresh) {
    await fsp.mkdir(path.dirname(this.part), { recursive: true });
    this.fh = await fsp.open(this.part, fresh || !fs.existsSync(this.part) ? 'w+' : 'r+');
    if (fresh && this.size && !this.single) await this.fh.truncate(this.size);

    this.maxConn = this.single ? 1 : Math.max(1, this.o.connections);
    this.active = 0;
    const timer = this.startProgressTimer();
    let failure = null;
    try {
      const workers = [];
      for (let i = 0; i < this.maxConn; i++) workers.push(this.worker());
      const results = await Promise.allSettled(workers);
      failure = results.find((r) => r.status === 'rejected')?.reason || null;
    } finally {
      clearInterval(timer);
    }

    if (failure instanceof RangeUnsupported && !this.single && !this.userPaused) {
      this.emit('log', 'Server refused ranged requests; restarting with one connection');
      await this.fh.close();
      this.single = true;
      this.info.resumable = false;
      this.stopped = false;
      this.ac = new AbortController();
      this.segments = [{ start: 0, end: this.size ? this.size - 1 : Infinity, pos: 0 }];
      return this.run(true);
    }
    if (failure instanceof EntityChanged) {
      await this.fh.close();
      await this.clearState();
      throw new Error('The file changed on the server; restart the download from the beginning.');
    }

    const complete = this.single ? this.singleDone : this.segments.every((s) => s.pos > s.end);
    if (!complete) {
      await this.saveState();
      await this.fh.close();
      if (this.userPaused) { this.emit('paused'); return { paused: true }; }
      throw failure || new Error('Download did not complete');
    }

    if (this.single) await this.fh.truncate(this.downloaded);
    await this.fh.close();
    let finalPath = this.target;
    if (fs.existsSync(finalPath)) {
      if (this.o.overwrite) await fsp.rm(finalPath, { force: true }); // the old file goes only now, when the new one is complete
      else finalPath = uniquePath(path.dirname(finalPath), path.basename(finalPath));
    }
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await moveFile(this.part, finalPath);
    await this.clearState();
    this.target = finalPath;
    this.emit('progress', this.progress());
    this.emit('done', { file: finalPath, size: this.downloaded });
    return { file: finalPath, size: this.downloaded };
  }

  // --- segment scheduling -------------------------------------------------

  claim() {
    const idle = this.segments.find((s) => !s.busy && s.pos <= s.end);
    if (idle) { idle.busy = true; return idle; }
    if (this.single) return null;
    // Split the busy segment with the most bytes left (dynamic segmentation).
    let best = null;
    let bestLeft = 0;
    for (const s of this.segments) {
      const from = s.pos + (s.inflight || 0);
      const left = s.end - from + 1;
      if (s.busy && left > bestLeft) { best = s; bestLeft = left; }
    }
    if (!best || bestLeft < 2 * MIN_SPLIT) return null;
    const from = best.pos + (best.inflight || 0);
    const mid = from + Math.floor(bestLeft / 2);
    const seg = { start: mid, end: best.end, pos: mid, busy: true };
    best.end = mid - 1;
    this.segments.push(seg);
    this.segments.sort((a, b) => a.start - b.start);
    return seg;
  }

  async worker() {
    this.active++;
    try {
      while (!this.stopped) {
        if (this.active > this.maxConn) return; // connection budget was reduced
        const seg = this.claim();
        if (!seg) return;
        try {
          await this.fetchSegment(seg);
          seg.failures = 0;
        } catch (err) {
          seg.busy = false;
          seg.inflight = 0;
          if (this.stopped) return;
          if (err instanceof RangeUnsupported || err instanceof EntityChanged) { this.stop(); throw err; }
          if (err instanceof HttpError && [429, 503].includes(err.status) && this.maxConn > 1) {
            this.maxConn--;
            this.emit('log', `Server is throttling (HTTP ${err.status}); using ${this.maxConn} connections`);
          }
          if (err instanceof HttpError && err.status >= 400 && err.status < 500 && ![408, 429].includes(err.status)) {
            seg.failures = (seg.failures || 0) + 3; // likely an expired link; fail faster
          }
          seg.failures = (seg.failures || 0) + 1;
          this.emit('log', `Segment @${seg.pos}: ${err.message} (attempt ${seg.failures})`);
          if (seg.failures > this.o.maxRetries) { this.stop(); throw err; }
          await sleep(Math.min(30000, 500 * 2 ** seg.failures), this.ac.signal);
        }
      }
    } finally {
      this.active--;
    }
  }

  async fetchSegment(seg) {
    if (this.single && seg.pos > 0 && !this.info.resumable) {
      // Cannot continue a non-resumable download: start over.
      seg.pos = 0;
      await this.fh.truncate(0);
    }
    // Some servers (YouTube's googlevideo) slow a connection down to playback speed when one
    // request asks for a big range: o.maxRequest splits a segment into several smaller requests.
    const maxReq = this.single ? 0 : this.o.maxRequest || 0;
    do {
      const headers = { ...this.o.headers };
      if (!this.single || seg.pos > 0) {
        const end = isFinite(seg.end) ? (maxReq ? Math.min(seg.end, seg.pos + maxReq - 1) : seg.end) : '';
        headers.range = `bytes=${seg.pos}-${end}`;
        if (this.validator) headers['if-range'] = this.validator;
      }
      const reqEnd = maxReq && isFinite(seg.end) ? Math.min(seg.end, seg.pos + maxReq - 1) : seg.end;
      const { res } = await request(this.url, { headers, signal: this.ac.signal });
      if (res.statusCode === 200 && headers.range) {
        res.destroy();
        if (this.validator && this.info.resumable) throw new EntityChanged();
        throw new RangeUnsupported();
      }
      if (res.statusCode >= 400) { res.resume(); throw new HttpError(res.statusCode, this.url); }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); throw new Error(`Unexpected HTTP ${res.statusCode}`); }

      for await (const chunk of res) {
        if (this.stopped) { res.destroy(); return; }
        const left = seg.end - seg.pos + 1;
        if (left <= 0) break;
        const buf = chunk.length > left ? chunk.subarray(0, left) : chunk;
        seg.inflight = buf.length; // protects these bytes from being split away
        if (this.o.limiter) await this.o.limiter.take(buf.length, this.ac.signal);
        await this.fh.write(buf, 0, buf.length, seg.pos);
        seg.pos += buf.length;
        seg.inflight = 0;
        if (seg.pos > seg.end) break;
      }
      res.destroy();
      if (this.stopped) return;
      // this request's slice is done but the segment isn't: ask for the next slice
      if (!(maxReq && seg.pos > reqEnd && seg.pos <= seg.end)) break;
    } while (true); // eslint-disable-line no-constant-condition
    seg.busy = false;
    if (this.single && !isFinite(seg.end)) { this.singleDone = true; seg.end = seg.pos - 1; return; }
    if (this.stopped) return;
    if (seg.pos <= seg.end) throw new Error('Connection closed early');
    if (this.single) this.singleDone = true;
  }

  // --- control / progress / persistence -----------------------------------

  /** Abort every connection (used internally on fatal errors). */
  stop() {
    this.stopped = true;
    this.ac?.abort();
  }

  /** Pause: stop all connections; run() then persists the segment table. */
  pause() {
    this.userPaused = true;
    this.stop();
  }

  progress() {
    const done = this.downloaded;
    return {
      downloaded: done,
      size: this.size,
      speed: this.speed,
      eta: this.size && this.speed > 0 ? Math.round((this.size - done) / this.speed) : null,
      connections: this.segments.filter((s) => s.busy).length,
      segments: this.segments.map((s) => [s.start, Math.min(s.pos, s.end + 1), isFinite(s.end) ? s.end : null]),
    };
  }

  startProgressTimer() {
    let last = this.downloaded;
    let lastT = Date.now();
    let lastSave = Date.now();
    return setInterval(() => {
      const now = Date.now();
      const d = this.downloaded;
      const inst = ((d - last) * 1000) / Math.max(1, now - lastT);
      this.speed = this.speed ? this.speed * 0.7 + inst * 0.3 : inst; // smoothed
      last = d; lastT = now;
      this.emit('progress', this.progress());
      if (now - lastSave > 2000 && !this.single) { lastSave = now; this.saveState().catch(() => {}); }
    }, 500);
  }

  async loadState() {
    try { return JSON.parse(await fsp.readFile(this.statePath, 'utf8')); } catch { return null; }
  }

  async saveState() {
    if (this.single) return; // a non-resumable stream cannot be continued later
    const state = {
      url: this.o.url, size: this.size, etag: this.info.etag, lastModified: this.info.lastModified,
      segments: this.segments.map(({ start, end, pos }) => ({ start, end, pos })),
    };
    const tmp = this.statePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state));
    await fsp.rename(tmp, this.statePath);
  }

  async clearState() {
    await fsp.rm(this.statePath, { force: true });
  }
}

/** Rename, or copy + delete when the work folder and the save folder are on different drives. */
async function moveFile(from, to) {
  try { await fsp.rename(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(from, to);
    await fsp.rm(from, { force: true });
  }
}

module.exports = { SegmentedDownload, moveFile };
