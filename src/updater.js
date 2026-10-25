'use strict';
/**
 * Keeps yt-dlp current. YouTube / Facebook change their players every few weeks; an old yt-dlp
 * then fails or crawls. This updates it automatically every N days (default 5) and on demand
 * (the ⟳ button in the app).
 *
 * Safety:
 *  - Windows cannot replace yt-dlp.exe while it is running, so the update waits until no
 *    yt-dlp download is active, and new yt-dlp jobs wait (stay queued) while it updates.
 *  - First tries yt-dlp's own updater (gets new releases the day they ship). If that is not
 *    possible for this install, falls back to `winget upgrade`.
 */
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { toolVersion, resetToolCache, resetRuntimeCache } = require('./ytdlp');

const DAY = 24 * 60 * 60 * 1000;

function run(cmd, args, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(cmd, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out: e.message }); }
    const t = setTimeout(() => { out += '\n[timed out]'; p.kill(); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

class Updater extends EventEmitter {
  /** @param {import('./manager').Manager} manager */
  constructor(manager, { firstCheckDelayMs = 60_000, checkEveryMs = 60 * 60 * 1000, exec = run, versionOf = toolVersion } = {}) {
    super();
    this.m = manager;
    this.exec = exec; // injectable for tests
    this.versionOf = versionOf;
    this.state = { running: false, pending: false, lastResult: null, version: null };
    this.refreshVersion();
    // Check shortly after start, then hourly; the actual update only runs when it is due.
    this.firstTimer = setTimeout(() => this.checkDue(), firstCheckDelayMs);
    this.timer = setInterval(() => this.checkDue(), checkEveryMs);
    this.firstTimer.unref?.();
    this.timer.unref?.();
    manager.on('runner-finished', () => { if (this.state.pending && !this.busy()) this.update('queued'); });
  }

  get intervalDays() { return Number(this.m.config.autoUpdateDays ?? 5); }

  refreshVersion() {
    this.state.version = this.versionOf(this.m.tools().ytdlp);
    return this.state.version;
  }

  status() {
    const last = this.m.config.ytdlpLastUpdate || null;
    const days = this.intervalDays;
    return {
      ...this.state,
      lastCheck: last,
      intervalDays: days,
      nextAuto: days > 0 ? (last ? last + days * DAY : Date.now()) : null,
      ytdlp: this.m.tools().ytdlp,
    };
  }

  /** Is any yt-dlp download running right now? */
  busy() {
    for (const [id] of this.m.runners) if (this.m.jobs.get(id)?.kind === 'ytdlp') return true;
    return false;
  }

  checkDue() {
    const days = this.intervalDays;
    if (!(days > 0) || this.state.running || this.state.pending) return;
    if (this.lastAttempt && Date.now() - this.lastAttempt < 6 * 60 * 60 * 1000) return; // failed recently: retry in 6 h
    const last = this.m.config.ytdlpLastUpdate || 0;
    if (Date.now() - last >= days * DAY) this.update('auto');
  }

  /**
   * @param {'manual'|'auto'|'queued'} reason
   * @returns {Promise<object>} status after the attempt (or with pending=true if it had to wait)
   */
  async update(reason = 'manual') {
    if (this.state.running) return this.status();
    const exe = this.m.tools().ytdlp;
    if (!exe) {
      this.state.lastResult = { ok: false, at: Date.now(), reason, message: 'yt-dlp is not installed. Install it with: winget install yt-dlp.yt-dlp' };
      this.emit('status', this.status());
      return this.status();
    }
    if (this.busy()) {
      this.state.pending = true; // runs as soon as the current YouTube/social downloads finish
      this.emit('status', this.status());
      return this.status();
    }

    this.state.running = true;
    this.state.pending = false;
    this.lastAttempt = Date.now();
    this.m.updating = true;
    this.emit('status', this.status());
    const before = this.refreshVersion();
    let message;
    let ok = false;
    let method = 'yt-dlp -U';
    try {
      const channel = this.m.config.ytdlpChannel === 'nightly' ? ['--update-to', 'nightly'] : ['-U'];
      const self = await this.exec(exe, channel);
      let after = this.versionOf(exe);
      if (after && after !== before) {
        ok = true;
      } else if (/up to date|up-to-date/i.test(self.out)) {
        ok = true;
      } else {
        // Self-update not possible for this install (e.g. managed by a package manager): use winget.
        method = 'winget';
        await this.exec('winget', ['upgrade', '--id', 'yt-dlp.yt-dlp', '--exact', '--silent',
          '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']);
        resetToolCache();
        after = this.versionOf(this.m.tools().ytdlp);
        ok = !!after;
        if (!ok) message = `Update failed: ${self.out.trim().split(/\r?\n/).pop()}`;
      }
      if (ok) {
        message = after !== before ? `Updated yt-dlp ${before} → ${after}` : `yt-dlp ${after} is already the latest version`;
      }
      this.state.version = after || before;
    } catch (e) {
      message = `Update failed: ${e.message}`;
    } finally {
      resetToolCache();
      resetRuntimeCache();
      this.state.running = false;
      this.m.updating = false;
      if (ok) { this.m.config.ytdlpLastUpdate = Date.now(); this.m.saveConfig(); }
      this.state.lastResult = { ok, at: Date.now(), reason, method, message, from: before, to: this.state.version };
      this.emit('status', this.status());
      this.m.pump(); // start yt-dlp jobs that waited for the update
    }
    return this.status();
  }

  stop() { clearTimeout(this.firstTimer); clearInterval(this.timer); }
}

module.exports = { Updater, DAY };
