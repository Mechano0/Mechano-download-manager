'use strict';
/**
 * Torrents (magnet links and .torrent links) through aria2c (bin\aria2c.exe, GPL-2.0, see
 * bin\aria2-COPYING.txt). Each torrent gets its own aria2c, controlled over JSON-RPC on
 * 127.0.0.1 with a random port and a random secret, and closed when the torrent finishes or
 * is paused. Resume: aria2 keeps a .aria2 control file next to the data and continues from it.
 * Seeding stops as soon as the download is complete (--seed-time=0).
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { findTool } = require('./ytdlp');
const { sanitizeFilename, sleep } = require('./util');

const isMagnet = (u) => /^magnet:\?/i.test(String(u || ''));
const isTorrentUrl = (u) => { try { return /\.torrent$/i.test(new URL(u).pathname); } catch { return false; } };

/** Name and size from a magnet link (dn=, xl=) or a .torrent URL, without downloading anything. */
async function describe(url) {
  if (isMagnet(url)) {
    const q = new URLSearchParams(String(url).slice(String(url).indexOf('?') + 1));
    const hash = (q.get('xt') || '').split(':').pop();
    return { name: q.get('dn') || `Torrent ${hash.slice(0, 10)}`, size: Number(q.get('xl')) || null, hash };
  }
  const name = decodeURIComponent(path.basename(new URL(url).pathname)).replace(/\.torrent$/i, '');
  return { name: name || 'Torrent', size: null };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

class TorrentDownload extends EventEmitter {
  /** @param {{ url: string, dir: string, aria2?: string, speedLimit?: number, connections?: number }} o */
  constructor(o) {
    super();
    this.o = o;
    this.userPaused = false;
  }

  async rpc(method, ...params) {
    const res = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomBytes(4).toString('hex'), method, params: [`token:${this.secret}`, ...params] }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }

  async start() {
    const aria2 = this.o.aria2 || findTool('aria2c');
    if (!aria2) throw new Error('Torrent support needs aria2c.exe in the bin folder.');
    fs.mkdirSync(this.o.dir, { recursive: true });
    this.port = await freePort();
    this.secret = crypto.randomBytes(16).toString('hex');
    const args = [
      '--enable-rpc', '--rpc-listen-all=false', `--rpc-listen-port=${this.port}`, `--rpc-secret=${this.secret}`,
      `--dir=${this.o.dir}`, '--continue=true', '--seed-time=0', '--bt-save-metadata=true', '--bt-load-saved-metadata=true',
      '--file-allocation=none', '--summary-interval=0', '--console-log-level=warn', '--check-certificate=true',
      '--auto-file-renaming=false', '--allow-overwrite=false', `--max-connection-per-server=${Math.min(16, this.o.connections || 8)}`,
      '--bt-max-peers=80', '--auto-save-interval=5', '--show-console-readout=false', '--quiet=false', '--enable-dht=true', '--enable-peer-exchange=true', '--follow-torrent=mem',
    ];
    if (this.o.speedLimit) args.push(`--max-overall-download-limit=${Math.round(this.o.speedLimit)}`);
    this.proc = spawn(aria2, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    this.proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    this.proc.stdout.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) if (/ERROR|WARN/.test(l) && !/DHT routing table/.test(l)) this.emit('log', l.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 200)); });
    const exited = new Promise((r) => this.proc.on('close', r));

    // wait for the RPC port
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(150);
      try { await this.rpc('aria2.getVersion'); ready = true; } catch { /* starting */ }
    }
    if (!ready) { this.kill(); throw new Error('aria2c did not start' + (stderr ? ': ' + stderr.trim().split(/\r?\n/).pop() : '')); }

    let gid = await this.rpc('aria2.addUri', [this.o.url], {});
    this.emit('log', isMagnet(this.o.url) ? 'Looking for peers and the torrent information…' : 'Getting the .torrent file…');
    let named = false;
    try {
      while (true) {
        if (this.userPaused) { await this.stopAria(); return { paused: true }; }
        const st = await this.rpc('aria2.tellStatus', gid, ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'numSeeders', 'followedBy', 'errorMessage', 'bittorrent', 'files', 'dir']);
        if (st.followedBy && st.followedBy.length) { gid = st.followedBy[0]; continue; } // metadata → real download
        const name = st.bittorrent && st.bittorrent.info && st.bittorrent.info.name;
        if (name && !named) {
          named = true;
          this.emit('meta', { filename: name, size: Number(st.totalLength) || null, target: path.join(this.o.dir, name) });
          this.emit('log', `Torrent: ${name} · ${st.files ? st.files.length : '?'} file(s)`);
        }
        const total = Number(st.totalLength) || 0, done = Number(st.completedLength) || 0, speed = Number(st.downloadSpeed) || 0;
        if (st.status === 'complete') {
          if (!name) { await sleep(500); continue; } // metadata just finished; the real job follows
          await this.stopAria();
          const file = path.join(this.o.dir, name);
          return { file: fs.existsSync(file) ? file : this.o.dir, size: total || done };
        }
        if (st.status === 'error' || st.status === 'removed') throw new Error(st.errorMessage || 'The torrent download failed');
        this.emit('progress', {
          downloaded: done, size: total || null, speed,
          eta: speed > 0 && total ? Math.round((total - done) / speed) : null,
          connections: Number(st.connections) || 0,
        });
        await Promise.race([sleep(1000), exited]);
        if (this.proc.exitCode != null && !this.userPaused) throw new Error('aria2c stopped' + (stderr ? ': ' + stderr.trim().split(/\r?\n/).pop() : ''));
      }
    } catch (e) {
      await this.stopAria();
      if (this.userPaused) return { paused: true };
      throw e;
    }
  }

  async stopAria() {
    if (!this.proc || this.proc.exitCode != null) return;
    // forceShutdown: no goodbye to the trackers (that can take long), but the .aria2 resume file is written
    try { await this.rpc('aria2.forceShutdown'); } catch { /* already stopping */ }
    for (let i = 0; i < 100 && this.proc.exitCode == null; i++) await sleep(100);
    this.kill();
  }

  kill() { try { if (this.proc && this.proc.exitCode == null) this.proc.kill(); } catch { /* gone */ } }

  pause() { this.userPaused = true; }
}

module.exports = { TorrentDownload, describe, isMagnet, isTorrentUrl, sanitizeTorrentName: sanitizeFilename };
