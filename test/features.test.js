'use strict';
// Offline tests for: automatic retry, virus-scan results, "file already exists" (keep both / replace), statistics.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Manager, isRetriable } = require('../src/manager');
const scan = require('../src/scan');
const { Stats, siteOf } = require('../src/stats');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-feat-'));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const until = (m, pred) => new Promise((resolve) => { const f = (j) => { if (pred(j)) { m.off('job', f); resolve(j); } }; m.on('job', f); });

function newManager() {
  const dataDir = tmpDir();
  const m = new Manager(dataDir);
  m.updateConfig({ downloadDir: path.join(dataDir, 'downloads'), confirmDownloads: false, scanDownloads: 'off' });
  return { m, dataDir };
}

test('which failures are tried again', () => {
  for (const msg of ['connect ECONNREFUSED 127.0.0.1:1', 'read ECONNRESET', 'socket hang up', 'Unexpected HTTP 503', 'Unexpected HTTP 429', 'Connection closed early', 'getaddrinfo ENOTFOUND x'])
    assert.equal(isRetriable(msg), true, msg);
  for (const msg of ['Unexpected HTTP 404', 'Unexpected HTTP 403', 'This stream is DRM-protected', 'Invalid URL', 'The file changed on the server; restart'])
    assert.equal(isRetriable(msg), false, msg);
});

test('a download that fails on the network is retried by itself, then succeeds', async () => {
  let hits = 0;
  const body = Buffer.from('hello world, this is the file');
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits <= 2) { req.socket.destroy(); return; } // first two tries: the connection drops
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'content-disposition': 'attachment; filename="a.bin"' });
    res.end(body);
  });
  const base = await listen(srv);
  const { m } = newManager();
  m.retryDelays = [0.05, 0.05, 0.05];
  try {
    const j = m.add({ url: `${base}/a.bin` });
    const retried = await until(m, (x) => x.id === j.id && x.retries >= 1 && x.status === 'queued');
    assert.ok(retried.retryAt, 'shows when it tries again');
    const done = await until(m, (x) => x.id === j.id && ['done', 'error'].includes(x.status));
    assert.equal(done.status, 'done', done.error || done.lastError);
    assert.equal(done.retries, 0, 'counter reset after success');
    assert.equal(fs.readFileSync(done.file, 'utf8'), body.toString());
  } finally { m.shutdown(); srv.close(); srv.closeAllConnections(); }
});

test('retries stop after the limit and a 404 is not retried', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const base = await listen(srv);
  const { m } = newManager();
  m.retryDelays = [0.02];
  try {
    const nf = m.add({ url: `${base}/missing.zip` });
    const e1 = await until(m, (x) => x.id === nf.id && x.status === 'error');
    assert.equal(e1.retries || 0, 0, '404: no retry');

    m.updateConfig({ autoRetry: 2 });
    const dead = m.add({ url: 'http://127.0.0.1:1/x.zip' }); // nothing listens on port 1
    const e2 = await until(m, (x) => x.id === dead.id && x.status === 'error');
    assert.equal(e2.retries, 2, 'tried twice more, then gave up');
  } finally { m.shutdown(); srv.close(); srv.closeAllConnections(); }
});

test('Defender result is read from the exit code', () => {
  assert.deepEqual(scan.interpret(0, 'Scan finished. found no threats'), { state: 'clean', detail: null });
  const t = scan.interpret(2, 'found 1 threats.\r\nThreat                  : Trojan:Win32/Test\r\nResources               : 1 total');
  assert.equal(t.state, 'threat');
  assert.equal(t.detail, 'Trojan:Win32/Test');
  assert.equal(scan.interpret(0x800106ba, 'Failed to scan').state, 'failed');
  assert.ok(scan.compareVersions('4.18.26100.4-0', '4.18.26090.9-0') > 0);
  const job = (file, extra) => ({ file, kind: 'direct', ...extra });
  assert.equal(scan.shouldScan(job('C:\\a\\setup.exe'), 'risky'), true);
  assert.equal(scan.shouldScan(job('C:\\a\\movie.mp4'), 'risky'), false);
  assert.equal(scan.shouldScan(job('C:\\a\\movie.mp4'), 'all'), true);
  assert.equal(scan.shouldScan(job('C:\\a\\setup.exe'), 'off'), false);
});

