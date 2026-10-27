#!/usr/bin/env node
'use strict';
/**
 * Mechano Download Manager CLI
 *
 *   node bin/mdm.js serve                       start the app (web UI + browser-extension API)
 *   node bin/mdm.js get <url> [options]         download one URL in the terminal
 *   node bin/mdm.js info <url>                  show size/name, or formats for YouTube etc.
 *   node bin/mdm.js update                      update yt-dlp now (the app also does it every 5 days)
 *
 * get options:
 *   -c, --connections N   parallel connections (default 8)
 *   -o, --out DIR         output folder (default: current folder)
 *   -n, --name FILE       output file name
 *   -k, --kind KIND       auto | direct | hls | ytdlp
 *   -f, --format F        yt-dlp format (e.g. "bv*[height<=1080]+ba/b")
 *   -q, --quality H       max video height for YouTube/social/HLS (e.g. 1080, 720)
 *   --audio               audio only (saved as mp3 when ffmpeg is installed)
 *   --playlist            download the whole YouTube playlist (into a folder named after it)
 *   --referer URL         send a Referer header
 *   --limit KBps          speed limit
 */
const path = require('node:path');
const { Manager } = require('../src/manager');
const { createServer } = require('../src/server');
const { Updater } = require('../src/updater');
const { Scheduler } = require('../src/scheduler');
const { SelfUpdater } = require('../src/selfupdate');
const { SegmentedDownload } = require('../src/segmented');
const { HlsDownload } = require('../src/hls');
const { YtdlpDownload, info: ytInfo } = require('../src/ytdlp');
const { RateLimiter } = require('../src/limiter');
const { probe } = require('../src/probe');
const { formatBytes } = require('../src/util');

const DATA_DIR = process.env.MDM_DATA || path.join(__dirname, '..', 'data');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    if (t === '-c' || t === '--connections') a.connections = Number(next());
    else if (t === '-o' || t === '--out') a.out = next();
    else if (t === '-n' || t === '--name') a.name = next();
    else if (t === '-k' || t === '--kind') a.kind = next();
    else if (t === '-f' || t === '--format') a.format = next();
    else if (t === '-q' || t === '--quality') a.quality = Number(next());
    else if (t === '--audio') a.audio = true;
    else if (t === '--playlist') a.playlist = true;
    else if (t === '--referer') a.referer = next();
    else if (t === '--limit') a.limit = Number(next());
    else if (t === '--port') a.port = Number(next());
    else a._.push(t);
  }
  return a;
}

function bar(p) {
  const pct = p.size ? Math.min(100, (p.downloaded / p.size) * 100) : null;
  const width = 30;
  const filled = pct == null ? 0 : Math.round((pct / 100) * width);
  const eta = p.eta != null ? ` ETA ${p.eta}s` : '';
  const conns = p.connections ? ` [${p.connections} conn]` : '';
  return `\r[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${pct == null ? '  ?' : pct.toFixed(1).padStart(5)}%  ${formatBytes(p.downloaded)} / ${formatBytes(p.size)}  ${formatBytes(p.speed)}/s${eta}${conns}   `;
}

async function cmdGet(a) {
  const url = a._[1];
  if (!url) throw new Error('Usage: mdm get <url>');
  const m = new Manager(DATA_DIR);
  clearInterval(m.scheduler);
  const kind = a.kind && a.kind !== 'auto' ? a.kind : m.detectKind(url);
  const tools = m.tools();
  const dir = path.resolve(a.out || '.');
  const headers = a.referer ? { referer: a.referer } : {};
  const limiter = new RateLimiter((a.limit || 0) * 1024);
  let d;
  if (kind === 'hls') d = new HlsDownload({ url, dir, filename: a.name, headers, concurrency: a.connections || 6, maxHeight: a.quality, ffmpeg: tools.ffmpeg, limiter });
  else if (kind === 'ytdlp') d = new YtdlpDownload({ url, dir, ytdlp: tools.ytdlp, ffmpeg: tools.ffmpeg, format: a.format, maxHeight: a.quality, audioOnly: a.audio, playlist: !!a.playlist, referer: a.referer, rateLimit: (a.limit || 0) * 1024 });  else d = new SegmentedDownload({ url, dir, filename: a.name, headers, connections: a.connections || 8, limiter });

  console.log(`Mode: ${kind}`);
  d.on('meta', (x) => x.target && console.log(`Saving to: ${x.target}${x.size ? ` (${formatBytes(x.size)}, ${x.resumable ? 'resumable' : 'not resumable'})` : ''}`));
  d.on('progress', (p) => process.stdout.write(bar(p)));
  d.on('log', (l) => process.stdout.write(`\n${l}\n`));
  process.on('SIGINT', () => { process.stdout.write('\nPausing... run the same command again to resume.\n'); d.pause(); });
  const r = await d.start();
  if (r.paused) { console.log('\nPaused.'); return; }
  console.log(`\nDone: ${r.file}`);
}

