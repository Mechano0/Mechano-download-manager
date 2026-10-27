'use strict';
/**
 * Queue + scheduler + router (IDM: CDownloadQueue, CQueuesArray, CSchedulerInfo, CDownloadComponents).
 *
 * Routing for a new URL:
 *   .m3u8 / HLS mime            -> HlsDownload
 *   YouTube / social / .mpd     -> YtdlpDownload
 *   anything else               -> SegmentedDownload (falls back to yt-dlp if it turns out to be a web page)
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { SegmentedDownload } = require('./segmented');
const { HlsDownload } = require('./hls');
const { YtdlpDownload, findTool, writeCookiesFile } = require('./ytdlp');
const { RateLimiter } = require('./limiter');
const { categorize, CATEGORIES, filenameFromUrl, sanitizeFilename } = require('./util');
const { PlaylistDownload } = require('./playlist');
const { MediaDownload } = require('./media');
const { TorrentDownload, isMagnet, isTorrentUrl } = require('./torrent');

const YTDLP_SITES = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'facebook.com', 'fb.watch', 'instagram.com', 'tiktok.com',
  'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com', 'reddit.com', 'v.redd.it', 'twitch.tv', 'soundcloud.com',
  'linkedin.com', 'pinterest.com', 'threads.net', 'threads.com', 'bilibili.com', 'snapchat.com', 'tumblr.com',
  'vk.com', 'ok.ru', 'rumble.com', 'kick.com', 'streamable.com', 'bandcamp.com', 'mixcloud.com',
];

const DEFAULT_CONFIG = {
  port: 9614,
  downloadDir: path.join(os.homedir(), 'Downloads', 'M.DM'),
  useCategories: true,
  confirmDownloads: true, // show the "save to" confirmation before each new download
  showCompleteDialog: true, // small "Download complete" window with Open / Open folder
  maxConcurrent: 3,
  connections: 8,
  speedLimitKBps: 0,
  hlsConcurrency: 6,
  ytdlpPath: '',
  ffmpegPath: '',
  ytdlpSites: YTDLP_SITES,
  autoUpdateDays: 5, // update yt-dlp automatically every N days (0 = off)
  ytdlpChannel: 'stable', // 'stable' or 'nightly'
  fastVideo: true, // videos: our multi-connection engine downloads the links yt-dlp finds (media.js)
  language: 'auto', // 'auto' (Windows language), 'en' or 'ar'
  clipboardMonitor: true, // offer to download links you copy (Mechano DM.exe watches the clipboard)
  categoryDirs: {}, // "Remember this path for the category": { Video: 'D:\\Videos', ... }
  appUpdate: 'notify', // new versions of Mechano DM: 'notify' (ask first), 'auto' or 'off'
};

const CATEGORY_NAMES = ['General', 'Video', 'Music', 'Compressed', 'Documents', 'Programs', 'Images'];
// Copied links that count as downloads (pictures and plain text files are left alone)
const CLIPBOARD_EXTS = new Set([...CATEGORIES.Compressed, ...CATEGORIES.Documents, ...CATEGORIES.Music, ...CATEGORIES.Programs, ...CATEGORIES.Video,
  'torrent'].filter((e) => !['txt', 'csv', 'bat'].includes(e)));

class Manager extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.configPath = path.join(dataDir, 'config.json');
    this.jobsPath = path.join(dataDir, 'jobs.json');
    this.config = { ...DEFAULT_CONFIG, ...readJson(this.configPath, {}) };
    if (!this.config.token) this.config.token = crypto.randomBytes(24).toString('hex');
    // The old default folder (Downloads\Mechano DM) moves to the new one (Downloads\M.DM).
    if (path.resolve(this.config.downloadDir || '') === path.join(os.homedir(), 'Downloads', 'Mechano DM')) {
      this.config.downloadDir = DEFAULT_CONFIG.downloadDir;
    }
    this.saveConfig();
    this.ensureCategoryFolders();
    this.limiter = new RateLimiter(this.config.speedLimitKBps * 1024);
    this.jobs = new Map();
    this.runners = new Map();
    for (const j of readJson(this.jobsPath, [])) {
      if (j.status === 'downloading' || j.status === 'starting') j.status = 'queued'; // app was closed mid-download
      j.speed = 0;
      this.jobs.set(j.id, j);
    }
    // Work folders of downloads that are gone or finished (e.g. removed while the app was closed).
    try {
      for (const id of fs.readdirSync(path.join(dataDir, 'work'))) {
        const j = this.jobs.get(id);
        if (!j || j.status === 'done') fs.rmSync(path.join(dataDir, 'work', id), { recursive: true, force: true });
      }
    } catch { /* no work folder yet */ }
    // Older saved jobs have no queue position yet: number them by when they were added.
    let n = 0;
    for (const j of [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      n = typeof j.order === 'number' ? Math.max(n, j.order) : n + 1;
      if (typeof j.order !== 'number') j.order = n;
    }
    this.scheduler = setInterval(() => this.pump(), 10_000); // starts scheduled jobs on time
    this.scheduler.unref?.();
    setImmediate(() => this.pump());
  }

  // --- tools -----------------------------------------------------------------
  tools() {
    return {
      ytdlp: findTool('yt-dlp', this.config.ytdlpPath),
      ffmpeg: findTool('ffmpeg', this.config.ffmpegPath),
      aria2: findTool('aria2c'),
      node: process.execPath,
    };
  }

  // --- config -----------------------------------------------------------------
  saveConfig() { writeJson(this.configPath, this.config); }

  /** Downloads\M.DM\Video, \Music, \Compressed, \Documents, \Programs, \Images, \General */
  ensureCategoryFolders() {
    if (!this.config.useCategories) return;
    for (const c of [...Object.keys(CATEGORIES), 'General']) {
      try { fs.mkdirSync(path.join(this.config.downloadDir, c), { recursive: true }); } catch { /* drive missing etc. */ }
    }
  }

  /** The category a download belongs to (its folder, unless the user picked one). */
  categoryOf(job, filename) {
    if (job.category && CATEGORY_NAMES.includes(job.category)) return job.category;
    if (job.kind === 'ytdlp') return job.audioOnly ? 'Music' : 'Video';
    if (job.kind === 'hls') return 'Video';
    if (job.kind === 'torrent') return 'General';
    return categorize(filename || '');
  }

  /** Folder of a category: the remembered one, else Downloads\M.DM\<Category>. */
  categoryDir(cat) {
    const cfg = this.config;
    const remembered = cfg.categoryDirs && cfg.categoryDirs[cat];
    if (remembered && path.isAbsolute(remembered)) return remembered;
    return cfg.useCategories ? path.join(cfg.downloadDir, cat) : cfg.downloadDir;
  }

  /** The folder a download goes to by default (its category folder). */
  suggestDir(job, filename) {
    return this.categoryDir(this.categoryOf(job, filename));
  }

  updateConfig(patch) {
    const allowed = ['downloadDir', 'useCategories', 'maxConcurrent', 'connections', 'speedLimitKBps', 'hlsConcurrency', 'ytdlpPath', 'ffmpegPath', 'ytdlpSites', 'autoUpdateDays', 'ytdlpChannel', 'confirmDownloads', 'showCompleteDialog', 'fastVideo',
      'language', 'clipboardMonitor', 'categoryDirs', 'appUpdate'];
    for (const k of allowed) if (k in patch) this.config[k] = patch[k];
    this.config.confirmDownloads = !!this.config.confirmDownloads;
    this.config.showCompleteDialog = !!this.config.showCompleteDialog;
    this.config.fastVideo = this.config.fastVideo !== false;
    this.config.clipboardMonitor = !!this.config.clipboardMonitor;
    if (!['auto', 'en', 'ar'].includes(this.config.language)) this.config.language = 'auto';
    if (!['notify', 'auto', 'off'].includes(this.config.appUpdate)) this.config.appUpdate = 'notify';
    const dirs = {};
    for (const [k, v] of Object.entries(this.config.categoryDirs || {})) {
      if (CATEGORY_NAMES.includes(k) && typeof v === 'string' && path.isAbsolute(v)) dirs[k] = v;
    }
    this.config.categoryDirs = dirs;
    if (!path.isAbsolute(String(this.config.downloadDir || ''))) throw new Error('Download folder must be a full path, like C:\\Users\\you\\Downloads\\M.DM');
    this.ensureCategoryFolders();
    this.config.autoUpdateDays = Math.min(60, Math.max(0, Math.round(Number(this.config.autoUpdateDays) || 0)));
    if (!['stable', 'nightly'].includes(this.config.ytdlpChannel)) this.config.ytdlpChannel = 'stable';
    this.config.maxConcurrent = clampInt(this.config.maxConcurrent, 1, 20);
    this.config.connections = clampInt(this.config.connections, 1, 32);
    this.config.hlsConcurrency = clampInt(this.config.hlsConcurrency, 1, 32);
    this.limiter.setRate((Number(this.config.speedLimitKBps) || 0) * 1024);
    this.saveConfig();
    this.pump();
    return this.publicConfig();
  }

  publicConfig() {
    const { token, ...rest } = this.config;
    return rest;
  }

  // --- jobs ---------------------------------------------------------------------
  detectKind(url, mime) {
    let u;
    if (isMagnet(url)) return 'torrent';
    try { u = new URL(url); } catch { throw new Error('Invalid URL'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) and magnet links are supported');
    if (isTorrentUrl(url) || /bittorrent/i.test(mime || '')) return 'torrent';
    const host = u.hostname.replace(/^www\./, '');
    if (/mpegurl/i.test(mime || '') || /\.m3u8?$/i.test(u.pathname)) return 'hls';
    if (/dash\+xml/i.test(mime || '') || /\.mpd$/i.test(u.pathname)) return 'ytdlp';
    if (this.config.ytdlpSites.some((s) => host === s || host.endsWith('.' + s))) return 'ytdlp';
    return 'direct';
  }

  /**
   * A link was copied (Mechano DM.exe watches the clipboard). Downloadable links open the
   * "Download File Info" window; everything else is ignored quietly.
   */
  fromClipboard(text) {
    if (!this.config.clipboardMonitor) return { added: false, reason: 'clipboard monitor is off' };
    const url = String(text || '').trim();
    if (!url || url.length > 4000 || /\s/.test(url)) return { added: false, reason: 'not a single link' };
    let kind, u;
    try { u = new URL(url); kind = this.detectKind(url); } catch { return { added: false, reason: 'not a link' }; }
    if (kind === 'direct') {
      const ext = path.extname(u.pathname).slice(1).toLowerCase();
      if (!CLIPBOARD_EXTS.has(ext)) return { added: false, reason: 'not a file link' };
    }
    if (kind === 'ytdlp' && u.pathname.replace(/\/+$/, '') === '') return { added: false, reason: 'site home page' };
    const now = Date.now();
    if (this.lastClip && this.lastClip.url === url && now - this.lastClip.at < 15000) return { added: false, reason: 'just offered' };
    this.lastClip = { url, at: now };
    if ([...this.jobs.values()].some((j) => j.url === url && !['done', 'error'].includes(j.status))) return { added: false, reason: 'already in the list' };
    return { added: true, job: this.add({ url, kind, forceConfirm: true, source: 'clipboard' }) };
  }

  /**
   * @param {object} spec  { url, kind?, filename?, connections?, referrer?, userAgent?, cookies?,
   *                         headers?, format?, maxHeight?, audioOnly?, startAt?, dir?, mime? }
   */
  add(spec) {
    if (!spec || typeof spec.url !== 'string') throw new Error('url is required');
    const kind = spec.kind && spec.kind !== 'auto' ? spec.kind : this.detectKind(spec.url, spec.mime);
    if (!['direct', 'hls', 'ytdlp', 'torrent'].includes(kind)) throw new Error('Unknown kind');
    const id = crypto.randomBytes(6).toString('hex');
    const job = {
      // "Download later": waits in status 'scheduled' until the scheduler's start time
      // 'confirm' = waiting for the user to approve it and check the save folder (IDM "Download File Info")
      id, url: spec.url, kind, createdAt: Date.now(), scheduled: !!spec.scheduled,
      // forceConfirm: links from the clipboard always ask first, even with "Don't ask again"
      status: spec.scheduled ? 'scheduled' : ((this.config.confirmDownloads || spec.forceConfirm) && !spec.confirmed ? 'confirm' : 'queued'),
      filename: spec.filename ? String(spec.filename) : null,
      description: spec.description ? String(spec.description).slice(0, 500) : null,
      source: ['clipboard', 'browser', 'grabber', 'app'].includes(spec.source) ? spec.source : null,
      dir: spec.dir || null, target: null, file: null,
      connections: spec.connections ? clampInt(spec.connections, 1, 32) : null,
      referrer: spec.referrer || null, userAgent: spec.userAgent || null,
      headers: sanitizeHeaders(spec.headers), cookies: Array.isArray(spec.cookies) ? spec.cookies.slice(0, 300) : null,
      format: spec.format || null, maxHeight: spec.maxHeight ? Number(spec.maxHeight) : null,
      audioOnly: !!spec.audioOnly,
      // Whole playlist: explicit choice, or automatic for youtube.com/playlist?list=... pages
      playlist: kind === 'ytdlp' && (spec.playlist === true || (spec.playlist !== false && isPlaylistPage(spec.url))),
      startAt: spec.startAt ? new Date(spec.startAt).getTime() || null : null,
      downloaded: 0, size: null, speed: 0, eta: null, error: null, log: [],
    };
    job.order = this.nextOrder(); // position in the queue (can be changed with move())
    this.jobs.set(id, job);
    this.changed(job, true);
    this.pump();
    return job;
  }

  list() { return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt).map(publicJob); }

  get(id) { return this.jobs.get(id); }

  pause(id) {
    const job = this.mustGet(id);
    const r = this.runners.get(id);
    if (r) r.pause();
    else if (job.status === 'queued' || job.status === 'scheduled') { job.status = 'paused'; job.scheduled = false; this.changed(job, true); }
    return publicJob(job);
  }

  /** Start now (also takes a job out of the schedule). */
  resume(id) {
    const job = this.mustGet(id);
    if (['paused', 'error', 'scheduled'].includes(job.status)) {
      job.status = 'queued'; job.error = null; job.startAt = null; job.scheduled = false; job.scheduleRun = null;
      this.changed(job, true);
    }
    this.pump();
    return publicJob(job);
  }

  /**
   * Details for the confirmation popup: name, size and the folder it will be saved to.
   * Files are probed (name/size from the server); media sites ask yt-dlp for the title.
   */
  async details(id) {
    const job = this.mustGet(id);
    if (job.details) return job.details;
    const headers = { ...job.headers };
    if (job.userAgent) headers['user-agent'] = job.userAgent;
    if (job.referrer) headers.referer = job.referrer;
    let name = job.filename || null;
    let size = null;
    let note = null;
    let qualities = null; // media sites: the choices for the quality list in the popup
    let site = null, duration = null, resumable = null, thumbnail = null;
    try {
      if (job.kind === 'direct') {
        const cookie = cookieHeader(job.cookies, job.url);
        if (cookie) headers.cookie = cookie;
        const info = await require('./probe').probe(job.url, { headers });
        name = job.filename || info.filename;
        size = info.size;
        resumable = info.resumable;
        if (info.contentType === 'text/html') note = 'This link is a web page; the video on it will be downloaded with yt-dlp.';
      } else if (job.kind === 'torrent') {
        const t = await require('./torrent').describe(job.url);
        name = t.name;
        size = t.size;
        site = 'Torrent';
      } else if (job.kind === 'ytdlp') {
        const t = this.tools();
        const { info: ytInfo, playlistInfo } = require('./ytdlp');
        if (job.playlist) {
          const pl = await playlistInfo(job.url, { ytdlp: t.ytdlp });
          name = `${pl.title} (${pl.count} videos)`;
          qualities = PLAYLIST_QUALITIES.map((q) => ({ ...q }));
          // Keep the list: the download starts from it without reading the playlist again.
          if (!job.entries) { job.playlistTitle = pl.title || 'Playlist'; job.entries = pl.entries.map((e) => ({ ...e, state: 'waiting', downloaded: 0, size: null, file: null, error: null })); }
        } else {
          const i = await ytInfo(job.url, { ytdlp: t.ytdlp });
          name = i.title;
          qualities = qualityOptions(i.formats);
          site = i.extractor || null;
          duration = i.duration || null;
          thumbnail = /^https:\/\//.test(i.thumbnail || '') ? i.thumbnail : null;
        }
      } else {
        name = name || (filenameFromUrl(job.url) || 'video').replace(/\.m3u8?$/i, '') + '.mp4';
      }
    } catch (e) {
      note = `Could not read the details (${e.message}). You can still start the download.`;
    }
    name = name || filenameFromUrl(job.url) || job.url;
    const category = this.categoryOf(job, name);
    // the name in "Save As": files keep their extension; videos get the one they will be saved with
    const media = job.kind === 'ytdlp' && !job.playlist;
    const ext = media ? (job.audioOnly ? 'mp3' : 'mp4') : job.kind === 'hls' ? 'mp4' : path.extname(name).slice(1).toLowerCase();
    let fileName = job.kind === 'ytdlp' || job.kind === 'torrent' ? sanitizeFilename(name).slice(0, 120) : sanitizeFilename(name);
    if (media) fileName += '.' + ext;
    job.details = {
      name, fileName, size, folder: this.suggestDir(job, name), note,
      kind: job.kind, playlist: !!job.playlist, qualities, site, duration, resumable, thumbnail, ext,
      category, categories: CATEGORY_NAMES,
      categoryDirs: Object.fromEntries(CATEGORY_NAMES.map((c) => [c, this.categoryDir(c)])),
      remembered: Object.keys(this.config.categoryDirs || {}),
      connections: job.connections || this.config.connections,
      description: job.description || '',
      // media sites: where a video vs. an audio-only download goes (the popup switches between them)
      folders: job.kind === 'ytdlp' ? { video: this.categoryDir('Video'), audio: this.categoryDir('Music') } : null,
      selected: job.audioOnly ? 'audio' : job.maxHeight ? String(job.maxHeight) : 'best',
    };
    return job.details;
  }

  /**
   * Approve a download from the popup: optional custom folder and quality; start now or put it
   * in the scheduler. quality = 'best' | 'audio' | a height such as '1080'.
   */
  confirm(id, { dir, later, quality, filename, category, rememberPath, description, connections } = {}) {
    const job = this.mustGet(id);
    if (job.status !== 'confirm') return publicJob(job);
    if (quality != null && job.kind === 'ytdlp') {
      const q = String(quality);
      job.audioOnly = q === 'audio';
      // "360" = best up to 360p; "360:sd" = that exact file (Facebook's sd/hd have no height for yt-dlp)
      const m = q.match(/^(\d+)(?::([\w.-]{1,40}))?$/);
      job.maxHeight = m ? Number(m[1]) : null;
      job.format = m && m[2] ? m[2] : null;
      if (!dir) job.dir = null; // category follows the choice (Music for audio, Video otherwise)
    }
    if (category && CATEGORY_NAMES.includes(category)) job.category = category;
    if (dir) {
      const d = String(dir).trim();
      if (!path.isAbsolute(d)) throw new Error('Choose a full folder path, like D:\\Videos');
      fs.mkdirSync(d, { recursive: true });
      job.dir = d; // exact folder chosen by the user (no category sub-folder)
      if (rememberPath) {
        const cat = this.categoryOf(job, job.filename || job.details?.name);
        this.config.categoryDirs = { ...(this.config.categoryDirs || {}), [cat]: d };
        this.saveConfig();
      }
    }
    if (filename) {
      // "Save As" name. Videos: the extension comes from the download (mp4 / mp3 ...).
      let n = sanitizeFilename(String(filename).trim());
      if (job.kind === 'ytdlp' || job.kind === 'hls') n = n.replace(/\.(mp4|mkv|webm|mp3|m4a|mov)$/i, '');
      if (job.kind === 'ytdlp') job.customName = job.playlist ? null : n;
      else if (n) job.filename = job.kind === 'hls' ? n + '.mp4' : n;
    }
    if (description != null) job.description = String(description).slice(0, 500) || null;
    if (connections) job.connections = clampInt(connections, 1, 32);
    job.status = later ? 'scheduled' : 'queued';
    job.scheduled = !!later;
    this.changed(job, true);
    this.pump();
    return publicJob(job);
  }

  /**
   * Playlist video list: action = 'skip' | 'include' | 'retry' | 'up' | 'down' | 'top' | 'bottom' | 'move'
   * (with `to` = 0-based position). Works while the playlist is downloading.
   */
  playlistEntry(id, entryId, action, to) {
    const job = this.mustGet(id);
    if (!job.playlist || !Array.isArray(job.entries)) throw new Error('This download is not a playlist');
    const list = job.entries;
    const e = list.find((x) => String(x.id) === String(entryId));
    if (!e) throw new Error('Video not found in this playlist');
    const runner = this.runners.get(id);
    if (action === 'skip') {
      if (e.state === 'downloading') { if (!(runner && runner.skipCurrent && runner.skipCurrent(e.id))) e.state = 'skipped'; }
      else if (e.state === 'waiting' || e.state === 'error') e.state = 'skipped';
    } else if (action === 'include' || action === 'retry') {
      if (e.state === 'skipped' || e.state === 'error') { e.state = 'waiting'; e.error = null; }
      // a finished playlist with new videos to get starts again
      if (['done', 'error'].includes(job.status)) { job.status = 'queued'; job.error = null; }
    } else {
      const from = list.indexOf(e);
      let target = action === 'up' ? from - 1 : action === 'down' ? from + 1 : action === 'top' ? 0 : action === 'bottom' ? list.length - 1 : Number(to);
      if (!Number.isInteger(target)) throw new Error('Bad position');
      target = Math.max(0, Math.min(list.length - 1, target));
      list.splice(from, 1);
      list.splice(target, 0, e);
    }
    const total = list.filter((x) => x.state !== 'skipped').length;
    const finished = list.filter((x) => x.state === 'done' || x.state === 'error').length;
    Object.assign(job, { playlistCount: total, playlistDone: finished });
    this.changed(job, true);
    this.pump();
    return publicJob(job);
  }

  /** Move a waiting job into the schedule ("download later"). Running jobs are paused first. */
  async scheduleLater(id) {
    const job = this.mustGet(id);
    if (job.status === 'done') throw new Error('This download is already finished');
    const r = this.runners.get(id);
    if (r) { r.pause(); await new Promise((res) => r.once('settled', res)); }
    job.status = 'scheduled';
    job.scheduled = true;
    job.error = null;
    job.startAt = null;
    this.changed(job, true);
    return publicJob(job);
  }

  async remove(id, deleteFiles = false) {
    const job = this.mustGet(id);
    const r = this.runners.get(id);
    if (r) { r.pause(); await new Promise((res) => r.once('settled', res)); }
    // Unfinished pieces always go, so a removed download leaves nothing behind; the finished
    // file is deleted only when asked.
    if (job.status !== 'done') this.removePartials(job);
    else fs.rmSync(this.workPath(job), { recursive: true, force: true });
    if (deleteFiles && job.file) {
      try { fs.rmSync(job.file, { recursive: !!job.playlist, force: true }); } catch { /* in use: leave it */ }
    }
    this.dropSecrets(job);
    this.jobs.delete(id);
    this.persist();
    this.emit('removed', id);
  }

  // --- unfinished pieces --------------------------------------------------------
  workPath(job) { return path.join(this.dataDir, 'work', job.id); }

  /**
   * Where a job keeps its unfinished pieces: data\work\<id>, so the save folder only gets finished
   * files. Jobs that already have pieces next to the file (from older versions) keep them there,
   * so they still resume.
   */
  workDirFor(job) {
    if (job.kind === 'torrent') return null; // aria2 manages its own files
    if (!job.useWork && (job.downloaded > 0 || job.target)) return null;
    job.useWork = true;
    return this.workPath(job);
  }

  /** Delete a job's unfinished pieces: its work folder, plus pieces older versions left next to the file. */
  removePartials(job) {
    const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* in use */ } };
    rm(this.workPath(job));
    if (job.target) for (const s of ['.mdmpart', '.mdmpart.json', '.mdmhls', '.video.tmp', '.audio.tmp']) rm(job.target + s);
    if (job.kind !== 'ytdlp' || !job.dir || job.playlist) return;
    // yt-dlp pieces: "<name>.<ext>.part", ".part-Frag12", ".part-Frag12.part", ".ytdl", "<name>.f137.mp4.part"...
    const names = [job.customName, job.filename].filter(Boolean).map((n) => n.replace(/\.(mp4|mp3|webm|mkv|m4a)$/i, ''));
    if (!names.length) return;
    let list = [];
    try { list = fs.readdirSync(job.dir); } catch { return; }
    for (const f of list) {
      if (!/\.(part|ytdl)$|\.part-Frag\d+(\.part)?$|\.mdmpart(\.json)?$/i.test(f)) continue;
      if (names.some((n) => f.startsWith(n + '.') || f.startsWith(n + ' ['))) rm(path.join(job.dir, f));
    }
  }

  mustGet(id) {
    const j = this.jobs.get(id);
    if (!j) throw Object.assign(new Error('No such download'), { status: 404 });
    return j;
  }

  // --- queue -------------------------------------------------------------------
  /** How many scheduled-queue downloads may run at the same time (Scheduler → "Download N at the same time"). */
  get scheduleLimit() {
    return clampInt(this.config.schedule?.concurrent ?? 2, 1, 20);
  }

  pump() {
    const now = Date.now();
    while (this.runners.size < this.config.maxConcurrent) {
      // Scheduled downloads already running from the scheduler's queue
      let schedRunning = 0;
      for (const id of this.runners.keys()) if (this.jobs.get(id)?.scheduleRun) schedRunning++;
      const next = [...this.jobs.values()]
        .filter((j) => j.status === 'queued' && (!j.startAt || j.startAt <= now))
        .filter((j) => !(this.updating && j.kind === 'ytdlp')) // yt-dlp is being replaced: wait
        .filter((j) => !(j.scheduleRun && schedRunning >= this.scheduleLimit)) // scheduler queue: N at a time
        .sort(byOrder)[0];
      if (!next) break;
      this.run(next);
    }
  }

  nextOrder() {
    let max = 0;
    for (const j of this.jobs.values()) if (j.order > max) max = j.order;
    return max + 1;
  }

  /**
   * Re-order a waiting download inside its queue (scheduled list or "queued" list), like
   * IDM's Move up / Move down. `to` = 'up' | 'down' | 'top' | 'bottom' | a 0-based position.
   * Returns the new order of that queue (ids).
   */
  move(id, to) {
    const job = this.mustGet(id);
    if (!['scheduled', 'queued'].includes(job.status)) throw new Error('Only waiting downloads can be re-ordered');
    const group = [...this.jobs.values()].filter((j) => j.status === job.status).sort(byOrder);
    const slots = group.map((j) => j.order).sort((a, b) => a - b); // reuse the same order numbers
    const from = group.indexOf(job);
    let target = to === 'up' ? from - 1 : to === 'down' ? from + 1 : to === 'top' ? 0 : to === 'bottom' ? group.length - 1 : Number(to);
    if (!Number.isInteger(target)) throw new Error('Bad position');
    target = Math.max(0, Math.min(group.length - 1, target));
    group.splice(from, 1);
    group.splice(target, 0, job);
    group.forEach((j, i) => { if (j.order !== slots[i]) { j.order = slots[i]; this.changed(j, true); } });
    return group.map((j) => j.id);
  }

  run(job) {
    job.status = 'starting';
    job.error = null;
    const runner = this.makeRunner(job);
    this.runners.set(job.id, runner);
    this.changed(job, true);

    runner.on('meta', (m) => {
      if (m.target) job.target = m.target;
      if (m.filename) job.filename = m.filename;
      if (m.playlistTitle) job.playlistTitle = m.playlistTitle;
      if (m.playlistCount) job.playlistCount = m.playlistCount;
      if (m.size != null) job.size = m.size;
      job.status = 'downloading';
      this.changed(job, true);
    });
    runner.on('progress', (p) => {
      job.status = 'downloading';
      Object.assign(job, { downloaded: p.downloaded, size: p.size ?? job.size, speed: Math.round(p.speed || 0), eta: p.eta, connections: p.connections, segments: p.segments || null });
      if (p.playlistIndex) Object.assign(job, { playlistIndex: p.playlistIndex, playlistCount: p.playlistCount || job.playlistCount, playlistDone: p.playlistDone });
      this.changed(job);
    });
    runner.on('log', (line) => { job.log.push(line); if (job.log.length > 30) job.log.shift(); this.changed(job); });
    runner.on('entries', (p) => { Object.assign(job, p); this.changed(job, true); }); // playlist video list changed

    runner.start().then((r) => {
      if (r && r.paused) {
        job.status = 'paused';
      } else {
        job.status = 'done';
        job.file = r.file;
        if (r.size != null) { job.size = r.size; job.downloaded = r.size; }
        if (r.count != null) { job.playlistDone = r.count; job.playlistSkipped = r.skipped || 0; }
        job.speed = 0; job.eta = 0;
        job.finishedAt = Date.now();
        this.dropSecrets(job);
        fs.rm(this.workPath(job), { recursive: true, force: true }, () => {});
      }
    }).catch((err) => {
      if (runner.userPaused) { job.status = 'paused'; return; }
      if (err && err.code === 'MDM_WEBPAGE') return; // handled by switch below
      job.status = 'error';
      job.error = err && err.message ? err.message : String(err);
      job.speed = 0;
    }).finally(() => {
      if (this.runners.get(job.id) === runner) this.runners.delete(job.id);
      this.cleanupCookies(job);
      runner.emit('settled');
      this.emit('runner-finished', job.id);
      if (job._switchToYtdlp) {
        delete job._switchToYtdlp;
        job.kind = 'ytdlp'; job.target = null; job.status = 'queued';
      }
      this.changed(job, true);
      this.pump();
    });
  }

  makeRunner(job) {
    const cfg = this.config;
    const tools = this.tools();
    const dirFor = (name) => job.dir || this.suggestDir(job, name);
    const headers = { ...job.headers };
    if (job.userAgent) headers['user-agent'] = job.userAgent;
    if (job.referrer) headers.referer = job.referrer;

    const workDir = this.workDirFor(job);
    if (job.kind === 'ytdlp') {
      let cookiesFile = null;
      if (job.cookies && job.cookies.length) cookiesFile = writeCookiesFile(path.join(this.dataDir, 'cookies', job.id + '.txt'), job.cookies);
      const opts = {
        url: job.url, dir: job.dir || this.suggestDir(job),
        // "Save As" name from the dialog (% is yt-dlp's template sign, so it is doubled)
        outTemplate: job.customName && !job.playlist ? job.customName.replace(/%/g, '%%') + '.%(ext)s' : undefined,
        ytdlp: tools.ytdlp, ffmpeg: tools.ffmpeg, format: job.format, maxHeight: job.maxHeight, audioOnly: job.audioOnly,
        cookiesFile, referer: job.referrer, userAgent: job.userAgent,
        rateLimit: cfg.speedLimitKBps ? cfg.speedLimitKBps * 1024 : 0,
        fragments: Math.min(job.connections || 4, 16),
        // fast path (media.js): our multi-connection engine downloads what yt-dlp finds
        fast: cfg.fastVideo !== false && !job.format,
        limiter: this.limiter,
        connections: job.connections || cfg.connections,
        cookieFor: (u) => cookieHeader(job.cookies, u),
        workDir,
      };
      // Playlists: video by video, so each one can be watched, skipped or re-ordered
      if (job.playlist) return new PlaylistDownload(job, opts);
      return opts.fast ? new MediaDownload(opts) : new YtdlpDownload(opts);
    }

    if (job.kind === 'torrent') {
      return new TorrentDownload({
        url: job.url, dir: dirFor(job.filename || ''), aria2: tools.aria2, connections: job.connections || cfg.connections,
        speedLimit: cfg.speedLimitKBps ? cfg.speedLimitKBps * 1024 : 0,
      });
    }

    const cookie = cookieHeader(job.cookies, job.url);
    if (cookie) headers.cookie = cookie;

    if (job.kind === 'hls') {
      return new HlsDownload({
        url: job.url, dir: dirFor('x.mp4'), target: job.target, filename: job.filename, headers,
        concurrency: job.connections || cfg.hlsConcurrency, maxHeight: job.maxHeight, ffmpeg: tools.ffmpeg, limiter: this.limiter,
        workDir,
      });
    }

    // direct: we only know the real file name after probing, so resolve the folder lazily
    const seg = new SegmentedDownload({
      url: job.url, dir: cfg.downloadDir, target: job.target, filename: job.filename, headers,
      connections: job.connections || cfg.connections, limiter: this.limiter,
      workDir,
    });
    const origStart = seg.start.bind(seg);
    seg.start = async () => {
      if (!job.target) {
        const { probe } = require('./probe');
        const info = await probe(job.url, { headers });
        if (info.contentType === 'text/html' && !job.filename) {
          if (!tools.ytdlp) throw new Error('This link is a web page, not a file. Install yt-dlp to grab videos from pages, or use the browser extension to capture the media link.');
          job._switchToYtdlp = true;
          job.log.push('Link is a web page; handing over to yt-dlp');
          const e = new Error('web page'); e.code = 'MDM_WEBPAGE'; throw e;
        }
        seg.o.dir = dirFor(job.filename || info.filename);
      }
      if (seg.userPaused) return { paused: true }; // paused while probing
      return origStart();
    };
    return seg;
  }

  // --- persistence / events --------------------------------------------------------
  changed(job, important = false) {
    this.emit('job', publicJob(job));
    const now = Date.now();
    if (important || now - (this.lastPersist || 0) > 3000) { this.lastPersist = now; this.persist(); }
  }

  persist() { writeJson(this.jobsPath, [...this.jobs.values()].map(({ segments, ...j }) => j)); }

  /** Cookies/headers are only kept while a job is unfinished. */
  dropSecrets(job) {
    job.cookies = null;
    job.headers = {};
    this.cleanupCookies(job);
  }

  cleanupCookies(job) {
    fs.rmSync(path.join(this.dataDir, 'cookies', job.id + '.txt'), { force: true });
  }

  shutdown() {
    clearInterval(this.scheduler);
    for (const r of this.runners.values()) r.pause();
    this.persist();
  }
}

