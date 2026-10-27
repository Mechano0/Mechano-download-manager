'use strict';
/**
 * Site Grabber: reads a web page (and, if asked, the pages it links to on the same site) and
 * lists the files linked from them: archives, videos, music, documents, programs, pictures, or
 * any extensions you type. Nothing is downloaded here; you tick what you want in the window.
 *
 * Limits keep it polite: at most `maxPages` pages (default 40, max 200), 4 at a time, pages
 * bigger than 5 MB are skipped, only http(s), and by default only pages of the same site.
 */
const path = require('node:path');
const { CATEGORIES, categorize, filenameFromUrl } = require('./util');

const PAGE_LIMIT = 5 << 20;
const DEFAULT_CATS = ['Compressed', 'Video', 'Music', 'Documents', 'Programs'];

function extsFor(categories, custom) {
  const set = new Set();
  for (const c of categories || DEFAULT_CATS) for (const e of CATEGORIES[c] || []) set.add(e);
  for (const e of String(custom || '').split(/[\s,;]+/)) { const x = e.replace(/^\*?\./, '').toLowerCase(); if (/^[a-z0-9]{1,8}$/.test(x)) set.add(x); }
  return set;
}

/** All href/src targets in an HTML page, made absolute (no scripts are run). */
function extractLinks(html, base) {
  const out = new Set();
  const re = /\b(?:href|src|data-src|data-href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim().replace(/&amp;/g, '&');
    if (!raw || /^(javascript|mailto|tel|data):/i.test(raw) || raw.startsWith('#')) continue;
    try {
      const u = new URL(raw, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';
      out.add(u.href);
    } catch { /* bad link */ }
  }
  // <base href> is rare; links already resolved against the page URL
  return [...out];
}

const extOf = (u) => { try { return path.extname(decodeURIComponent(new URL(u).pathname)).slice(1).toLowerCase(); } catch { return ''; } };
const looksLikePage = (u) => { const e = extOf(u); return !e || ['html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'shtml', 'cgi'].includes(e); };

async function fetchPage(url, headers, signal) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MechanoDM-Grabber', accept: 'text/html,*/*;q=0.5', ...headers }, redirect: 'follow', signal });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !/html|xml/i.test(type)) { res.body?.cancel().catch(() => {}); return null; }
  const len = Number(res.headers.get('content-length') || 0);
  if (len > PAGE_LIMIT) { res.body?.cancel().catch(() => {}); return null; }
  const chunks = [];
  let size = 0;
  for await (const c of res.body) { size += c.length; if (size > PAGE_LIMIT) break; chunks.push(c); }
  return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url || url };
}

/**
 * @param {{ url: string, depth?: number, categories?: string[], custom?: string, sameSite?: boolean,
 *           maxPages?: number, headers?: object, signal?: AbortSignal }} o
 * @returns {Promise<{ pages: number, files: {url,name,ext,category,from}[], errors: number }>}
 */
async function grab(o) {
  const start = new URL(o.url);
  if (!/^https?:$/.test(start.protocol)) throw new Error('Only http(s) pages can be grabbed');
  const depth = Math.max(0, Math.min(3, Number(o.depth) || 0));
  const maxPages = Math.max(1, Math.min(200, Number(o.maxPages) || 40));
  const sameSite = o.sameSite !== false;
  const wanted = extsFor(o.categories, o.custom);
  const host = start.hostname.replace(/^www\./, '');
  const onSite = (u) => { const h = new URL(u).hostname.replace(/^www\./, ''); return h === host || h.endsWith('.' + host); };

  const seen = new Set([start.href]);
  const files = new Map();
  let queue = [start.href];
  let pages = 0, errors = 0;
  const signal = o.signal || AbortSignal.timeout(120000);

  for (let level = 0; level <= depth && queue.length && pages < maxPages; level++) {
    const next = [];
    for (let i = 0; i < queue.length && pages < maxPages; i += 4) {
      const batch = queue.slice(i, Math.min(i + 4, i + (maxPages - pages)));
      pages += batch.length;
      const results = await Promise.all(batch.map((u) => fetchPage(u, o.headers, signal).catch(() => { errors++; return null; })));
      results.forEach((r, k) => {
        if (!r) return;
        for (const link of extractLinks(r.html, r.finalUrl)) {
          const ext = extOf(link);
          if (wanted.has(ext)) {
            if (!files.has(link)) files.set(link, { url: link, name: filenameFromUrl(link) || link, ext, category: categorize('x.' + ext), from: batch[k] });
          } else if (level < depth && looksLikePage(link) && !seen.has(link) && (!sameSite || onSite(link))) {
            seen.add(link);
            next.push(link);
          }
        }
      });
    }
    queue = next;
  }
  return { pages, files: [...files.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)), errors };
}

module.exports = { grab, extractLinks, extsFor, DEFAULT_CATS };
