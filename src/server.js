'use strict';
/**
 * Local control server (IDM equivalent: the WebSocket at ws://127.0.0.1:1001 that its
 * browser extension connects to, plus IDMMsgHost.exe native messaging as a fallback).
 *
 * Security model:
 *   - binds to 127.0.0.1 only
 *   - Host header must be 127.0.0.1/localhost (blocks DNS-rebinding attacks)
 *   - every /api call needs the secret token (X-MDM-Token header, or ?token= for SSE)
 *   - /api/pair hands the token only to browser-extension origins (web pages cannot fake Origin)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { info: ytdlpInfo, playlistInfo, isPlaylistUrl, writeCookiesFile } = require('./ytdlp');
const { probe } = require('./probe');
const { cookieHeader } = require('./manager');

const UI_DIR = path.join(__dirname, '..', 'ui');
const UI_FILE = path.join(UI_DIR, 'index.html');
const EXT_ORIGIN = /^(chrome-extension|moz-extension|extension):\/\/[a-z0-9-]+$/i;

/**
 * @param {import('./manager').Manager} manager
 * @param {{ updater?: import('./updater').Updater }} [opts]
 */
function createServer(manager, { updater = null, scheduler = null, selfUpdater = null } = {}) {
  const token = manager.config.token;
  const clients = new Set();
  // Small rolling request log (data/server.log) for troubleshooting the browser extension.
  const logFile = path.join(manager.dataDir, 'server.log');
  const log = (line) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.old');
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch { /* logging must never break the server */ }
  };

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  manager.on('job', (j) => broadcast('job', j));
  manager.on('removed', (id) => broadcast('removed', { id }));
  if (updater) updater.on('status', (s) => broadcast('update', s));
  if (selfUpdater) selfUpdater.on('status', (s) => broadcast('appupdate', s));
  if (scheduler) {
    scheduler.on('status', (s) => broadcast('schedule', s));
    // Jobs added/started/finished change the "N waiting" / "x of y finished" numbers.
    let pending = null;
    const refresh = () => { if (!pending) pending = setTimeout(() => { pending = null; broadcast('schedule', scheduler.status()); }, 300); };
    manager.on('job', (j) => { if (j.status === 'scheduled' || j.scheduleRun) refresh(); });
    manager.on('removed', refresh);
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/events')) {
      res.on('finish', () => log(`${req.method} ${req.url.split('?')[0]} -> ${res.statusCode} ${Date.now() - started}ms origin=${req.headers.origin || '-'}${res.mdmError ? (res.statusCode >= 400 ? ' error=' : ' note=') + res.mdmError : ''}`));
    }
    try {
      const host = (req.headers.host || '').toLowerCase();
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'Bad host' });

      const url = new URL(req.url, 'http://127.0.0.1');
      const origin = req.headers.origin || '';
      const extOrigin = EXT_ORIGIN.test(origin);
      if (extOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-mdm-token');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') return send(res, extOrigin ? 204 : 403);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(UI_FILE, 'utf8').replace('__MDM_TOKEN__', token).replace('__MDM_LANG__', uiLanguage(manager.config.language));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
        return res.end(html);
      }
      if (req.method === 'GET' && (url.pathname === '/dialog.html' || url.pathname === '/float.html')) {
        // dialog.html: "Download File Info" window (own WebView2 window in the app, an iframe in the main page)
        // float.html: small always-on-top window for one download (app window, or picture-in-picture in a browser)
        const html = fs.readFileSync(path.join(UI_DIR, url.pathname.slice(1)), 'utf8').replace('__MDM_TOKEN__', token).replace('__MDM_LANG__', uiLanguage(manager.config.language));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'SAMEORIGIN' });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/i18n.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(path.join(UI_DIR, 'i18n.js')));
      }
      if (req.method === 'GET' && url.pathname === '/logo.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
        return res.end(fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-mark-64.png')));
      }
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(200, { 'content-type': 'image/x-icon', 'cache-control': 'max-age=86400' });
        return res.end(fs.readFileSync(path.join(__dirname, '..', 'assets', 'mdm.ico')));
      }
      if (url.pathname === '/api/ping') return send(res, 200, { ok: true, app: 'mechano-dm' });
      if (url.pathname === '/api/pair') {
        // Chrome often omits Origin on extension service-worker fetches. Those requests carry
        // Sec-Fetch-Site: none, which a web page can never produce (its requests are cross-site).
        const sfs = req.headers['sec-fetch-site'];
        const sfd = req.headers['sec-fetch-dest'];
        const extensionFetch = !origin && sfs === 'none' && sfd === 'empty';
        res.mdmError = `pair origin=${origin || '-'} sec-fetch-site=${sfs || '-'} dest=${sfd || '-'}`;
        if (!extOrigin && !extensionFetch) return send(res, 403, { error: 'Pairing is only available to the browser extension' });
        return send(res, 200, { token });
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      const supplied = req.headers['x-mdm-token'] || url.searchParams.get('token');
      if (supplied !== token) return send(res, 401, { error: 'Missing or wrong token' });
      if (req.method === 'POST' && !/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON only' });

      const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(manager.list())}\n\n`);
        if (updater) res.write(`event: update\ndata: ${JSON.stringify(updater.status())}\n\n`);
        if (scheduler) res.write(`event: schedule\ndata: ${JSON.stringify(scheduler.status())}\n\n`);
        if (selfUpdater) res.write(`event: appupdate\ndata: ${JSON.stringify(selfUpdater.status())}\n\n`);
        clients.add(res);
        log(`window connected (live updates) ua=${String(req.headers['user-agent'] || '').includes('Edg/') ? 'webview/edge' : 'other'}`);
        const ka = setInterval(() => res.write(': keep-alive\n\n'), 20000);
        req.on('close', () => { clearInterval(ka); clients.delete(res); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, manager.list());
      if (req.method === 'GET' && url.pathname === '/api/stats') return send(res, 200, manager.stats.summary());
      if (url.pathname === '/api/host') {
        // Mechano DM.exe says "I'm here" every few seconds: it shows the download/complete popups itself.
        if (req.method === 'POST') manager.hostSeenAt = Date.now();
        return send(res, 200, { native: Date.now() - (manager.hostSeenAt || 0) < 6000 });
      }
      if (req.method === 'POST' && url.pathname === '/api/grab') {
        // Site Grabber: list the files linked from a page (and its sub-pages)
        const b = await readJson(req);
        res.mdmError = 'grab depth=' + (b.depth || 0);
        return send(res, 200, await require('./grabber').grab({ url: b.url, depth: b.depth, categories: b.categories, custom: b.custom, sameSite: b.sameSite, maxPages: b.maxPages }));
      }
      if (req.method === 'POST' && url.pathname === '/api/clipboard') {
        // Mechano DM.exe: "this text was just copied"
        const r = manager.fromClipboard((await readJson(req)).text);
        res.mdmError = r.added ? 'clipboard link added' : 'clipboard ignored: ' + r.reason;
        return send(res, 200, { added: r.added, reason: r.reason || null, id: r.job ? r.job.id : null });
      }
      if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
        // Windows' own "Browse for folder" dialog, opened on top of everything.
        const body = await readJson(req);
        return send(res, 200, { path: await pickFolder(body.start || manager.config.downloadDir) });
      }
      if (url.pathname.startsWith('/api/schedule')) {
        if (!scheduler) return send(res, 501, { error: 'Scheduler not available' });
        const sub = url.pathname.slice('/api/schedule'.length);
        if (req.method === 'GET' && sub === '') return send(res, 200, scheduler.status());
        if (req.method === 'POST' && sub === '') return send(res, 200, scheduler.update(await readJson(req)));
        if (req.method === 'POST' && sub === '/start') { scheduler.startRun('manual'); return send(res, 200, scheduler.status()); }
        if (req.method === 'POST' && sub === '/stop') { scheduler.stopRun('manual'); return send(res, 200, scheduler.status()); }
        if (req.method === 'POST' && sub === '/cancel-action') return send(res, 200, scheduler.cancelAction());
        return send(res, 404, { error: 'Not found' });
      }
      if (url.pathname.startsWith('/api/app-update')) {
        // Mechano DM's own updates (signed releases from GitHub)
        if (!selfUpdater) return send(res, 501, { error: 'App updates are not available' });
        const sub = url.pathname.slice('/api/app-update'.length);
        if (req.method === 'GET' && sub === '') return send(res, 200, selfUpdater.status());
        if (req.method === 'POST' && sub === '/check') return send(res, 200, await selfUpdater.check('manual'));
        if (req.method === 'POST' && sub === '/install') {
          selfUpdater.install().catch(() => { /* reported in the status */ });
          await new Promise((r) => setImmediate(r));
          return send(res, 200, selfUpdater.status());
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (url.pathname === '/api/update') {
        if (!updater) return send(res, 501, { error: 'Updater not available' });
        if (req.method === 'POST') {
          updater.update('manual'); // runs in the background; progress arrives as SSE "update" events
          await new Promise((r) => setImmediate(r));
        }
        return send(res, 200, updater.status());
      }
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        const body = await readJson(req);
        if (!Array.isArray(body)) return send(res, 201, [manager.add(body)]);
        // a list ("Many links", Site Grabber): a bad link is skipped instead of stopping the rest
        const added = [];
        let firstError = null;
        for (const b of body) { try { added.push(manager.add(b)); } catch (e) { firstError = firstError || e; } }
        if (!added.length && firstError) throw firstError;
        return send(res, 201, added);
      }
      if (req.method === 'POST' && parts[1] === 'jobs' && parts[2] && parts[3]) {
        const id = parts[2];
        const action = parts[3];
        if (action === 'pause') return send(res, 200, manager.pause(id));
        if (action === 'resume' || action === 'retry') return send(res, 200, manager.resume(id));
        if (action === 'later') return send(res, 200, await manager.scheduleLater(id));
        if (action === 'move') return send(res, 200, { order: manager.move(id, (await readJson(req)).to) });
        if (action === 'details') return send(res, 200, await manager.details(id));
        if (action === 'entry') {
          const b = await readJson(req);
          return send(res, 200, manager.playlistEntry(id, b.entry, b.action, b.to));
        }
        if (action === 'confirm') return send(res, 200, manager.confirm(id, await readJson(req)));
        if (action === 'exists') return send(res, 200, manager.checkExists(id, await readJson(req)));
        if (action === 'remove') {
          const body = await readJson(req);
          await manager.remove(id, !!body.deleteFiles);
          return send(res, 200, { ok: true });
        }
        if (action === 'play') {
          // Play while downloading: a copy of what is downloaded so far opens in the Windows player
          const job = manager.mustGet(id);
          const file = await require('./preview').makePreview({ job, runner: manager.runners.get(id), dataDir: manager.dataDir, ffmpeg: manager.tools().ffmpeg });
          return send(res, 200, { ok: true, file });
        }
        if (action === 'reveal') {
          const job = manager.mustGet(id);
          if (process.platform === 'win32') revealInExplorer(job);
          return send(res, 200, { ok: true });
        }
        if (action === 'open') {
          // Open a finished file with its Windows app (History → Open, floating window → Open)
          const job = manager.mustGet(id);
          const file = job.file || job.target;
          if (job.status !== 'done' || !file || !fs.existsSync(file)) return send(res, 409, { error: 'The file is not on the disk any more.' });
          if (process.platform === 'win32') {
            if (fs.statSync(file).isDirectory()) revealInExplorer(job);
            else spawn('explorer.exe', [`"${String(file).replace(/"/g, '')}"`], { detached: true, windowsVerbatimArguments: true }).unref();
          }
          return send(res, 200, { ok: true });
        }
        return send(res, 404, { error: 'Unknown action' });
      }
      if (req.method === 'POST' && url.pathname === '/api/info') {
        // Inspect a URL before downloading: formats for media sites, size/name for files.
        const body = await readJson(req);
        try { res.mdmError = 'info ' + new URL(body.url).pathname; } catch { /* invalid URL is reported below */ }
        const kind = body.kind && body.kind !== 'auto' ? body.kind : manager.detectKind(body.url, body.mime);
        if (kind === 'torrent') return send(res, 200, { kind, ...(await require('./torrent').describe(body.url)) });
        if (kind === 'ytdlp') {
          if (manager.updating) return send(res, 503, { error: 'yt-dlp is updating right now. Try again in a minute.' });
          const tools = manager.tools();
          const wantPlaylist = body.playlist === true || (body.playlist !== false && isPlaylistUrl(body.url) && new URL(body.url).pathname === '/playlist');
          if (wantPlaylist) {
            return send(res, 200, { kind, ...(await playlistInfo(body.url, { ytdlp: tools.ytdlp, ffmpeg: tools.ffmpeg })) });
          }
          let cookiesFile = null;
          if (body.cookies?.length) cookiesFile = writeCookiesFile(path.join(manager.dataDir, 'cookies', 'info-' + Date.now() + '.txt'), body.cookies);
          const opts = { ytdlp: tools.ytdlp, ffmpeg: tools.ffmpeg, cookiesFile, referer: body.referrer, userAgent: body.userAgent };
          try {
            let meta;
            try {
              meta = await ytdlpInfo(body.url, opts);
            } catch (err) {
              if (!cookiesFile) throw err;
              // Logged-in pages sometimes can't be parsed (Facebook Reels): retry as a visitor.
              meta = await ytdlpInfo(body.url, { ...opts, cookiesFile: null });
              res.mdmError = 'info ok after retry without cookies';
            }
            return send(res, 200, { kind, ...meta });
          } finally {
            if (cookiesFile) fs.rmSync(cookiesFile, { force: true });
          }
        }
        const headers = {};
        if (body.userAgent) headers['user-agent'] = body.userAgent;
        if (body.referrer) headers.referer = body.referrer;
        const cookie = cookieHeader(body.cookies, body.url);
        if (cookie) headers.cookie = cookie;
        const p = await probe(body.url, { headers });
        return send(res, 200, { kind, ...p });
      }
      if (url.pathname === '/api/config') {
        if (req.method === 'GET') return send(res, 200, { ...manager.publicConfig(), tools: manager.tools() });
        if (req.method === 'POST') return send(res, 200, manager.updateConfig(await readJson(req)));
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      res.mdmError = String(err.message || err).replace(/\s+/g, ' ').slice(0, 300);
      send(res, err.status || 400, { error: err.message || String(err) });
    }
  });

  return server;
}

