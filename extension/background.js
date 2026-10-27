// Mechano DM browser integration (Manifest V3 service worker).
//
// What IDM's extension does, and how this one mirrors it:
//  - Talks to the desktop app over localhost (IDM: ws://127.0.0.1:1001 + native messaging fallback;
//    here: HTTP to 127.0.0.1:9614 with a paired token).
//  - Takes over browser downloads whose extension is in a list (IDM pauses the download in
//    downloads.onCreated and decides in onDeterminingFilename; we decide in onDeterminingFilename).
//  - Forwards cookies, referrer and User-Agent so the app can re-request protected files.
//  - Sniffs media responses (webRequest.onHeadersReceived content-type: m3u8, mpd, video/*, audio/*)
//    to offer "download this video", like IDM's download panel.
//  - Context menu: "Download with ...", link / media / whole page.

const DEFAULTS = {
  port: 9614,
  intercept: true,
  exts: 'zip rar 7z gz tar iso exe msi apk dmg pdf mp4 mkv avi mov webm mp3 m4a flac wav doc docx xls xlsx ppt pptx rvt rfa dwg ifc',
  minSizeKB: 0,
};
const MEDIA_SITES = /(^|\.)(youtube\.com|youtu\.be|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com|dailymotion\.com|reddit\.com|twitch\.tv|soundcloud\.com|linkedin\.com|threads\.(net|com))$/i;

async function cfg() { return { ...DEFAULTS, ...(await chrome.storage.local.get(null)) }; }
const base = (c) => `http://127.0.0.1:${c.port}`;

async function pair(c) {
  const r = await fetch(`${base(c)}/api/pair`);
  if (!r.ok) throw new Error(`Mechano DM refused pairing (HTTP ${r.status})`);
  const { token } = await r.json();
  await chrome.storage.local.set({ token });
  return token;
}

