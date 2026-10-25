'use strict';
/**
 * Download scheduler (IDM: Scheduler / "Download later" queue).
 *
 *  - Jobs added with "Later" wait in status 'scheduled'.
 *  - At the start time (on the chosen days) they all move to the queue and download.
 *  - Optional stop time: anything still downloading is paused and put back in the schedule.
 *  - When the scheduled downloads are finished (or the stop time is reached) the chosen
 *    action runs: nothing / sleep / hibernate / restart / shut down, after a 60-second
 *    countdown that can be cancelled from the app window or the tray icon.
 */
const { EventEmitter } = require('node:events');
const power = require('./power');

// concurrent = "Download N files at the same time" for the scheduled queue (IDM default style)
const DEFAULT_SCHEDULE = { enabled: false, start: '02:00', stop: '', days: [], after: 'none', concurrent: 2 };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ACTIVE = ['queued', 'starting', 'downloading'];

const minutes = (hhmm) => { const m = HHMM.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

class Scheduler extends EventEmitter {
  /**
   * @param {import('./manager').Manager} manager
   * @param {object} [o]  test hooks: now(), perform(action), countdownMs, tickMs
   */
  constructor(manager, { now = () => new Date(), perform = power.perform, countdownMs = 60_000, tickMs = 15_000 } = {}) {
    super();
    this.m = manager;
    this.now = now;
    this.perform = perform;
    this.countdownMs = countdownMs;
    this.pending = null;     // { action, at }
    this.lastAction = null;  // { action, at, ok, error }
    this.run = manager.config.scheduleRun || null; // survives an app restart
    this.wasIn = false; // app opened inside the start window → start (catches a PC that woke up late)
    manager.on('runner-finished', () => this.checkFinished());
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
    setImmediate(() => this.tick());
  }

  get cfg() { return { ...DEFAULT_SCHEDULE, ...(this.m.config.schedule || {}) }; }

  update(patch = {}) {
    const c = this.cfg;
    if ('enabled' in patch) c.enabled = !!patch.enabled;
    if ('start' in patch) { if (minutes(patch.start) == null) throw new Error('Start time must look like 02:00'); c.start = patch.start; }
    if ('stop' in patch) { if (patch.stop && minutes(patch.stop) == null) throw new Error('Stop time must look like 07:00 (or empty)'); c.stop = patch.stop || ''; }
    if ('days' in patch) c.days = [...new Set((patch.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
    if ('after' in patch) { if (!(patch.after in power.ACTIONS)) throw new Error('Unknown action'); c.after = patch.after; }
    if ('concurrent' in patch) {
      const n = Math.round(Number(patch.concurrent));
      if (!(n >= 1 && n <= 20)) throw new Error('"Download N at the same time" must be between 1 and 20');
      c.concurrent = n;
    }
    if (c.stop && c.stop === c.start) throw new Error('Stop time must be different from the start time');
    this.m.config.schedule = c;
    this.m.saveConfig();
    this.wasIn = this.inWindow(this.now()); // a new schedule starts at its next start time, not immediately
    this.m.pump(); // a higher "N at the same time" starts more right away
    this.emit('status', this.status());
    return this.status();
  }

  dayOk(day) { const d = this.cfg.days; return !d.length || d.includes(day); }

  /** Is `date` inside the download window? Handles windows that cross midnight (23:00 → 07:00). */
  inWindow(date) {
    const c = this.cfg;
    if (!c.enabled) return false;
    const n = date.getHours() * 60 + date.getMinutes();
    const s = minutes(c.start);
    // No stop time: the start can still trigger up to 1 hour late (PC was asleep/off at the exact
    // minute); once started, downloads run until finished. Without this limit, opening the app in
    // the afternoon would start tonight's "Later" downloads immediately.
    const e = c.stop ? minutes(c.stop) : (s + 60) % 1440;
    const day = date.getDay();
    if (s < e) return this.dayOk(day) && n >= s && n < e;
    if (n >= s) return this.dayOk(day);                   // overnight window, evening part
    if (n < e) return this.dayOk((day + 6) % 7);          // overnight window, morning part (started yesterday)
    return false;
  }

  /** Next start time (ms) or null. */
  nextStart() {
    const c = this.cfg;
    if (!c.enabled) return null;
    const now = this.now();
    const s = minutes(c.start);
    for (let i = 0; i <= 7; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, Math.floor(s / 60), s % 60, 0, 0);
      if (d > now && this.dayOk(d.getDay())) return d.getTime();
    }
    return null;
  }

  tick() {
    const inW = this.inWindow(this.now());
    if (inW && !this.wasIn) this.startRun('schedule');
    else if (inW && this.run) this.adoptWaiting(); // "Later" jobs added while the window is open
    if (!inW && this.wasIn && this.run && this.cfg.stop) this.stopRun('stop-time');
    this.wasIn = inW;
    this.checkFinished();
  }

  /** Waiting "Later" jobs in queue order (the order you arranged with ↑ ↓ or drag). */
  waiting() {
    return [...this.m.jobs.values()].filter((j) => j.status === 'scheduled')
      .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
  }

  adoptWaiting() {
    let n = 0;
    for (const j of this.waiting()) {
      j.status = 'queued'; j.scheduleRun = this.run.id; this.m.changed(j, true); n++;
    }
    if (n) { this.run.count += n; this.saveRun(); this.m.pump(); }
    return n;
  }

  /** Start the scheduled downloads now (at the start time, or from the "Start now" button). */
  startRun(reason = 'manual') {
    if (this.run) return this.adoptWaiting();
    const waiting = this.waiting();
    if (!waiting.length) { this.emit('status', this.status()); return 0; }
    this.run = { id: Date.now(), startedAt: Date.now(), reason, count: 0 };
    this.adoptWaiting();
    this.emit('status', this.status());
    return this.run.count;
  }

  /** Stop time reached (or "Stop" pressed): pause what is still running and put it back in the schedule. */
  stopRun(reason = 'manual') {
    const run = this.run;
    if (!run) return;
    for (const j of this.m.jobs.values()) {
      if (j.scheduleRun !== run.id || !ACTIVE.includes(j.status)) continue;
      const back = () => { j.status = 'scheduled'; j.scheduled = true; this.m.changed(j, true); };
      const r = this.m.runners.get(j.id);
      if (r) { r.once('settled', back); r.pause(); } else back();
    }
    this.run = null;
    this.saveRun();
    this.emit('status', this.status());
    if (reason === 'stop-time') this.armAction(run); // the scheduled time is over
  }

  checkFinished() {
    const run = this.run;
    if (!run) return;
    const left = [...this.m.jobs.values()].some((j) => j.scheduleRun === run.id && ACTIVE.includes(j.status));
    if (left) return;
    this.run = null;
    this.saveRun();
    this.emit('status', this.status());
    this.armAction(run);
  }

  saveRun() { this.m.config.scheduleRun = this.run; this.m.saveConfig(); }

  armAction(run) {
    const action = this.cfg.after;
    if (!run || !run.count || action === 'none' || this.pending) return;
    this.pending = { action, label: power.ACTIONS[action], at: Date.now() + this.countdownMs };
    this.actionTimer = setTimeout(() => this.fire(), this.countdownMs);
    this.emit('status', this.status());
  }

  cancelAction() {
    clearTimeout(this.actionTimer);
    const had = !!this.pending;
    this.pending = null;
    if (had) this.lastAction = { action: 'cancelled', at: Date.now(), ok: true, error: null };
    this.emit('status', this.status());
    return this.status();
  }

  async fire() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.emit('status', this.status());
    const r = await this.perform(p.action);
    this.lastAction = { action: p.action, at: Date.now(), ok: r.ok, error: r.error || null };
    this.emit('status', this.status());
  }

  status() {
    const runJobs = this.run ? [...this.m.jobs.values()].filter((j) => j.scheduleRun === this.run.id) : [];
    return {
      ...this.cfg,
      running: !!this.run,
      runDone: runJobs.filter((j) => !ACTIVE.includes(j.status)).length,
      runTotal: runJobs.length,
      waiting: this.waiting().length,
      nextStart: this.nextStart(),
      pendingAction: this.pending,
      lastAction: this.lastAction,
      actions: power.ACTIONS,
    };
  }

  stop() { clearInterval(this.timer); clearTimeout(this.actionTimer); }
}

module.exports = { Scheduler, DEFAULT_SCHEDULE };