test('finished downloads are scanned and the result is shown on the job', async () => {
  const body = Buffer.from('MZ fake program');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-length': body.length, 'content-disposition': 'attachment; filename="tool.exe"' }); res.end(body); });
  const base = await listen(srv);
  const { m } = newManager();
  m.updateConfig({ scanDownloads: 'risky' });
  const scanned = [];
  m.scanPath = async (file) => { scanned.push(file); return { state: 'threat', detail: 'Test:Fake' }; };
  const prev = process.env.MDM_NO_SCAN;
  delete process.env.MDM_NO_SCAN;
  try {
    const j = m.add({ url: `${base}/tool.exe` });
    const r = await until(m, (x) => x.id === j.id && x.scan && x.scan.state === 'threat');
    assert.equal(r.scan.detail, 'Test:Fake');
    assert.equal(scanned.length, 1);
    assert.match(r.log.join('\n'), /threat found/);
  } finally { process.env.MDM_NO_SCAN = prev; m.shutdown(); srv.close(); srv.closeAllConnections(); }
});

test('same file name: keep both (default) or replace', async () => {
  let version = 'first';
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': Buffer.byteLength(version), 'content-disposition': 'attachment; filename="notes.zip"' });
    res.end(version);
  });
  const base = await listen(srv);
  const { m } = newManager();
  try {
    const a = m.add({ url: `${base}/1` });
    const da = await until(m, (x) => x.id === a.id && x.status === 'done');
    const dir = path.dirname(da.file);

    // the dialog asks before starting: the name is taken, "keep both" would use notes (1).zip
    m.updateConfig({ confirmDownloads: true });
    const b = m.add({ url: `${base}/2` });
    assert.deepEqual(m.checkExists(b.id, { dir, name: 'notes.zip' }), { exists: true, newName: 'notes (1).zip' });
    assert.deepEqual(m.checkExists(b.id, { dir, name: 'other.zip' }), { exists: false, newName: null });

    version = 'second';
    m.confirm(b.id, { dir, onExists: 'replace' });
    const db = await until(m, (x) => x.id === b.id && x.status === 'done');
    assert.equal(db.file, da.file, 'same path');
    assert.equal(fs.readFileSync(db.file, 'utf8'), 'second', 'old file replaced');
    assert.deepEqual(fs.readdirSync(dir), ['notes.zip']);

    version = 'third';
    const c = m.add({ url: `${base}/3` });
    m.confirm(c.id, { dir });
    const dc = await until(m, (x) => x.id === c.id && x.status === 'done');
    assert.equal(path.basename(dc.file), 'notes (1).zip', 'keep both');
  } finally { m.shutdown(); srv.close(); srv.closeAllConnections(); }
});

test('statistics: per day, per site, and they survive a restart', () => {
  const dir = tmpDir();
  const now = new Date(2026, 9, 31, 12).getTime();
  const s = new Stats(dir);
  s.record({ url: 'https://www.youtube.com/watch?v=1', kind: 'ytdlp', size: 1000 }, now);
  s.record({ url: 'https://cdn.example.net/f.zip', referrer: 'https://site.example.com/page', kind: 'direct', size: 500 }, now);
  s.record({ url: 'https://youtube.com/watch?v=2', kind: 'ytdlp', size: 3000 }, now - 3 * 86400000);
  const again = new Stats(dir).summary(now);
  assert.deepEqual(again.today, { bytes: 1500, files: 2 });
  assert.deepEqual(again.week, { bytes: 4500, files: 3 });
  assert.equal(again.sites[0].site, 'youtube.com');
  assert.equal(again.sites[0].bytes, 4000);
  assert.equal(again.sites[1].site, 'site.example.com', 'CDN files count for the page they came from');
  assert.equal(again.days.length, 14);
  assert.equal(siteOf('magnet:?xt=urn:btih:abc'), 'torrent');
});

test('"Install automatically" waits until no download is running', () => {
  const { SelfUpdater } = require('../src/selfupdate');
  const m = { config: { appUpdate: 'auto' }, runners: new Map([['x', {}]]), dataDir: tmpDir() };
  const u = new SelfUpdater(m, { fetchImpl: async () => { throw new Error('offline'); }, firstCheckDelayMs: 1e9 });
  let installs = 0;
  u.install = async () => { installs++; };
  try {
    Object.assign(u.state, { available: true, installed: true });
    assert.equal(u.autoInstallIfIdle(), false, 'a download is running');
    m.runners.clear();
    assert.equal(u.autoInstallIfIdle(), true, 'downloads finished');
    m.config.appUpdate = 'notify';
    assert.equal(u.autoInstallIfIdle(), false, '"Tell me" never installs by itself');
    assert.equal(installs, 1);
  } finally { u.stop(); }
});