async function api(path, body) {
  const c = await cfg();
  let token = c.token || (await pair(c));
  const call = (t) => fetch(`${base(c)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-mdm-token': t },
    body: body ? JSON.stringify(body) : undefined,
  });
  let r = await call(token);
  if (r.status === 401) { token = await pair(c); r = await call(token); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function appAlive() {
  const c = await cfg();
  try {
    const r = await fetch(`${base(c)}/api/ping`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch { return false; }
}

async function cookiesFor(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map(({ name, value, domain, path, secure, hostOnly, expirationDate }) => ({ name, value, domain, path, secure, hostOnly, expirationDate }));
  } catch { return []; }
}

/** Send a URL to the app. pageUrl is used for cookies of media sites (yt-dlp). */
async function sendToApp(url, { referrer, pageUrl, kind, filename, mime, maxHeight, audioOnly, playlist, format } = {}) {
  // For media sites, cookies of the video URL's own site (lets yt-dlp see private / logged-in videos).
  const cookies = await cookiesFor(url);
  return api('/api/jobs', {
    url, kind: kind || 'auto', referrer: referrer || pageUrl || null, filename, mime, cookies,
    userAgent: navigator.userAgent, maxHeight: maxHeight || null, audioOnly: !!audioOnly, playlist: !!playlist,
    format: typeof format === 'string' && /^[\w.-]{1,40}$/.test(format) ? format : undefined,
  });
}

/** Title + number of videos of a YouTube playlist (fast, nothing downloaded). */
async function playlistInfo(url) {
  const hit = optionsCache.get('pl:' + url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.data;
  const info = await api('/api/info', { url, kind: 'ytdlp', playlist: true });
  const data = { title: info.title, count: info.count, duration: info.duration };
  optionsCache.set('pl:' + url, { at: Date.now(), data });
  return data;
}

// Quality list for the floating button: one row per resolution with an estimated size.
const optionsCache = new Map();
const optionsInFlight = new Map(); // the button asks early (prefetch) and again on click: one yt-dlp run for both
function videoOptions(url) {
  const hit = optionsCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return Promise.resolve(hit.data);
  if (!optionsInFlight.has(url)) {
    optionsInFlight.set(url, readVideoOptions(url).finally(() => optionsInFlight.delete(url)));
  }
  return optionsInFlight.get(url);
}
async function readVideoOptions(url) {
  const cookies = await cookiesFor(url);
  const info = await api('/api/info', { url, kind: 'ytdlp', cookies, userAgent: navigator.userAgent });
  const formats = info.formats || [];
  const audios = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const audio = audios.filter((f) => /m4a|mp4/.test(f.ext || '')).sort((a, b) => (b.size || 0) - (a.size || 0))[0] ||
    audios.sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;
  // One row per resolution, keyed by the SHORT side (a 720x1280 portrait reel is "720p"),
  // which is also how the app picks quality (yt-dlp "res").
  const byRes = new Map();
  for (const f of formats) {
    if (!f.height || f.vcodec === 'none' || /storyboard/.test(f.note || '')) continue;
    const p = f.width ? Math.min(f.width, f.height) : f.height;
    const h264 = /avc|h264/i.test(f.vcodec || '');
    const muxed = !!(f.acodec && f.acodec !== 'none');
    const prev = byRes.get(p);
    // Size shown = what will actually be downloaded: H.264 when available (the app's default), plus audio.
    if (!prev || (h264 && !prev.h264) || (h264 === prev.h264 && (f.size || 0) > (prev.size || 0))) {
      byRes.set(p, { p, fps: f.fps, size: f.size, h264, muxed, id: f.id, probed: !!f.probed });
    }
  }
  const options = [...byRes.values()].sort((a, b) => b.p - a.p).slice(0, 8).map((o) => {
    const label = `${o.p >= 2160 ? '4K · ' : o.p >= 1440 ? '2K · ' : o.p >= 720 ? 'HD · ' : ''}${o.p}p${o.fps > 30 ? ' ' + Math.round(o.fps) + 'fps' : ''}`;
    const size = o.size ? o.size + (o.muxed || !audio ? 0 : audio.size || 0) : null;
    // Facebook's sd/hd files have no height for yt-dlp, so "res:360" can't find them: ask for them by id.
    return { label, maxHeight: o.p, size, format: o.probed && /^[\w.-]{1,40}$/.test(o.id) ? o.id : undefined };
  });
  const data = { title: info.title, site: info.extractor, options, audio: audio ? { size: audio.size } : null };
  optionsCache.set(url, { at: Date.now(), data });
  if (optionsCache.size > 50) optionsCache.delete(optionsCache.keys().next().value);
  return data;
}

function notifyBadge(tabId, text, color = '#1f6feb') {
  if (tabId == null || tabId < 0) return;
  chrome.action.setBadgeBackgroundColor({ color, tabId }).catch(() => {});
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
}

// ---------------------------------------------------------------- download takeover
if (chrome.downloads.onDeterminingFilename) {
  // Chrome / Edge: decide before the file name is chosen (nothing is written yet)
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    takeOver(item).then((taken) => { if (!taken) suggest(); }).catch(() => suggest());
    return true; // we answer asynchronously
  });
} else {
  // Firefox has no onDeterminingFilename: decide as soon as the download starts
  chrome.downloads.onCreated.addListener((item) => {
    const url = item.finalUrl || item.url || '';
    let name = item.filename || '';
    if (!name) { try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch {} }
    takeOver({ ...item, filename: name }).catch(() => {});
  });
}

async function takeOver(item) {
  const c = await cfg();
  if (!c.intercept || item.byExtensionId === chrome.runtime.id) return false;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return false; // blob:, data:, file: stay in the browser
  const ext = (item.filename.split('.').pop() || '').toLowerCase();
  const list = c.exts.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!list.includes(ext)) return false;
  if (c.minSizeKB && item.totalBytes > 0 && item.totalBytes < c.minSizeKB * 1024) return false;
  if (!(await appAlive())) return false; // app not running: let the browser download it
  await chrome.downloads.cancel(item.id).catch(() => {});
  chrome.downloads.erase({ id: item.id }).catch(() => {});
  const name = item.filename.split(/[\\/]/).pop();
  await sendToApp(url, { referrer: item.referrer, filename: name, mime: item.mime });
  return true;
}

// ---------------------------------------------------------------- media sniffing
const SEGMENT_URL = /(\.ts|\.m4s|\.aac|\.vtt)(\?|$)|[?&](range|bytestart)=|\/seg-?\d+|\/chunk|\/fragment/i;

function classify(url, type, length) {
  if (/mpegurl/i.test(type) || /\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/dash\+xml/i.test(type) || /\.mpd(\?|$)/i.test(url)) return 'dash';
  if (/^(video|audio)\//i.test(type) && !/mp2t/i.test(type)) {
    if (SEGMENT_URL.test(url)) return null;
    if (length && length < 512 * 1024) return null; // tiny pieces are usually segments or previews
    return 'file';
  }
  return null;
}

chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  if (/googlevideo\.com\/videoplayback/.test(d.url)) return; // YouTube chunks; the page itself goes to yt-dlp
  const h = Object.fromEntries((d.responseHeaders || []).map((x) => [x.name.toLowerCase(), x.value || '']));
  const type = (h['content-type'] || '').split(';')[0].trim();
  const length = Number((h['content-range'] || '').split('/')[1]) || Number(h['content-length']) || null;
  const kind = classify(d.url, type, length);
  if (!kind) return;
  remember(d.tabId, { url: d.url, kind, type, size: kind === 'file' ? length : null, at: Date.now() });
}, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] }, ['responseHeaders']);

async function remember(tabId, media) {
  const key = `media:${tabId}`;
  const store = (await chrome.storage.session.get(key))[key] || [];
  if (store.some((m) => m.url === media.url)) return;
  store.push(media);
  if (store.length > 40) store.shift();
  await chrome.storage.session.set({ [key]: store });
  notifyBadge(tabId, String(store.length));
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) { chrome.storage.session.remove(`media:${tabId}`); notifyBadge(tabId, ''); }
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(`media:${tabId}`));

// ---------------------------------------------------------------- context menus
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'mdm-link', title: 'Download link with Mechano DM', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'mdm-media', title: 'Download this media with Mechano DM', contexts: ['video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'mdm-page', title: 'Download video on this page (yt-dlp)', contexts: ['page', 'frame'] });
  });
  const c = await cfg();
  pair(c).catch(() => {}); // pair now if the app is already running
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'mdm-link') await sendToApp(info.linkUrl, { referrer: info.pageUrl, pageUrl: info.pageUrl });
    else if (info.menuItemId === 'mdm-media') {
      const src = info.srcUrl;
      if (!src || src.startsWith('blob:')) await sendToApp(info.pageUrl, { kind: 'ytdlp', pageUrl: info.pageUrl }); // MSE player: use the page
      else await sendToApp(src, { referrer: info.pageUrl, pageUrl: info.pageUrl });
    } else if (info.menuItemId === 'mdm-page') {
      await sendToApp(info.frameUrl || info.pageUrl, { kind: 'ytdlp', pageUrl: info.pageUrl });
    }
    notifyBadge(tab?.id, '✓', '#1a7f37');
  } catch (e) {
    notifyBadge(tab?.id, '!', '#c62828');
    console.warn('Mechano DM:', e.message);
  }
});

// ---------------------------------------------------------------- popup messages
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.type === 'status') {
      const alive = await appAlive();
      const c = await cfg();
      const key = `media:${msg.tabId}`;
      const media = (await chrome.storage.session.get(key))[key] || [];
      let mediaSite = false;
      try { mediaSite = MEDIA_SITES.test(new URL(msg.tabUrl).hostname); } catch {}
      return { alive, media, mediaSite, intercept: c.intercept, port: c.port, exts: c.exts };
    }
    if (msg.type === 'send') {
      const kind = msg.kind === 'dash' ? 'ytdlp' : msg.kind === 'file' ? 'direct' : msg.kind;
      return sendToApp(msg.url, { kind, pageUrl: msg.pageUrl, referrer: msg.referrer || msg.pageUrl, maxHeight: msg.maxHeight, audioOnly: msg.audioOnly, playlist: msg.playlist, format: msg.format });
    }
    if (msg.type === 'video-options') return videoOptions(msg.url);
    if (msg.type === 'playlist-info') return playlistInfo(msg.url);
    if (msg.type === 'tab-media') {
      const key = `media:${sender.tab?.id}`;
      return (await chrome.storage.session.get(key))[key] || [];
    }
    if (msg.type === 'settings') {
      await chrome.storage.local.set(msg.settings);
      if ('port' in msg.settings) await chrome.storage.local.remove('token');
      return { ok: true };
    }
    return null;
  })().then((r) => reply({ ok: true, data: r }), (e) => reply({ ok: false, error: e.message }));
  return true;
});