function publicJob(j) {
  const { cookies, headers, ...rest } = j;
  return { ...rest, hasCookies: !!(cookies && cookies.length) };
}

/** Build a Cookie header from extension cookies that match the URL (domain + path + secure). */
function cookieHeader(cookies, url) {
  if (!cookies || !cookies.length) return null;
  const u = new URL(url);
  const host = u.hostname;
  const pairs = cookies.filter((c) => {
    const d = String(c.domain || '').replace(/^\./, '');
    const domainOk = c.hostOnly ? host === d : host === d || host.endsWith('.' + d);
    const pathOk = u.pathname.startsWith(c.path || '/');
    const secureOk = !c.secure || u.protocol === 'https:';
    return domainOk && pathOk && secureOk;
  }).map((c) => `${c.name}=${c.value}`);
  return pairs.length ? pairs.join('; ') : null;
}

function sanitizeHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h)) {
    if (/^[a-z0-9-]+$/i.test(k) && !/^(host|content-length|range|if-range|connection)$/i.test(k)) out[k.toLowerCase()] = String(v).slice(0, 8192);
  }
  return out;
}

/** youtube.com/playlist?list=... is always a whole playlist (a watch?v=...&list=... link is one video unless asked). */
function isPlaylistPage(url) {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/playlist' && u.searchParams.has('list');
  } catch { return false; }
}

