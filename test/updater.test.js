'use strict';
process.env.MDM_NO_SCAN = '1'; // no real Microsoft Defender scans during tests
// Updater rules, with a fake yt-dlp (nothing is downloaded or installed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Manager } = require('../src/manager');
const { Updater, DAY } = require('../src/updater');
const { isPlaylistUrl } = require('../src/ytdlp');

function setup({ version = '2026.08.19', newVersion = '2026.10.15', lastUpdate = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-upd-'));
  const m = new Manager(dataDir);
  clearInterval(m.scheduler);
  m.tools = () => ({ ytdlp: 'C:\\fake\\yt-dlp.exe', ffmpeg: null, node: process.execPath });
  m.config.ytdlpLastUpdate = lastUpdate;
  m.config.confirmDownloads = false; // these tests are about updating, not the approval popup
  let current = version;
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    current = newVersion;
    return { code: 0, out: `Updated yt-dlp to stable@${newVersion}` };
  };
  const u = new Updater(m, { firstCheckDelayMs: 1e9, checkEveryMs: 1e9, exec, versionOf: () => current });
  u.stop();
  return { m, u, calls };
}

test('manual update replaces yt-dlp and records the time', async () => {
  const { m, u, calls } = setup();
  const s = await u.update('manual');
  assert.deepEqual(calls, ['C:\\fake\\yt-dlp.exe -U']);
  assert.equal(s.lastResult.ok, true);
  assert.match(s.lastResult.message, /2026\.08\.19 → 2026\.10\.15/);
  assert.equal(s.version, '2026.10.15');
  assert.ok(Date.now() - m.config.ytdlpLastUpdate < 5000);
  m.shutdown();
});

test('automatic update only runs once the interval (5 days) has passed', async () => {
  const recent = setup({ lastUpdate: Date.now() - 2 * DAY });
  recent.u.checkDue();
  assert.equal(recent.calls.length, 0, 'updated 2 days ago: nothing to do');
  recent.m.shutdown();

  const due = setup({ lastUpdate: Date.now() - 6 * DAY });
  due.u.checkDue();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(due.calls.length, 1, 'updated 6 days ago: update runs');
  due.m.shutdown();

  const off = setup({ lastUpdate: null });
  off.m.config.autoUpdateDays = 0;
  off.u.checkDue();
  assert.equal(off.calls.length, 0, 'auto-update switched off');
  off.m.shutdown();
});

test('update waits while a yt-dlp download is running, then runs by itself', async () => {
  const { m, u, calls } = setup();
  const job = m.add({ url: 'https://www.youtube.com/watch?v=abc', kind: 'ytdlp' });
  m.runners.set(job.id, { pause() {} }); // pretend it is downloading
  const s = await u.update('manual');
  assert.equal(s.pending, true);
  assert.equal(calls.length, 0, 'must not replace yt-dlp.exe while it is in use');
  m.runners.delete(job.id);
  m.emit('runner-finished', job.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1, 'ran as soon as the download finished');
  assert.equal(u.status().pending, false);
  m.shutdown();
});

test('new yt-dlp jobs stay queued while yt-dlp is being updated', () => {
  const { m } = setup();
  m.config.maxConcurrent = 0; // stop add() from starting it immediately
  const job = m.add({ url: 'https://www.youtube.com/watch?v=abc', kind: 'ytdlp' });
  m.config.maxConcurrent = 3;
  m.updating = true;
  m.run = () => assert.fail('must not start while updating');
  m.pump();
  assert.equal(m.get(job.id).status, 'queued');
  m.shutdown();
});

test('playlist links are recognised', () => {
  const { m } = setup();
  assert.equal(isPlaylistUrl('https://www.youtube.com/playlist?list=PL123'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=abc&list=PL123'), true);
  assert.equal(isPlaylistUrl('https://www.youtube.com/watch?v=abc'), false);
  m.config.maxConcurrent = 0;
  assert.equal(m.add({ url: 'https://www.youtube.com/playlist?list=PL123' }).playlist, true, '/playlist page = whole playlist');
  assert.equal(m.add({ url: 'https://www.youtube.com/watch?v=abc&list=PL123' }).playlist, false, 'video in a list = one video unless asked');
  assert.equal(m.add({ url: 'https://www.youtube.com/watch?v=abc&list=PL123', playlist: true }).playlist, true);
  m.shutdown();
});

test('the folder build (bin/yt-dlp/) is updated by download, not by yt-dlp -U', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-upd-'));
  const m = new Manager(dataDir);
  clearInterval(m.scheduler);
  m.tools = () => ({ ytdlp: 'C:/fake/yt-dlp/yt-dlp.exe', ffmpeg: null, node: process.execPath });
  const calls = [];
  const u = new Updater(m, {
    firstCheckDelayMs: 1e9, checkEveryMs: 1e9, versionOf: () => '2026.08.19', isFolder: () => true,
    exec: async (cmd) => { calls.push(cmd); return { code: 0, out: '' }; },
    folderUpdate: async (exe, current) => { calls.push(`folder ${current}`); return { version: '2026.10.26', changed: true }; },
  });
  u.stop();
  const s = await u.update('manual');
  assert.deepEqual(calls, ['folder 2026.08.19']);
  assert.equal(s.lastResult.ok, true);
  assert.equal(s.lastResult.method, 'download');
  assert.equal(s.version, '2026.10.26');
  assert.equal(s.running, false);
  m.shutdown();
});

test('probeMp4 reads width and height of a progressive MP4 (Facebook sd/hd)', async () => {
  const http = require('node:http');
  const { probeMp4 } = require('../src/ytdlp');
  // minimal "moov": an audio track (0 x 0) then a 640 x 360 video track, each with a 92-byte tkhd
  const tkhd = (w, h) => { const b = Buffer.alloc(92); b.writeUInt32BE(92, 0); b.write('tkhd', 4); b.writeUInt32BE(w * 65536, 84); b.writeUInt32BE(h * 65536, 88); return b; };
  const body = Buffer.concat([Buffer.from('....ftypisom'), tkhd(0, 0), Buffer.from('mp4a'), tkhd(640, 360), Buffer.from('avc1'), Buffer.alloc(1000)]);
  const server = http.createServer((req, res) => {
    res.writeHead(206, { 'content-range': `bytes 0-${body.length - 1}/5000000`, 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const p = await probeMp4(`http://127.0.0.1:${server.address().port}/v.mp4`);
    assert.deepEqual(p, { width: 640, height: 360, size: 5000000, vcodec: 'avc1', acodec: 'mp4a' });
  } finally { server.close(); }
});
