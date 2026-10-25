'use strict';
// Offline tests: every server here is local, so nothing is fetched from the internet.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SegmentedDownload } = require('../src/segmented');
const { HlsDownload, parseM3U8 } = require('../src/hls');
const { Manager, cookieHeader } = require('../src/manager');
const { createServer } = require('../src/server');
const { RateLimiter } = require('../src/limiter');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

/** A file server that behaves like a CDN: optional ranges, throttling, transient 503s. */
function fileServer(data, { ranges = true, etag = '"v1"', delay = 0, chunk = 64 * 1024, fail503 = 0, name = 'file.bin' } = {}) {
  const stats = { requests: 0, ranged: 0, bytes: 0, maxParallel: 0, open: 0 };
  let fails = fail503;
  const srv = http.createServer(async (req, res) => {
    stats.requests++;
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (m && ranges && fails > 0 && Number(m[1]) > 0) { fails--; res.writeHead(503); return res.end(); }
    let start = 0;
    let end = data.length - 1;
    let status = 200;
    const headers = { 'content-type': 'application/octet-stream', etag, 'content-disposition': `attachment; filename="${name}"` };
    if (ranges) headers['accept-ranges'] = 'bytes';
    if (m && ranges) {
      stats.ranged++;
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${data.length}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(status, headers);
    stats.open++;
    stats.maxParallel = Math.max(stats.maxParallel, stats.open);
    try {
      for (let p = start; p <= end; p += chunk) {
        if (res.destroyed) return;
        const piece = data.subarray(p, Math.min(end + 1, p + chunk));
        stats.bytes += piece.length;
        await new Promise((r) => res.write(piece, r));
        if (delay) await sleep(delay);
      }
      res.end();
    } finally { stats.open--; }
  });
  return { srv, stats };
}

test('multi-connection segmented download produces an identical file', async () => {
  const data = crypto.randomBytes(6 * 1024 * 1024 + 123);
  const { srv, stats } = fileServer(data, { delay: 2 });
  const base = await listen(srv);
  const dir = tmpDir();
  try {
    const d = new SegmentedDownload({ url: `${base}/x`, dir, connections: 8 });
    const r = await d.start();
    assert.equal(path.basename(r.file), 'file.bin');
    assert.equal(sha(fs.readFileSync(r.file)), sha(data));
    assert.ok(stats.maxParallel >= 4, `expected parallel connections, saw ${stats.maxParallel}`);
    assert.ok(!fs.existsSync(r.file + '.mdmpart') && !fs.existsSync(r.file + '.mdmpart.json'), 'temp files removed');
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('pause and resume continues from the saved byte instead of restarting', async () => {
  const data = crypto.randomBytes(4 * 1024 * 1024);
  const { srv, stats } = fileServer(data, { delay: 40, chunk: 16 * 1024 }); // ~1.6 MB/s total: slow enough to pause
  const base = await listen(srv);
  const dir = tmpDir();
  try {
    const d1 = new SegmentedDownload({ url: `${base}/x`, dir, connections: 4 });
    const p1 = d1.start();
    await sleep(700);
    d1.pause();
    const r1 = await p1;
    assert.equal(r1.paused, true);
    const target = d1.target;
    const state = JSON.parse(fs.readFileSync(target + '.mdmpart.json', 'utf8'));
    const doneBefore = state.segments.reduce((s, x) => s + (Math.min(x.pos, x.end + 1) - x.start), 0);
    assert.ok(doneBefore > 0 && doneBefore < data.length, `partial progress expected, got ${doneBefore}`);

    const servedBefore = stats.bytes;
    const d2 = new SegmentedDownload({ url: `${base}/x`, dir }); // no target: must find the unfinished file itself
    const r2 = await d2.start();
    assert.equal(r2.file, target);
    assert.equal(sha(fs.readFileSync(r2.file)), sha(data));
    const servedAfter = stats.bytes - servedBefore;
    assert.ok(servedAfter < data.length - doneBefore * 0.5, `resume should not re-download everything (served ${servedAfter})`);
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('server without range support falls back to one connection', async () => {
  const data = crypto.randomBytes(1024 * 1024 + 7);
  const { srv, stats } = fileServer(data, { ranges: false });
  const base = await listen(srv);
  const dir = tmpDir();
  try {
    const d = new SegmentedDownload({ url: `${base}/x`, dir, connections: 8 });
    const r = await d.start();
    assert.equal(sha(fs.readFileSync(r.file)), sha(data));
    assert.equal(stats.requests, 2, 'one probe + exactly one download connection');
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('transient 503 errors are retried and the connection count backs off', async () => {
  const data = crypto.randomBytes(3 * 1024 * 1024);
  const { srv } = fileServer(data, { fail503: 3, delay: 1 });
  const base = await listen(srv);
  const dir = tmpDir();
  try {
    const d = new SegmentedDownload({ url: `${base}/x`, dir, connections: 6 });
    const logs = [];
    d.on('log', (l) => logs.push(l));
    const r = await d.start();
    assert.equal(sha(fs.readFileSync(r.file)), sha(data));
    assert.ok(logs.some((l) => /throttling/.test(l)), 'expected a back-off log line');
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('speed limiter caps throughput', async () => {
  const data = crypto.randomBytes(600 * 1024);
  const { srv } = fileServer(data);
  const base = await listen(srv);
  const dir = tmpDir();
  try {
    const t0 = Date.now();
    const d = new SegmentedDownload({ url: `${base}/x`, dir, connections: 4, limiter: new RateLimiter(400 * 1024) });
    await d.start();
    const secs = (Date.now() - t0) / 1000;
    assert.ok(secs >= 1.0, `600 KB at 400 KB/s should take >= ~1.2 s, took ${secs}`);
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('HLS: picks best variant, decrypts AES-128, joins segments in order', async () => {
  const key = crypto.randomBytes(16);
  const explicitIv = crypto.randomBytes(16);
  const plain = [0, 1, 2, 3].map(() => crypto.randomBytes(50_000 + Math.floor(Math.random() * 1000)));
  const enc = (buf, iv) => { const c = crypto.createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([c.update(buf), c.final()]); };
  const seqIv = (n) => { const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(n), 8); return b; };
  const files = {
    '/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhi/index.m3u8\n',
    '/low/index.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nwrong.ts\n#EXT-X-ENDLIST\n',
    '/hi/index.m3u8': [
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXTINF:4,', 's0.ts',
      `#EXT-X-KEY:METHOD=AES-128,URI="/key.bin",IV=0x${explicitIv.toString('hex')}`,
      '#EXTINF:4,', 's1.ts', '#EXTINF:4,', 's2.ts',
      '#EXT-X-KEY:METHOD=AES-128,URI="/key.bin"',
      '#EXTINF:4,', 's3.ts', '#EXT-X-ENDLIST', '',
    ].join('\n'),
    '/key.bin': key,
    '/hi/s0.ts': plain[0],
    '/hi/s1.ts': enc(plain[1], explicitIv),
    '/hi/s2.ts': enc(plain[2], explicitIv),
    '/hi/s3.ts': enc(plain[3], seqIv(13)),
  };
  const srv = http.createServer((req, res) => {
    const body = files[new URL(req.url, 'http://x').pathname];
    if (!body) { res.writeHead(404); return res.end(); }
    res.writeHead(200);
    res.end(body);
  });
  const base = await listen(srv);
  const dir = tmpDir();
  try {
    const d = new HlsDownload({ url: `${base}/master.m3u8`, dir, filename: 'clip', ffmpeg: null });
    const r = await d.start();
    assert.equal(path.basename(r.file), 'clip.ts');
    assert.equal(sha(fs.readFileSync(r.file)), sha(Buffer.concat(plain)));
    assert.ok(!fs.existsSync(r.file + '.mdmhls'), 'work folder removed');
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('HLS: DRM-protected streams are refused', async () => {
  const files = { '/drm.m3u8': '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n' };
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end(files[req.url] || ''); });
  const base = await listen(srv);
  try {
    const d = new HlsDownload({ url: `${base}/drm.m3u8`, dir: tmpDir() });
    await assert.rejects(d.start(), /DRM/);
  } finally { srv.close(); srv.closeAllConnections(); }
});

test('M3U8 parser handles byte ranges and fMP4 init maps', () => {
  const pl = parseM3U8('#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="700@0"\n#EXT-X-BYTERANGE:1000@700\n#EXTINF:2,\nmedia.mp4\n#EXT-X-BYTERANGE:500\n#EXTINF:2,\nmedia.mp4\n#EXT-X-ENDLIST', 'https://cdn.test/v/index.m3u8');
  assert.equal(pl.segments.length, 2);
  assert.deepEqual(pl.segments[0].range, { start: 700, end: 1699 });
  assert.deepEqual(pl.segments[1].range, { start: 1700, end: 2199 });
  assert.equal(pl.segments[0].map.uri, 'https://cdn.test/v/init.mp4');
  assert.equal(pl.endList, true);
});

test('cookie header only includes cookies that match the URL', () => {
  const cookies = [
    { name: 'a', value: '1', domain: '.example.com', path: '/', secure: false, hostOnly: false },
    { name: 'b', value: '2', domain: 'other.com', path: '/', secure: false, hostOnly: true },
    { name: 'c', value: '3', domain: 'files.example.com', path: '/private', secure: true, hostOnly: true },
  ];
  assert.equal(cookieHeader(cookies, 'https://files.example.com/private/x.zip'), 'a=1; c=3');
  assert.equal(cookieHeader(cookies, 'http://files.example.com/private/x.zip'), 'a=1');
});

test('new downloads wait for approval: details show name, size and category folder; folder can be changed', async () => {
  const data = crypto.randomBytes(300 * 1024);
  const { srv } = fileServer(data, { name: 'Site-Model.zip' });
  const base = await listen(srv);
  const dataDir = tmpDir();
  const m = new Manager(dataDir);
  m.updateConfig({ downloadDir: path.join(dataDir, 'M.DM') });
  try {
    for (const c of ['Video', 'Music', 'Compressed', 'Documents', 'Programs', 'Images', 'General']) {
      assert.ok(fs.existsSync(path.join(dataDir, 'M.DM', c)), `category folder ${c} exists`);
    }
    const job = m.add({ url: `${base}/get` });
    assert.equal(m.get(job.id).status, 'confirm', 'does not start before you approve it');
    const d = await m.details(job.id);
    assert.equal(d.name, 'Site-Model.zip');
    assert.equal(d.size, data.length);
    assert.equal(d.folder, path.join(dataDir, 'M.DM', 'Compressed'), '.zip goes to Compressed');

    const custom = path.join(dataDir, 'My projects', 'Tower A');
    const done = new Promise((resolve) => m.on('job', (j) => j.id === job.id && (j.status === 'done' || j.status === 'error') && resolve(j)));
    m.confirm(job.id, { dir: custom });
    const j = await done;
    assert.equal(j.status, 'done', j.error);
    assert.equal(path.dirname(j.file), custom, 'saved in the folder chosen in the popup');

    const later = m.add({ url: `${base}/get2` });
    m.confirm(later.id, { later: true });
    assert.equal(m.get(later.id).status, 'scheduled', '"Later" puts it in the scheduler');
    assert.throws(() => { const x = m.add({ url: `${base}/x` }); m.confirm(x.id, { dir: 'relative\\folder' }); }, /full folder path/);
  } finally { m.shutdown(); srv.close(); srv.closeAllConnections(); }
});

test('local API: token, host and pairing checks; job runs end to end', async () => {
  const data = crypto.randomBytes(2 * 1024 * 1024);
  const { srv: files } = fileServer(data, { name: 'report.pdf' });
  const fileBase = await listen(files);
  const dataDir = tmpDir();
  const m = new Manager(dataDir);
  m.updateConfig({ downloadDir: path.join(dataDir, 'downloads'), confirmDownloads: false });
  const app = createServer(m);
  const base = await listen(app);
  const token = m.config.token;
  try {
    assert.equal((await fetch(`${base}/api/jobs`)).status, 401, 'no token');
    assert.equal((await fetch(`${base}/api/jobs`, { headers: { 'x-mdm-token': 'nope' } })).status, 401, 'wrong token');
    const rebind = await new Promise((resolve) => {
      http.get(`${base}/api/jobs`, { headers: { host: 'evil.example:80', 'x-mdm-token': token } }, (r) => { r.resume(); resolve(r.statusCode); });
    });
    assert.equal(rebind, 403, 'DNS-rebinding host rejected');
    assert.equal((await fetch(`${base}/api/pair`)).status, 403, 'web pages cannot pair');
    const paired = await fetch(`${base}/api/pair`, { headers: { origin: 'chrome-extension://abcdefghijklmnop' } });
    assert.equal((await paired.json()).token, token);

    const done = new Promise((resolve) => m.on('job', (j) => (j.status === 'done' || j.status === 'error') && resolve(j)));
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-mdm-token': token },
      body: JSON.stringify({ url: `${fileBase}/dl?id=1`, cookies: [{ name: 's', value: 'x', domain: '127.0.0.1', path: '/', hostOnly: true }] }),
    });
    assert.equal(created.status, 201);
    const j = await done;
    assert.equal(j.status, 'done', j.error);
    assert.equal(path.basename(path.dirname(j.file)), 'Documents', 'sorted into a category folder');
    assert.equal(sha(fs.readFileSync(j.file)), sha(data));
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs.json'), 'utf8'));
    assert.equal(saved[0].cookies, null, 'cookies are dropped once the job is finished');
  } finally {
    m.shutdown();
    app.close(); app.closeAllConnections();
    files.close(); files.closeAllConnections();
  }
});
