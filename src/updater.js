'use strict';
/**
 * Keeps yt-dlp current. YouTube / Facebook change their players every few weeks; an old yt-dlp
 * then fails or crawls. This updates it automatically every N days (default 5) and on demand
 * (the ⟳ button in the app).
 *
 * Safety:
 *  - Windows cannot replace yt-dlp.exe while it is running, so the update waits until no
 *    yt-dlp download is active, and new yt-dlp jobs wait (stay queued) while it updates.
 *  - The folder build Mechano DM ships (bin\yt-dlp\yt-dlp.exe + _internal) can't update itself:
 *    the official yt-dlp_win.zip is downloaded from yt-dlp's GitHub release, checked against the
 *    release's SHA2-256SUMS, unpacked next to the old folder and swapped in.
 *  - A one-file yt-dlp.exe uses yt-dlp's own updater; if that is not possible, `winget upgrade`.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { toolVersion, resetToolCache, resetRuntimeCache, isFolderBuild, warmUp } = require('./ytdlp');

const DAY = 24 * 60 * 60 * 1000;

/**
 * Replace the folder build with the latest official release (only when it is newer).
 * @returns {Promise<{version: string, changed: boolean}>}
 */
async function updateFolderBuild(exe, current, { nightly = false, exec = run } = {}) {
  const repo = nightly ? 'yt-dlp/yt-dlp-nightly-builds' : 'yt-dlp/yt-dlp';
  const headers = { 'user-agent': 'Mechano-DM', accept: 'application/vnd.github+json' };
  const relRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!relRes.ok) throw new Error(`GitHub answered ${relRes.status}`);
  const rel = await relRes.json();
  const tag = String(rel.tag_name || '');
  if (!/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(tag)) throw new Error('could not read the latest yt-dlp version');
  if (current && tag === current) return { version: current, changed: false };
  const asset = (name) => ((rel.assets || []).find((a) => a.name === name) || {}).browser_download_url;
  const zipUrl = asset('yt-dlp_win.zip');
  const sumsUrl = asset('SHA2-256SUMS');
  if (!/^https:\/\//.test(zipUrl || '') || !/^https:\/\//.test(sumsUrl || '')) throw new Error('the release has no yt-dlp_win.zip');
  const sums = await (await fetch(sumsUrl, { headers: { 'user-agent': 'Mechano-DM' } })).text();
  const line = sums.split(/\r?\n/).find((l) => /\s\*?yt-dlp_win\.zip$/.test(l.trim()));
  const want = line && line.trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want || '')) throw new Error('no checksum for yt-dlp_win.zip');

  const dir = path.dirname(exe);
  const work = dir + '.download';
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const zip = path.join(work, 'yt-dlp_win.zip');
    const res = await fetch(zipUrl, { headers: { 'user-agent': 'Mechano-DM' } });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const hash = crypto.createHash('sha256');
    const body = Readable.fromWeb(res.body);
    body.on('data', (d) => hash.update(d));
    await pipeline(body, fs.createWriteStream(zip));
    if (hash.digest('hex') !== want) throw new Error('the downloaded file does not match its checksum');
    const out = path.join(work, 'x');
    fs.mkdirSync(out);
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = await exec(tar, ['-xf', zip, '-C', out], 120000);
    const fresh = path.join(out, path.basename(exe));
    if (r.code !== 0 || !fs.existsSync(fresh)) throw new Error('could not unpack yt-dlp_win.zip');
    const version = await toolVersion(fresh);
    if (!version) throw new Error('the new yt-dlp does not start');
    // swap folders (a few tries: an antivirus scan can hold files for a moment)
    const old = dir + '.old';
    fs.rmSync(old, { recursive: true, force: true });
    for (let i = 0; ; i++) {
      try { fs.renameSync(dir, old); break; } catch (e) { if (i >= 9) throw e; await new Promise((ok) => setTimeout(ok, 500)); }
    }
    try { fs.renameSync(out, dir); } catch (e) { fs.renameSync(old, dir); throw e; }
    fs.rmSync(old, { recursive: true, force: true });
    return { version, changed: true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

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
  constructor(manager, { firstCheckDelayMs = 60_000, checkEveryMs = 60 * 60 * 1000, exec = run, versionOf = toolVersion,
    isFolder = isFolderBuild, folderUpdate = updateFolderBuild } = {}) {
    super();
    this.m = manager;
    this.exec = exec; // injectable for tests
    this.versionOf = versionOf;
    this.isFolder = isFolder;
    this.folderUpdate = folderUpdate;
    this.state = { running: false, pending: false, lastResult: null, version: null };
    this.refreshVersion().then(() => this.emit('status', this.status()), () => {});
    // Check shortly after start, then hourly; the actual update only runs when it is due.
    this.firstTimer = setTimeout(() => this.checkDue(), firstCheckDelayMs);
    this.timer = setInterval(() => this.checkDue(), checkEveryMs);
    this.firstTimer.unref?.();
    this.timer.unref?.();
    manager.on('runner-finished', () => { if (this.state.pending && !this.busy()) this.update('queued'); });
  }

  get intervalDays() { return Number(this.m.config.autoUpdateDays ?? 5); }

  async refreshVersion() {
    this.state.version = await this.versionOf(this.m.tools().ytdlp);
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
    let before = null;
    let message;
    let ok = false;
    let method = 'yt-dlp -U';
    try {
      before = await this.refreshVersion();
      const nightly = this.m.config.ytdlpChannel === 'nightly';
      if (this.isFolder(exe)) {
        method = 'download';
        const r = await this.folderUpdate(exe, before, { nightly, exec: this.exec });
        ok = true;
        message = r.changed ? `Updated yt-dlp ${before} → ${r.version}` : `yt-dlp ${r.version} is already the latest version`;
        this.state.version = r.version;
      } else await this.selfUpdate(exe, nightly, before, (res) => { ({ ok, message, method } = res); });
    } catch (e) {
      message = `Update failed: ${e.message}`;
    } finally {
      resetToolCache();
      resetRuntimeCache();
      warmUp(this.m.tools().ytdlp);
      this.state.running = false;
      this.m.updating = false;
      if (ok) { this.m.config.ytdlpLastUpdate = Date.now(); this.m.saveConfig(); }
      this.state.lastResult = { ok, at: Date.now(), reason, method, message, from: before, to: this.state.version };
      this.emit('status', this.status());
      this.m.pump(); // start yt-dlp jobs that waited for the update
    }
    return this.status();
  }

  /** One-file yt-dlp.exe: its own updater, or winget when that isn't possible. */
  async selfUpdate(exe, nightly, before, report) {
    let ok = false, message, method = 'yt-dlp -U';
    try {
      const channel = nightly ? ['--update-to', 'nightly'] : ['-U'];
      const self = await this.exec(exe, channel);
      let after = await this.versionOf(exe);
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
        after = await this.versionOf(this.m.tools().ytdlp);
        ok = !!after;
        if (!ok) message = `Update failed: ${self.out.trim().split(/\r?\n/).pop()}`;
      }
      if (ok) {
        message = after !== before ? `Updated yt-dlp ${before} → ${after}` : `yt-dlp ${after} is already the latest version`;
      }
      this.state.version = after || before;
    } finally {
      report({ ok, message, method });
    }
  }

  stop() { clearTimeout(this.firstTimer); clearInterval(this.timer); }
}

module.exports = { Updater, DAY, updateFolderBuild };
