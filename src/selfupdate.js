'use strict';
/**
 * Updates of Mechano DM itself (optional: Settings → App updates = Tell me / Install automatically / Off).
 *
 * How it stays safe:
 *  - The release publishes version.json: { version, notes, setup: { url, size, sha256 }, signature }.
 *  - signature = Ed25519 over the JSON text of everything except "signature", made with a private
 *    key that never leaves the developer's PC (tools/sign-release.js). Only the public key is here,
 *    so a changed version.json or a different Setup.exe is refused.
 *  - The downloaded Setup.exe must match the signed size and SHA-256 before it can be installed.
 *  - Installing needs an installed copy (install-files.txt next to the app). Portable copies only
 *    get the "new version" note with a link to the download page.
 *  - Mechano DM.exe starts the installer (it is outside the engine's kill-on-close job), the
 *    installer closes the app, replaces the files and starts it again. data\ is never touched.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const PUBLIC_KEY = 'MCowBQYDK2VwAyEA2rxQZf4ACUZPoHx1puucM1enPjdte7Fb7xKGPT4v1rM=';
const FEED = 'https://github.com/Mechano0/mechano-download-manager/releases/latest/download/version.json';
const RELEASES = 'https://github.com/Mechano0/mechano-download-manager/releases/latest';
const APP_DIR = path.join(__dirname, '..');
const HOUR = 60 * 60 * 1000;

function currentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

/** 1.10.0 > 1.9.3 */
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

/** The exact text that is signed: the manifest without "signature", keys sorted. */
function signedText(manifest) {
  const { signature, ...rest } = manifest;
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(rest));
}

function verifyManifest(manifest, publicKey = PUBLIC_KEY) {
  if (!manifest || typeof manifest.signature !== 'string') return false;
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) return false;
  const s = manifest.setup || {};
  if (!/^https:\/\//.test(s.url || '') || !/^[a-f0-9]{64}$/.test(s.sha256 || '') || !(s.size > 0)) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(signedText(manifest)), key, Buffer.from(manifest.signature, 'base64'));
  } catch { return false; }
}

class SelfUpdater extends EventEmitter {
  /** @param {import('./manager').Manager} manager */
  constructor(manager, { feed = FEED, publicKey = PUBLIC_KEY, fetchImpl = globalThis.fetch, firstCheckDelayMs = 2 * 60 * 1000 } = {}) {
    super();
    this.m = manager;
    this.feed = feed;
    this.publicKey = publicKey;
    this.fetch = fetchImpl;
    this.state = {
      current: currentVersion(), latest: null, available: false, notes: null, checkedAt: null,
      downloading: false, progress: 0, ready: false, installing: false, error: null,
      installed: fs.existsSync(path.join(APP_DIR, 'install-files.txt')), page: RELEASES,
    };
    this.installFile = null; // set when a verified Setup.exe is ready; Mechano DM.exe runs it
    this.first = setTimeout(() => this.check('auto'), firstCheckDelayMs);
    this.timer = setInterval(() => this.check('auto'), 12 * HOUR);
    // "Install automatically" waits for running downloads: look again every few minutes until they are done.
    this.idle = setInterval(() => this.autoInstallIfIdle(), 5 * 60 * 1000);
    this.first.unref?.();
    this.timer.unref?.();
    this.idle.unref?.();
  }

  get mode() { return this.m.config.appUpdate || 'notify'; }
  status() { return { ...this.state, mode: this.mode, launch: this.installFile }; }
  emitStatus() { this.emit('status', this.status()); }

  async check(reason = 'manual') {
    if (reason === 'auto' && this.mode === 'off') return this.status();
    if (this.checking) return this.status();
    this.checking = true;
    try {
      const res = await this.fetch(this.feed, { redirect: 'follow', headers: { 'user-agent': 'MechanoDM-updater' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) throw new Error('No release information yet');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = await res.json();
      if (!verifyManifest(manifest, this.publicKey)) throw new Error('The update information is not signed correctly. Ignored.');
      this.manifest = manifest;
      this.state.latest = manifest.version;
      this.state.notes = String(manifest.notes || '').slice(0, 2000) || null;
      this.state.available = newer(manifest.version, this.state.current);
      this.state.error = null;
      if (reason === 'auto') this.autoInstallIfIdle();
    } catch (e) {
      this.state.error = e.name === 'TimeoutError' ? 'No answer from GitHub' : e.message;
    } finally {
      this.state.checkedAt = Date.now();
      this.checking = false;
      this.emitStatus();
    }
    return this.status();
  }

  /** "Install automatically": only when nothing is downloading, because the installer restarts the app. */
  autoInstallIfIdle() {
    const s = this.state;
    if (this.mode !== 'auto' || !s.available || !s.installed || s.downloading || s.installing || this.installFile) return false;
    if (this.m.runners.size > 0) return false;
    this.install().catch(() => {});
    return true;
  }

  /** Downloads the signed Setup.exe, checks it, then hands it to Mechano DM.exe to run. */
  async install() {
    if (!this.state.installed) throw new Error('This is a portable copy. Download the new version from the Releases page.');
    if (!this.manifest || !this.state.available) await this.check('manual');
    if (!this.state.available) throw new Error('Mechano DM is up to date.');
    if (this.state.downloading) return this.status();
    const { url, size, sha256 } = this.manifest.setup;
    const dir = path.join(this.m.dataDir, 'update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Mechano DM Setup ${this.manifest.version}.exe`);
    this.state.downloading = true; this.state.progress = 0; this.state.error = null; this.state.ready = false;
    this.emitStatus();
    try {
      if (!(fs.existsSync(file) && await hashFile(file) === sha256)) {
        const res = await this.fetch(url, { redirect: 'follow', headers: { 'user-agent': 'MechanoDM-updater' } });
        if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(file + '.part');
        let got = 0, lastEmit = 0;
        for await (const chunk of res.body) {
          got += chunk.length;
          if (got > size) throw new Error('The download is bigger than the signed size');
          hash.update(chunk);
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
          if (Date.now() - lastEmit > 500) { lastEmit = Date.now(); this.state.progress = got / size; this.emitStatus(); }
        }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
        if (got !== size || hash.digest('hex') !== sha256) { fs.rmSync(file + '.part', { force: true }); throw new Error('The downloaded installer does not match the signed release. It was deleted.'); }
        fs.renameSync(file + '.part', file);
      }
      this.state.progress = 1;
      this.state.ready = true;
      this.state.installing = true;
      this.installFile = file; // Mechano DM.exe sees this in /api/app-update and starts it
    } catch (e) {
      this.state.error = e.message;
      throw e;
    } finally {
      this.state.downloading = false;
      this.emitStatus();
    }
    return this.status();
  }

  stop() { clearTimeout(this.first); clearInterval(this.timer); clearInterval(this.idle); }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

module.exports = { SelfUpdater, verifyManifest, signedText, newer, currentVersion, PUBLIC_KEY };
