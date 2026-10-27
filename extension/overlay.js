// Floating "Download" button over videos (like IDM's "Download this video" panel).
// Runs in every page and frame. Finds the largest visible <video>, pins a button to its
// top-right corner, and on click shows the available qualities from Mechano DM.
// Built only with DOM APIs (no innerHTML) so it also works on Trusted-Types sites like YouTube.
(() => {
  if (window.__mdmOverlay) return;
  window.__mdmOverlay = true;
  if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return;

  const MIN_W = 200;
  const MIN_H = 110;
  const ask = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        resolve(r || { ok: false, error: 'The extension was updated. Refresh this page.' });
      });
    } catch {
      resolve({ ok: false, error: 'The extension was updated. Refresh this page.' });
    }
  });

  // ------------------------------------------------------------------ UI
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const svg = (d, size = 14) => {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'currentColor');
    s.appendChild(p);
    return s;
  };
  const ICON_DL = 'M11 3h2v9.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6V3zM4 19h16v2H4z';
  const ICON_ARROW = 'M9.6 4h4.8v7.4h4L12 19l-6.4-7.6h4z';
  const ICON_X = 'M6.6 5 5 6.6 10.4 12 5 17.4 6.6 19 12 13.6 17.4 19 19 17.4 13.6 12 19 6.6 17.4 5 12 10.4z';

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style');
  style.textContent = `
    :host { all: initial; }
    .wrap { position: fixed; right: 0; top: 0; display: none; align-items: center;
      font: 13px/1.3 "Segoe UI", system-ui, -apple-system, sans-serif; }
    /* the pill: [ (⬇) Download | ✕ ]; after a few seconds unused it shrinks to [ (⬇) | ✕ ] */
    .pill { display: flex; align-items: stretch; height: 30px; border-radius: 8px; overflow: hidden;
      background: linear-gradient(#2a66dc, #1d4fb8); border: 1px solid #143e94;
      box-shadow: 0 2px 10px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.14); opacity: .94; transition: opacity .2s; }
    .pill:hover { opacity: 1; }
    .btn { display: flex; align-items: center; gap: 7px; border: 0; margin: 0; cursor: pointer; color: #fff; background: transparent;
      padding: 0 11px 0 6px; font: 600 13px/1 "Segoe UI", system-ui, sans-serif; transition: padding .25s ease, gap .25s ease; }
    .ic { width: 20px; height: 20px; border-radius: 50%; background: #e4e8ef; color: #1d55c4; display: flex;
      align-items: center; justify-content: center; flex: none; }
    .label { display: inline-block; white-space: nowrap; overflow: hidden; max-width: 90px; opacity: 1;
      transition: max-width .25s ease, opacity .2s ease; }
    .mini .btn { gap: 0; padding: 0 7px 0 6px; }
    .mini .label { max-width: 0; opacity: 0; }
    .div { width: 1px; margin: 6px 0; background: rgba(255,255,255,.3); flex: none; }
    .x { border: 0; margin: 0; cursor: pointer; color: #e4e8ef; background: transparent; padding: 0 8px;
      display: flex; align-items: center; justify-content: center; }
    .btn:hover, .x:hover { background: rgba(255,255,255,.12); }
    .panel { position: absolute; top: 34px; right: 0; width: 290px; max-height: 70vh; overflow: auto;
      background: #1b1f27; color: #e9edf3; border: 1px solid #2d3443; border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,.5); padding: 10px; display: none; }
    .panel.up { top: auto; bottom: 34px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .logo { width: 18px; height: 18px; border-radius: 4px; background: linear-gradient(#2f7cf6, #0b4fbf);
      display: flex; align-items: center; justify-content: center; color: #fff; flex: none; }
    .title { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .muted { color: #9aa4b6; font-size: 12px; margin: 6px 2px; }
    .err { color: #ff8a80; font-size: 12px; margin: 6px 2px; }
    .ok { color: #7ee2a8; font-size: 13px; margin: 8px 2px; font-weight: 600; }
    .opt { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px;
      background: #252b36; color: #e9edf3; border: 1px solid #323a4a; border-radius: 7px; padding: 8px 10px;
      margin: 4px 0; cursor: pointer; font: 13px "Segoe UI", system-ui, sans-serif; text-align: left; }
    .opt:hover { background: #1f6feb; border-color: #1f6feb; }
    .opt .q { font-weight: 600; }
    .opt .s { color: #b9c2d3; font-size: 12px; }
    .opt:hover .s { color: #fff; }
    .sep { border-top: 1px solid #2d3443; margin: 8px 0; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #4c8dff; border-right-color: transparent;
      border-radius: 50%; animation: r .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes r { to { transform: rotate(360deg); } }
  `;
  const wrap = el('div', 'wrap');
  const pill = el('div', 'pill');
  const btn = el('button', 'btn');
  btn.title = 'Download this video with Mechano DM';
  const ic = el('span', 'ic');
  ic.append(svg(ICON_ARROW, 15));
  btn.append(ic, el('span', 'label', 'Download'));
  const close = el('button', 'x');
  close.append(svg(ICON_X, 14));
  close.title = 'Hide for this video';
  pill.append(btn, el('span', 'div'), close);
  const panel = el('div', 'panel');
  wrap.append(pill, panel);
  root.append(style, wrap);

  // Full size when a new video shows up or the mouse is on it; small after a few seconds unused.
  let miniTimer = 0, hovering = false, lastKey = '';
  const setMini = (on) => pill.classList.toggle('mini', on);
  const shrinkSoon = (ms) => {
    clearTimeout(miniTimer);
    miniTimer = setTimeout(() => { if (!panelOpen && !hovering) setMini(true); }, ms);
  };
  pill.addEventListener('mouseenter', () => { hovering = true; clearTimeout(miniTimer); setMini(false); });
  pill.addEventListener('mouseleave', () => { hovering = false; shrinkSoon(1200); });

  const attach = () => {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  };

  // ------------------------------------------------------------------ choose the video
  let current = null;
  let panelOpen = false;
  // ✕ hides the button for one video. Keyed by what is playing, because Facebook Reels / YouTube
  // Shorts reuse the same <video> element for the next clip.
  const hidden = new WeakMap();
  const videoKey = (v) => `${v.currentSrc || v.src || ''}|${location.href}`;
  const isHidden = (v) => hidden.get(v) === videoKey(v);

  function visibleArea(r) {
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function pick() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (isHidden(v)) continue;
      const r = v.getBoundingClientRect();
      if (r.width < MIN_W || r.height < MIN_H) continue;
      const area = visibleArea(r);
      if (area < (r.width * r.height) * 0.35) continue; // mostly off-screen
      const cs = getComputedStyle(v);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function place() {
    if (!(panelOpen && current && current.isConnected)) current = pick();
    if (!current) { wrap.style.display = 'none'; closePanel(); lastKey = ''; return; }
    attach();
    const key = videoKey(current);
    if (key !== lastKey) { lastKey = key; setMini(false); shrinkSoon(4000); }
    const r = current.getBoundingClientRect();
    wrap.style.display = 'flex';
    const w = pill.offsetWidth || 130;
    const vw = document.documentElement.clientWidth || innerWidth; // excludes the scrollbar
    // anchored by its right edge, so shrinking keeps it in the video's corner
    const right = Math.max(6, Math.min(vw - w - 4, vw - r.right + 10));
    const top = Math.max(4, Math.min(innerHeight - 40, r.top + 10));
    wrap.style.transform = `translate(${-Math.round(right)}px, ${Math.round(top)}px)`;
    panel.classList.toggle('up', top > innerHeight - 330);
  }

  let queued = false;
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; place(); }); } };
  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule, { passive: true });
  document.addEventListener('fullscreenchange', () => { attach(); schedule(); });
  setInterval(place, 700); // catches new videos, SPA navigation, layout changes

  // ------------------------------------------------------------------ which URL to download
  // A <video> on social sites usually plays a blob: (MediaSource) stream, which can't be
  // downloaded directly. We hand the post / video page URL to yt-dlp instead.
  function nearLink(video, re) {
    for (let n = video, i = 0; n && i < 40; n = n.parentElement, i++) {
      if (n !== video && n.querySelectorAll && n.querySelectorAll('video').length > 1) break; // reached a feed container
      if (n.tagName === 'A' && re.test(n.href)) return n.href;
      if (n.querySelectorAll) {
        const a = Array.from(n.querySelectorAll('a[href]')).find((x) => re.test(x.href));
        if (a) return a.href;
      }
    }
    return null;
  }

  function resolveTarget(video) {
    const h = location.hostname.replace(/^www\.|^m\.|^web\./, '');
    const href = location.href;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(h)) {
      const embed = location.pathname.match(/^\/embed\/([\w-]{6,})/);
      if (embed) return { site: 'YouTube', url: `https://www.youtube.com/watch?v=${embed[1]}` };
      const v = new URLSearchParams(location.search).get('v');
      const list = new URLSearchParams(location.search).get('list');
      const main = video.closest('#movie_player, #shorts-player, ytd-reel-video-renderer');
      if (main && location.pathname === '/watch' && v) {
        // Radio/mix lists (RD...) are endless auto-generated mixes, not real playlists.
        const playlistUrl = list && !/^RD/.test(list) ? `https://www.youtube.com/playlist?list=${list}` : null;
        return { site: 'YouTube', url: `https://www.youtube.com/watch?v=${v}`, playlistUrl };
      }
      if (main && location.pathname.startsWith('/shorts/')) return { site: 'YouTube', url: href.split('?')[0] };
      const link = nearLink(video, /youtube\.com\/(watch\?v=|shorts\/)/);
      if (link) return { site: 'YouTube', url: link };
      return { site: 'YouTube', url: v ? `https://www.youtube.com/watch?v=${v}` : href };
    }
    if (/(^|\.)facebook\.com$/.test(h) || h === 'fb.watch') {
      const videoUrl = /facebook\.com\/(reel\/\d+|[^/?#]+\/videos\/|watch\/?\?v=\d+|share\/[vr]\/|video\.php)/;
      if (videoUrl.test(href)) return { site: 'Facebook', url: href };
      const link = nearLink(video, videoUrl) ||
        nearLink(video, /facebook\.com\/([^/?#]+\/posts\/|permalink\.php|story\.php|share\/p\/|groups\/[^/]+\/(posts|permalink)\/)/);
      return { site: 'Facebook', url: link || href };
    }
    if (/(^|\.)instagram\.com$/.test(h)) {
      if (/\/(reel|reels|p|tv)\/[\w-]+/.test(location.pathname)) return { site: 'Instagram', url: href };
      return { site: 'Instagram', url: nearLink(video, /instagram\.com\/(reel|reels|p|tv)\/[\w-]+/) || href };
    }
    if (/(^|\.)tiktok\.com$/.test(h)) {
      if (/\/video\/\d+/.test(location.pathname)) return { site: 'TikTok', url: href };
      return { site: 'TikTok', url: nearLink(video, /tiktok\.com\/@[^/]+\/video\/\d+/) || href };
    }
    if (/(^|\.)(x|twitter)\.com$/.test(h)) {
      return { site: 'X', url: nearLink(video, /\/status\/\d+/) || href };
    }
    if (/(^|\.)(vimeo|dailymotion|reddit|twitch|linkedin|threads|bilibili|rumble|kick|streamable)\.(com|net|tv)$/.test(h)) {
      return { site: h.split('.')[0], url: href };
    }
    // Any other site: the <video> may have a plain file URL, or a stream the extension sniffed.
    const src = video.currentSrc || video.src || '';
    return { site: null, url: href, src: /^https?:/.test(src) ? src : null };
  }

  // ------------------------------------------------------------------ panel
  const fmtSize = (n) => {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < 3) { n /= 1024; i++; }
    return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
  };

  function header(text) {
    const hd = el('div', 'head');
    const logo = el('div', 'logo');
    logo.append(svg(ICON_DL, 12));
    hd.append(logo, el('div', 'title', text || 'Mechano DM'));
    return hd;
  }

  function option(label, size, onClick) {
    const b = el('button', 'opt');
    b.append(el('span', 'q', label), el('span', 's', size || ''));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function show(...children) {
    panel.replaceChildren(...children);
    panel.style.display = 'block';
  }

  async function sendJob(job) {
    show(header('Mechano DM'), (() => { const p = el('div', 'muted'); p.append(el('span', 'spin'), 'Sending…'); return p; })());
    const r = await ask({ type: 'send', ...job, pageUrl: location.href });
    if (r.ok) {
      show(header('Mechano DM'), el('div', 'ok', '✓ Download started in Mechano DM'));
      setTimeout(closePanel, 2200);
    } else {
      show(header('Mechano DM'), el('div', 'err', friendly(r.error)));
    }
  }

  // Only a real network failure means the app is closed; show every other error as-is.
  const friendly = (e) => (/^(Failed to fetch|NetworkError|Load failed)|ECONNREFUSED/i.test(e || '')
    ? 'Mechano DM is not running. Open it from the desktop icon, then try again.'
    : e || 'Something went wrong');

  async function openPanel() {
    if (!current) return;
    panelOpen = true;
    clearTimeout(miniTimer);
    setMini(false);
    const t = resolveTarget(current);
    const loading = el('div', 'muted');
    loading.append(el('span', 'spin'), t.site ? `Getting qualities from ${t.site}…` : 'Looking for downloadable media…');
    show(header(document.title), loading);

    if (!t.site) return genericPanel(t);
    const plPromise = t.playlistUrl ? ask({ type: 'playlist-info', url: t.playlistUrl }) : null;
    const r = await ask({ type: 'video-options', url: t.url });
    if (!panelOpen) return;
    if (!r.ok) {
      show(header(document.title), el('div', 'err', friendly(r.error)),
        option('Try best quality anyway', '', () => sendJob({ url: t.url, kind: 'ytdlp' })));
      return;
    }
    const info = r.data;
    const rows = info.options.map((o) => option(o.label, fmtSize(o.size), () => sendJob({ url: t.url, kind: 'ytdlp', maxHeight: o.maxHeight })));
    if (!rows.length) rows.push(option('Best quality', '', () => sendJob({ url: t.url, kind: 'ytdlp' })));
    if (info.audio) rows.push(el('div', 'sep'), option('Audio only (MP3)', fmtSize(info.audio.size), () => sendJob({ url: t.url, kind: 'ytdlp', audioOnly: true })));
    let plBox = null;
    if (plPromise) {
      plBox = el('div');
      const wait = el('div', 'muted');
      wait.append(el('span', 'spin'), 'Reading playlist…');
      plBox.append(el('div', 'sep'), wait);
      rows.push(plBox);
    }
    show(header(info.title || document.title), ...rows);
    if (plPromise) fillPlaylist(plBox, t.playlistUrl, await plPromise);
  }

  /** "Whole playlist" section: same quality choices, applied to every video in the list. */
  function fillPlaylist(box, url, r) {
    if (!panelOpen || !box.isConnected) return;
    if (!r.ok) { box.replaceChildren(el('div', 'sep'), el('div', 'err', `Playlist: ${friendly(r.error)}`)); return; }
    const pl = r.data;
    const head = el('div', 'muted', `📃 Whole playlist: ${pl.title} (${pl.count} videos)`);
    const send = (extra) => () => sendJob({ url, kind: 'ytdlp', playlist: true, ...extra });
    box.replaceChildren(
      el('div', 'sep'), head,
      option(`All ${pl.count} videos · HD 1080p`, '', send({ maxHeight: 1080 })),
      option(`All ${pl.count} videos · 720p`, '', send({ maxHeight: 720 })),
      option(`All ${pl.count} videos · 480p`, '', send({ maxHeight: 480 })),
      option(`All ${pl.count} videos · Audio (MP3)`, '', send({ audioOnly: true })),
    );
  }

  async function genericPanel(t) {
    const r = await ask({ type: 'tab-media' });
    if (!panelOpen) return;
    const rows = [];
    if (t.src) {
      const kind = /\.m3u8(\?|$)/i.test(t.src) ? 'hls' : 'auto';
      rows.push(option('This video file', '', () => sendJob({ url: t.src, kind, referrer: location.href })));
    }
    for (const m of (r.ok && r.data) || []) {
      if (t.src && m.url === t.src) continue;
      const name = decodeURIComponent(new URL(m.url).pathname.split('/').pop() || 'media').slice(0, 40);
      const kind = m.kind === 'hls' ? 'hls' : m.kind === 'dash' ? 'ytdlp' : 'direct';
      rows.push(option(`${m.kind.toUpperCase()} · ${name}`, fmtSize(m.size), () => sendJob({ url: m.url, kind, referrer: location.href })));
    }
    rows.push(el('div', 'sep'), option('Try this page with yt-dlp', '', () => sendJob({ url: t.url, kind: 'ytdlp' })));
    if (rows.length === 2) rows.unshift(el('div', 'muted', 'No direct video link found. Play the video for a few seconds, or try yt-dlp:'));
    show(header(document.title), ...rows);
  }

  function closePanel() {
    const wasOpen = panelOpen;
    panelOpen = false;
    panel.style.display = 'none';
    if (wasOpen) shrinkSoon(1500);
  }

  btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); panelOpen ? closePanel() : openPanel(); });
  close.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); if (current) hidden.set(current, videoKey(current)); closePanel(); place(); });
  document.addEventListener('click', (e) => { if (panelOpen && !e.composedPath().includes(host)) closePanel(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });
  // Keep page shortcuts (YouTube space/k/f...) from firing while clicking our UI.
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'dblclick']) wrap.addEventListener(t, (e) => e.stopPropagation());
})();
