'use strict';
/**
 * What to do with the computer after the scheduled downloads finish (IDM: "When done: shut down…").
 * Windows only. Every action is preceded by a cancellable countdown in the Scheduler.
 */
const { spawn } = require('node:child_process');

const ACTIONS = {
  none: 'Do nothing',
  sleep: 'Sleep',
  hibernate: 'Hibernate',
  restart: 'Restart',
  shutdown: 'Shut down',
};

function run(cmd, args) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, detached: true }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    let err = '';
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, error: code === 0 ? null : (err.trim() || `exit code ${code}`) }));
  });
}

// SetSuspendState via .NET: "rundll32 powrprof.dll,SetSuspendState" hibernates instead of sleeping
// on PCs where hibernation is on, so we use the documented API instead.
const suspend = (mode) => ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState('${mode}', $false, $false)) { exit 1 }`];

/** Perform the action now. Returns { ok, error }. */
async function perform(action) {
  if (process.platform !== 'win32') return { ok: false, error: 'Power actions are only supported on Windows' };
  const msg = 'Mechano Download Manager: scheduled downloads finished';
  switch (action) {
    case 'shutdown': return run('shutdown', ['/s', '/t', '5', '/c', msg]);
    case 'restart': return run('shutdown', ['/r', '/t', '5', '/c', msg]);
    case 'sleep': return run('powershell.exe', suspend('Suspend'));
    case 'hibernate': {
      const r = await run('powershell.exe', suspend('Hibernate'));
      return r.ok ? r : { ok: false, error: 'Hibernate failed. Hibernation may be turned off on this PC (powercfg /hibernate on).' };
    }
    default: return { ok: true, error: null };
  }
}

module.exports = { perform, ACTIONS };
