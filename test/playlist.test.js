'use strict';
// Playlist video list (skip / include / move) and the quality choice from the "New download" window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Manager } = require('../src/manager');
const { PlaylistDownload } = require('../src/playlist');
const ytdlp = require('../src/ytdlp');

function manager() {
  const m = new Manager(fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-pl-')));
  clearInterval(m.scheduler);
  m.config.maxConcurrent = 0; // nothing really starts
  return m;
}

function playlistJob(m, n = 4) {
  const job = m.add({ url: 'https://www.youtube.com/playlist?list=PLtest', confirmed: true });
  job.entries = Array.from({ length: n }, (_, i) => ({ id: `v${i + 1}`, idx: i + 1, title: `Video ${i + 1}`, url: `https://www.youtube.com/watch?v=v${i + 1}`, state: 'waiting' }));
  return job;
}

const order = (job) => job.entries.map((e) => e.id).join(',');

test('playlist list: skip, include and re-order videos', () => {
  const m = manager();
  const job = playlistJob(m);
  assert.equal(job.playlist, true);
  m.playlistEntry(job.id, 'v2', 'skip');
  assert.equal(job.entries[1].state, 'skipped');
  assert.equal(job.playlistCount, 3, 'skipped videos are not counted');
  m.playlistEntry(job.id, 'v2', 'include');
  assert.equal(job.entries[1].state, 'waiting');
  m.playlistEntry(job.id, 'v4', 'up');
  assert.equal(order(job), 'v1,v2,v4,v3');
  m.playlistEntry(job.id, 'v4', 'top');
  assert.equal(order(job), 'v4,v1,v2,v3');
  m.playlistEntry(job.id, 'v1', 'move', 3);
  assert.equal(order(job), 'v4,v2,v3,v1');
  assert.throws(() => m.playlistEntry(job.id, 'nope', 'skip'), /not found/);
  m.shutdown();
});

test('playlist runner downloads in YOUR order, skips unticked videos, and can skip the current one', async () => {
  const m = manager();
  const job = playlistJob(m, 4);
  job.playlistTitle = 'Course';
  job.entries[2].state = 'skipped'; // v3 unticked
  m.playlistEntry(job.id, 'v4', 'top'); // v4 first
  const started = [];
  // Fake yt-dlp: each "video" finishes after a short moment unless it is paused/skipped.
  const Real = ytdlp.YtdlpDownload;
  class Fake extends EventEmitter {
    constructor(o) { super(); this.o = o; }
    start() {
      if (this.paused) return Promise.resolve({ paused: true }); // like the real one: paused before it began
      started.push(this.o.url.slice(-2));
      return new Promise((resolve) => {
        this.done = resolve;
        this.t = setTimeout(() => resolve({ file: path.join(this.o.dir, this.o.url.slice(-2) + '.mp4'), size: 10 }), 30);
      });
    }
    pause() { this.paused = true; clearTimeout(this.t); if (this.done) this.done({ paused: true }); }
  }
  require.cache[require.resolve('../src/ytdlp')].exports.YtdlpDownload = Fake;
  delete require.cache[require.resolve('../src/playlist')];
  const { PlaylistDownload: PD } = require('../src/playlist');
  try {
    const run = new PD(job, { dir: os.tmpdir(), ytdlp: 'fake' });
    let skippedCurrent = false;
    run.on('entries', () => {
      const now = job.entries.find((e) => e.state === 'downloading');
      if (now && now.id === 'v2' && !skippedCurrent) { skippedCurrent = true; run.skipCurrent('v2'); }
    });
    const r = await run.start();
    assert.deepEqual(started, ['v4', 'v1'], 'order v4, v1; v2 skipped the moment it came up; v3 was unticked');
    assert.equal(job.entries.find((e) => e.id === 'v2').state, 'skipped', 'v2 skipped while downloading');
    assert.equal(r.count, 2);
    assert.equal(path.basename(r.file), 'Course');
  } finally {
    require.cache[require.resolve('../src/ytdlp')].exports.YtdlpDownload = Real;
    delete require.cache[require.resolve('../src/playlist')];
    m.shutdown();
  }
});

test('quality chosen in the "New download" window is used', () => {
  const m = manager();
  m.config.confirmDownloads = true;
  const a = m.add({ url: 'https://www.youtube.com/watch?v=abc' });
  m.confirm(a.id, { quality: '720' });
  assert.equal(m.get(a.id).maxHeight, 720);
  assert.equal(m.get(a.id).audioOnly, false);
  const b = m.add({ url: 'https://www.youtube.com/watch?v=def' });
  m.confirm(b.id, { quality: 'audio' });
  assert.equal(m.get(b.id).audioOnly, true);
  assert.equal(m.suggestDir(m.get(b.id)), path.join(m.config.downloadDir, 'Music'), 'audio goes to Music');
  m.shutdown();
});
