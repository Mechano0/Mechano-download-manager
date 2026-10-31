'use strict';
/**
 * Download statistics for the History folder: how much was downloaded per day and from which sites.
 * Kept in data/stats.json, separate from the job list, so "Clear history" does not reset them.
 * Only totals are stored (bytes and file counts per day and per site), never file names or links.
 */
const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 400;

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** youtube.com, facebook.com … (www. and m. dropped); magnet links count as "torrent". */
function siteOf(url) {
  if (/^magnet:/i.test(url || '')) return 'torrent';
  try { return new URL(url).hostname.replace(/^(www|m|mobile)\./, '') || 'other'; } catch { return 'other'; }
}

class Stats {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'stats.json');
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = { days: d.days || {}, sites: d.sites || {}, total: d.total || { bytes: 0, files: 0 } };
  }

  /** A download finished (call once per finished job). */
  record(job, at = Date.now()) {
    const bytes = Math.max(0, Number(job.size || job.downloaded) || 0);
    const files = job.playlist ? Math.max(1, Number(job.playlistDone) || 1) : 1;
    const add = (o) => { o.bytes = (o.bytes || 0) + bytes; o.files = (o.files || 0) + files; return o; };
    const key = dayKey(at);
    this.data.days[key] = add(this.data.days[key] || {});
    // files from a CDN count for the page they were downloaded from (the browser sends it as the referrer)
    const site = siteOf(job.kind === 'direct' && job.referrer ? job.referrer : job.url);
    this.data.sites[site] = add(this.data.sites[site] || {});
    add(this.data.total);
    this.prune(at);
    this.save();
  }

  prune(now) {
    const oldest = dayKey(now - KEEP_DAYS * 86400000);
    for (const k of Object.keys(this.data.days)) if (k < oldest) delete this.data.days[k];
  }

  save() {
    const tmp = this.file + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file); } catch { /* disk full etc.: stats are optional */ }
  }

  /** Totals for the History folder. */
  summary(now = Date.now()) {
    const today = dayKey(now);
    const d = new Date(now);
    const monthPrefix = today.slice(0, 8); // "2026-10-"
    const sum = (pred) => Object.entries(this.data.days).filter(([k]) => pred(k))
      .reduce((a, [, v]) => ({ bytes: a.bytes + (v.bytes || 0), files: a.files + (v.files || 0) }), { bytes: 0, files: 0 });
    const weekStart = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime());
    const sites = Object.entries(this.data.sites)
      .map(([site, v]) => ({ site, bytes: v.bytes || 0, files: v.files || 0 }))
      .sort((a, b) => b.bytes - a.bytes || b.files - a.files).slice(0, 5);
    // last 14 days for the small bar chart
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const k = dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i).getTime());
      days.push({ day: k, bytes: this.data.days[k]?.bytes || 0, files: this.data.days[k]?.files || 0 });
    }
    return {
      today: sum((k) => k === today), week: sum((k) => k >= weekStart), month: sum((k) => k.startsWith(monthPrefix)),
      total: { ...this.data.total }, sites, days,
    };
  }
}

module.exports = { Stats, siteOf, dayKey };