/** Interface language: 'en' / 'ar'; "auto" follows Windows (the page falls back to the browser language). */
/**
 * Show a download in Explorer. Explorer needs `/select,"C:\path with spaces\file"`: Node's own quoting
 * wraps the whole `/select,...` argument in quotes, which Explorer doesn't understand, so it opened Documents.
 * Unfinished or moved files: open the folder instead.
 */
function revealInExplorer(job) {
  const target = job.file || job.target;
  const open = (args) => spawn('explorer.exe', [args], { detached: true, windowsHide: false, windowsVerbatimArguments: true }).unref();
  const quote = (p) => `"${String(p).replace(/"/g, '')}"`; // Windows paths can't contain quotes
  try {
    if (target && fs.existsSync(target)) {
      if (fs.statSync(target).isDirectory()) return open(quote(target)); // playlist / torrent folder
      return open(`/select,${quote(target)}`);
    }
  } catch { /* fall through to the folder */ }
  const dir = target ? path.dirname(target) : job.dir;
  if (dir && fs.existsSync(dir)) open(quote(dir));
  else if (job.dir && fs.existsSync(job.dir)) open(quote(job.dir));
}

function uiLanguage(setting) {
  if (setting === 'ar' || setting === 'en') return setting;
  try { if (/^ar\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale)) return 'ar'; } catch { /* no Intl data */ }
  return 'auto';
}

/** Shows the Windows folder picker and resolves with the chosen folder, or null if cancelled. */
function pickFolder(start) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$f.Description = 'Choose where to save this download'",
    '$f.ShowNewFolderButton = $true',
    'if ($env:MDM_START -and (Test-Path $env:MDM_START)) { $f.SelectedPath = $env:MDM_START }',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0 }',
    '$owner.Show(); $owner.Activate()',
    "if ($f.ShowDialog($owner) -eq 'OK') { Write-Output $f.SelectedPath }",
    '$owner.Close()',
  ].join('; ');
  return new Promise((resolve) => {
    // The start folder goes in an environment variable, never inside the script text.
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script],
      { windowsHide: true, env: { ...process.env, MDM_START: String(start || '') } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(out.trim().split(/\r?\n/).pop() || null));
  });
}

function send(res, status, body) {
  if (res.headersSent) return res.end();
  if (body === undefined) { res.writeHead(status); return res.end(); }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 2 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = { createServer };