async function cmdInfo(a) {
  const url = a._[1];
  if (!url) throw new Error('Usage: mdm info <url>');
  const m = new Manager(DATA_DIR);
  clearInterval(m.scheduler);
  const kind = a.kind && a.kind !== 'auto' ? a.kind : m.detectKind(url);
  if (kind === 'ytdlp') {
    const t = m.tools();
    const i = await ytInfo(url, { ytdlp: t.ytdlp, ffmpeg: t.ffmpeg });
    console.log(`${i.title}  [${i.extractor}]  ${i.duration ? Math.round(i.duration) + 's' : ''}`);
    for (const f of i.formats) {
      const v = !f.vcodec ? (f.height ? `${f.height}p ?` : '?') : f.vcodec !== 'none' ? `${f.height || '?'}p${f.fps ? f.fps : ''} ${f.vcodec}` : 'audio only';
      const au = !f.acodec ? '?' : f.acodec !== 'none' ? f.acodec : 'no audio';
      console.log(`  ${String(f.id).padEnd(10)} ${String(f.ext).padEnd(5)} ${v.padEnd(24)} ${au.padEnd(14)} ${formatBytes(f.size)}`);
    }
  } else {
    const p = await probe(url);
    console.log(JSON.stringify({ kind, ...p }, null, 2));
  }
  process.exit(0);
}

function cmdServe(a) {
  const m = new Manager(DATA_DIR);
  if (a.port) m.config.port = a.port;
  const updater = new Updater(m); // keeps yt-dlp current (every autoUpdateDays, default 5)
  const scheduler = new Scheduler(m); // "Later" downloads + after-finish action
  const selfUpdater = new SelfUpdater(m); // new versions of Mechano DM (signed; Settings -> App updates)
  const server = createServer(m, { updater, scheduler, selfUpdater });
  server.listen(m.config.port, '127.0.0.1', () => {
    const t = m.tools();
    console.log(`Mechano Download Manager running at http://127.0.0.1:${m.config.port}/`);
    console.log(`Download folder: ${m.config.downloadDir}`);
    console.log(`yt-dlp: ${t.ytdlp || 'NOT FOUND (YouTube/social sites disabled)'}`);
    console.log(`ffmpeg: ${t.ffmpeg || 'NOT FOUND (no audio+video merging)'}`);
    console.log('Load the extension from the "extension" folder; it pairs automatically.');
  });
  const stop = () => { updater.stop(); scheduler.stop(); selfUpdater.stop(); m.shutdown(); server.close(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdUpdate() {
  const m = new Manager(DATA_DIR);
  clearInterval(m.scheduler);
  const u = new Updater(m, { firstCheckDelayMs: 1e9, checkEveryMs: 1e9 });
  u.stop();
  console.log(`Updating yt-dlp (currently ${u.state.version || 'not found'})...`);
  const s = await u.update('manual');
  console.log(s.lastResult ? s.lastResult.message : 'Done');
  process.exit(s.lastResult && s.lastResult.ok ? 0 : 1);
}

const a = parseArgs(process.argv.slice(2));
const cmd = a._[0] || 'serve';
const commands = { serve: cmdServe, get: cmdGet, info: cmdInfo, update: cmdUpdate };
Promise.resolve()
  .then(() => (commands[cmd] ? commands[cmd](a) : Promise.reject(new Error(`Unknown command ${cmd}`))))
  .catch((e) => { console.error(`\nError: ${e.message}`); process.exit(1); });
