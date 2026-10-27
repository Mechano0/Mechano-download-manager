'use strict';
/**
 * "Play while downloading": copies the part of a video/music file that is already downloaded
 * from the start (the first connection's piece) into data\preview\, and opens it in your player.
 * Videos from YouTube & co. come as a picture file + a sound file: both beginnings are joined
 * into one .mkv with ffmpeg (copy only, a second or two). The download itself is not touched.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MIN_BYTES = 512 * 1024;
const PLAYABLE = new Set(['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'ts', 'mpg', 'mpeg', '3gp', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma']);

/** Bytes downloaded without a gap from the start, from a segment table. */
function prefixOf(segments) {
  const first = (segments || []).find((s) => s.start === 0);
  return first ? Math.max(0, Math.min(first.pos, isFinite(first.end) ? first.end + 1 : first.pos)) : 0;
}

/** Where the bytes are: [{ file, bytes, ext, video }] for a running or paused download. */
function sourcesFor(job, runner) {
  const extOf = (f) => path.extname(String(f || '').replace(/\.mdmpart$/, '')).slice(1).toLowerCase();
  if (job.status === 'done' && job.file && fs.existsSync(job.file)) return [{ file: job.file, bytes: Infinity, ext: extOf(job.file), whole: true }];
  // fast video path (media.js): one SegmentedDownload per format
  if (runner && Array.isArray(runner.parts) && runner.parts.length) {
    return runner.parts.map((p) => {
      const ext = extOf(p.target);
      if (!p.seg && fs.existsSync(p.target)) return { file: p.target, bytes: Infinity, ext, video: !!p.video, whole: true };
      return { file: p.seg ? p.seg.part : p.target + '.mdmpart', bytes: p.seg ? prefixOf(p.seg.segments) : 0, ext, video: !!p.video };
    });
  }
  // one multi-connection file (running or paused)
  if (runner && runner.part && runner.segments) return [{ file: runner.part, bytes: prefixOf(runner.segments), ext: extOf(runner.target || job.target) }];
  if (job.target && fs.existsSync(job.target + '.mdmpart')) {
    try {
      const st = JSON.parse(fs.readFileSync(job.target + '.mdmpart.json', 'utf8'));
      return [{ file: job.target + '.mdmpart', bytes: prefixOf(st.segments), ext: extOf(job.target) }];
    } catch { /* no table yet */ }
  }
  return [];
}

async function copyPrefix(src, dest, bytes) {
  if (bytes === Infinity) { await fsp.copyFile(src, dest); return; }
  await new Promise((resolve, reject) => {
    fs.createReadStream(src, { start: 0, end: bytes - 1 }).on('error', reject)
      .pipe(fs.createWriteStream(dest)).on('error', reject).on('finish', resolve);
  });
}

function ffmpeg(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg: ' + (err.trim().split(/\r?\n/).pop() || 'failed')))));
  });
}

/**
 * Makes the preview file and returns its path. `open` (default true) starts the Windows player.
 * @param {{ job: object, runner?: object, dataDir: string, ffmpeg?: string, open?: boolean }} o
 */
async function makePreview({ job, runner, dataDir, ffmpeg: ffmpegExe, open = true }) {
  const src = sourcesFor(job, runner).filter((s) => s.whole || s.bytes > 0);
  if (!src.length) throw new Error('Nothing to play yet. Wait until the first part is downloaded.');
  if (!src.every((s) => PLAYABLE.has(s.ext))) throw new Error('Only video and music files can be played while downloading.');
  if (src.some((s) => !s.whole && s.bytes < MIN_BYTES)) throw new Error('Not enough is downloaded yet. Try again in a few seconds.');
  const dir = path.join(dataDir, 'preview');
  await fsp.mkdir(dir, { recursive: true });
  // keep only the newest previews
  for (const f of await fsp.readdir(dir)) if (!f.startsWith(job.id)) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
  let out;
  if (src.length === 1) {
    out = path.join(dir, `${job.id}-preview.${src[0].ext}`);
    await copyPrefix(src[0].file, out, src[0].bytes);
  } else {
    if (!ffmpegExe) throw new Error('ffmpeg is needed to play a video while it downloads.');
    const tmp = [];
    for (const [i, s] of src.entries()) { const t = path.join(dir, `${job.id}-p${i}.${s.ext}`); await copyPrefix(s.file, t, s.bytes); tmp.push(t); }
    const v = src.findIndex((s) => s.video), a = v === 0 ? 1 : 0;
    out = path.join(dir, `${job.id}-preview.mkv`);
    try {
      await ffmpeg(ffmpegExe, ['-i', tmp[v < 0 ? 0 : v], '-i', tmp[a], '-map', '0:v:0?', '-map', '1:a:0?', '-c', 'copy', '-f', 'matroska', out]);
    } finally { for (const t of tmp) await fsp.rm(t, { force: true }).catch(() => {}); }
  }
  if (open && process.platform === 'win32') spawn('explorer.exe', [out], { detached: true, windowsHide: false }).unref();
  return out;
}

module.exports = { makePreview, prefixOf, sourcesFor };