/** Quality choices for a whole playlist (each video gets the closest it has). */
const PLAYLIST_QUALITIES = [
  { value: 'best', label: 'Best available' }, { value: '1080', label: 'HD 1080p' }, { value: '720', label: 'HD 720p' },
  { value: '480', label: '480p' }, { value: '360', label: '360p' }, { value: 'audio', label: 'Audio only (MP3)' },
];

/**
 * Quality choices for one video from yt-dlp's format list: one per resolution (short side, so a
 * 720x1280 reel is "720p"), with the size that will actually be downloaded (H.264 + audio).
 */
function qualityOptions(formats = []) {
  const audios = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
  const audio = audios.filter((f) => /m4a|mp4/.test(f.ext || '')).sort((a, b) => (b.size || 0) - (a.size || 0))[0] ||
    audios.sort((a, b) => (b.size || 0) - (a.size || 0))[0] || null;
  const byRes = new Map();
  for (const f of formats) {
    if (!f.height || f.vcodec === 'none') continue;
    const p = f.width ? Math.min(f.width, f.height) : f.height;
    const h264 = /avc|h264/i.test(f.vcodec || '');
    const muxed = !!(f.acodec && f.acodec !== 'none');
    const prev = byRes.get(p);
    if (!prev || (h264 && !prev.h264) || (h264 === prev.h264 && (f.size || 0) > (prev.size || 0))) byRes.set(p, { p, fps: f.fps, size: f.size, h264, muxed, id: f.id, probed: !!f.probed });
  }
  const out = [{ value: 'best', label: 'Best available' }];
  for (const o of [...byRes.values()].sort((a, b) => b.p - a.p).slice(0, 8)) {
    const tag = o.p >= 2160 ? '4K ' : o.p >= 1440 ? '2K ' : o.p >= 720 ? 'HD ' : '';
    out.push({ value: o.probed && /^[\w.-]{1,40}$/.test(o.id || '') ? `${o.p}:${o.id}` : String(o.p), label: `${tag}${o.p}p${o.fps > 30 ? ' ' + Math.round(o.fps) + 'fps' : ''}`, size: o.size ? o.size + (o.muxed || !audio ? 0 : audio.size || 0) : null });
  }
  out.push({ value: 'audio', label: 'Audio only (MP3)', size: audio ? audio.size || null : null });
  return out;
}

/** Queue order: lower `order` first (older jobs without one fall back to when they were added). */
function byOrder(a, b) {
  return (a.order ?? a.createdAt) - (b.order ?? b.createdAt) || a.createdAt - b.createdAt;
}

function clampInt(v, min, max) { return Math.min(max, Math.max(min, Math.round(Number(v) || min))); }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, data) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, p); }

module.exports = { Manager, cookieHeader, DEFAULT_CONFIG };
