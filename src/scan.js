'use strict';
/**
 * Virus check after a download: Microsoft Defender's command-line scanner (MpCmdRun.exe) scans the new
 * file (or folder). If it finds something, Defender removes it the usual way (quarantine) and the
 * job shows "Threat found". Nothing is uploaded by us; Defender works with its own settings.
 *
 * config.scanDownloads: 'risky' (programs, archives, documents, other files — the default),
 *                       'all' (also video, music and pictures), 'off'.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { categorize } = require('./util');

const SKIP_WHEN_RISKY = new Set(['Video', 'Music', 'Images']);

/** Newest MpCmdRun.exe: Defender's platform folder first (kept up to date), then Program Files. */
function findScanner(env = process.env) {
  const candidates = [];
  const platform = path.join(env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
  try {
    const versions = fs.readdirSync(platform).filter((d) => /^\d+\.\d+/.test(d))
      .sort((a, b) => compareVersions(b, a));
    for (const v of versions) candidates.push(path.join(platform, v, 'MpCmdRun.exe'));
  } catch { /* no platform folder */ }
  candidates.push(path.join(env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe'));
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Should this finished job be scanned with the given setting? */
function shouldScan(job, mode) {
  if (mode === 'off' || !job || !job.file) return false;
  if (mode === 'all') return true;
  if (job.kind === 'torrent') return true; // folders from torrents can hold anything
  if (job.playlist) return false;          // a folder of videos
  return !SKIP_WHEN_RISKY.has(categorize(job.file));
}

/** MpCmdRun result → { state: 'clean' | 'threat' | 'failed', detail }. Exit 0 = clean, 2 = threat found. */
function interpret(code, output) {
  const text = String(output || '');
  if (code === 0) return { state: 'clean', detail: null };
  if (code === 2) {
    const names = [...text.matchAll(/^\s*Threat\s*:\s*(.+)$/gim)].map((m) => m[1].trim());
    return { state: 'threat', detail: names.length ? [...new Set(names)].join(', ') : 'Microsoft Defender found a threat' };
  }
  const line = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
  return { state: 'failed', detail: line ? line.slice(0, 200) : `Scanner exit code ${code}` };
}

/** Scan one file or folder. Resolves { state, detail } and never rejects. */
function scanPath(target, { scanner = findScanner(), timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !scanner) return resolve({ state: 'skipped', detail: 'Only on Windows' });
    if (!scanner) return resolve({ state: 'skipped', detail: 'Microsoft Defender is not available (another antivirus may be in charge)' });
    if (!target || !fs.existsSync(target)) return resolve({ state: 'failed', detail: 'The file is not on the disk' });
    let out = '';
    let child;
    try {
      child = spawn(scanner, ['-Scan', '-ScanType', '3', '-File', target], { windowsHide: true });
    } catch (e) { return resolve({ state: 'failed', detail: e.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 64 * 1024) out = out.slice(-32 * 1024); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ state: 'failed', detail: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(interpret(code, out)); });
  });
}

module.exports = { findScanner, shouldScan, interpret, scanPath, compareVersions };
