'use strict';
/**
 * Whole-playlist download with control over every video (IDM-style list):
 *  - the playlist is read first (title + videos), then the videos download ONE BY ONE
 *    in the order of job.entries, so you can see which video is downloading,
 *    skip videos (also the one downloading now) and re-order the ones still waiting.
 *  - each video is a normal YtdlpDownload into "<folder>\<playlist title>\NNN - <title> [id].ext"
 *    (NNN = position in the original playlist).
 *  - pause stops the current video (yt-dlp keeps its .part file) and continues from there later.
 *
 * Entry states: waiting | downloading | done | skipped | error
 */
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { YtdlpDownload, playlistInfo } = require('./ytdlp');
const { sanitizeFilename } = require('./util');

class PlaylistDownload extends EventEmitter {
  /**
   * @param {object} job   the manager's job object (job.entries is shared and edited live)
   * @param {object} o     { dir, ytdlp, ffmpeg, cookiesFile, referer, userAgent, maxHeight, audioOnly, rateLimit, fragments }
   */
  constructor(job, o) {
    super();
    this.job = job;
    this.o = o;
    this.current = null;
  }

  async start() {
    const job = this.job;
    if (this.userPaused) return { paused: true };
    if (!job.entries || !job.entries.length) {
      const pl = await playlistInfo(job.url, { ytdlp: this.o.ytdlp, cookiesFile: this.o.cookiesFile });
      if (!pl.count) throw new Error('This playlist has no videos (or they are all private)');
      job.playlistTitle = pl.title || 'Playlist';
      job.entries = pl.entries.map((e) => ({ ...e, state: 'waiting', downloaded: 0, size: null, file: null, error: null }));
    }
    // A video that was downloading when the app closed continues where it stopped.
    for (const e of job.entries) if (e.state === 'downloading') e.state = 'waiting';
    const folder = path.join(this.o.dir, sanitizeFilename(job.playlistTitle).slice(0, 80));
    this.folder = folder;
    this.emit('meta', { filename: `${job.playlistTitle} (${job.entries.length} videos)`, playlistTitle: job.playlistTitle, playlistCount: job.entries.length });

    while (!this.userPaused) {
      const e = job.entries.find((x) => x.state === 'waiting'); // first waiting video in YOUR order
      if (!e) break;
      await this.downloadEntry(e, folder);
    }
    if (this.userPaused) { this.emit('paused'); return { paused: true }; }

    const done = job.entries.filter((e) => e.state === 'done');
    const failed = job.entries.filter((e) => e.state === 'error').length;
    if (!done.length && failed) throw new Error(job.entries.find((e) => e.state === 'error').error || 'No video could be downloaded');
    const size = done.reduce((n, e) => n + (e.size || 0), 0);
    this.emit('done', { file: folder, size, count: done.length });
    return { file: folder, size, count: done.length, skipped: failed };
  }

  async downloadEntry(e, folder) {
    const pad = String(e.idx).padStart(3, '0');
    const d = new YtdlpDownload({
      ...this.o, url: e.url, dir: folder, playlist: false,
      outTemplate: `${pad} - %(title).100B [%(id)s].%(ext)s`,
    });
    this.current = { entry: e, dl: d }; // set before announcing, so "skip" works right away
    e.state = 'downloading';
    e.error = null;
    this.changed();
    d.on('progress', (p) => {
      e.downloaded = p.downloaded; e.size = p.size ?? e.size;
      this.emit('progress', { ...p, ...this.position() });
    });
    d.on('log', (l) => this.emit('log', `[${pad}] ${l}`));
    try {
      if (e.state === 'skipped') return; // skipped in the same moment it was about to start
      const r = await d.start();
      if (r && r.paused) {
        // Paused by the user, or skipped while downloading
        if (e.state === 'downloading') e.state = this.userPaused ? 'waiting' : 'skipped';
      } else {
        e.state = 'done';
        e.file = r.file;
        if (r.size != null) { e.size = r.size; e.downloaded = r.size; }
      }
    } catch (err) {
      if (e.state === 'downloading') { e.state = 'error'; e.error = err.message; }
      this.emit('log', `[${pad}] skipped: ${err.message}`);
    } finally {
      this.current = null;
      this.changed();
    }
  }

  /** Position for the progress bar: videos finished, which one is running, how many will be downloaded. */
  position() {
    const list = this.job.entries;
    const total = list.filter((x) => x.state !== 'skipped').length;
    const finished = list.filter((x) => x.state === 'done' || x.state === 'error').length;
    return { playlistIndex: Math.min(total, finished + 1), playlistCount: total, playlistDone: finished };
  }

  changed() { this.emit('entries', this.position()); }

  /** Skip the video that is downloading right now (the next one starts). */
  skipCurrent(entryId) {
    if (this.current && this.current.entry.id === entryId) {
      this.current.entry.state = 'skipped';
      this.current.dl.pause();
      return true;
    }
    return false;
  }

  pause() {
    this.userPaused = true;
    if (this.current) this.current.dl.pause();
  }

  stop() { this.pause(); }
}

module.exports = { PlaylistDownload };
