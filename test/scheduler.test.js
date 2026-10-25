'use strict';
// Scheduler rules with a fake clock and a fake power action: nothing really sleeps or shuts down.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Manager } = require('../src/manager');
const { Scheduler } = require('../src/scheduler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Manager whose downloads are simulated: run() marks jobs downloading; finish() completes them. */
function setup(schedule, startAt = new Date(2026, 9, 22, 1, 0)) { // Thu 22 Oct 2026, 01:00
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdm-sch-'));
  const m = new Manager(dataDir);
  clearInterval(m.scheduler);
  m.run = (job) => { job.status = 'downloading'; m.runners.set(job.id, Object.assign(new (require('node:events').EventEmitter)(), { pause() { job.status = 'paused'; m.runners.delete(job.id); this.emit('settled'); } })); };
  const finish = (job) => { job.status = 'done'; m.runners.delete(job.id); m.emit('runner-finished', job.id); };
  let now = startAt;
  const actions = [];
  const s = new Scheduler(m, { now: () => now, perform: async (a) => { actions.push(a); return { ok: true }; }, countdownMs: 40, tickMs: 1e9 });
  if (schedule) s.update(schedule);
  const at = (h, min, dayOffset = 0) => { now = new Date(2026, 9, 22 + dayOffset, h, min); s.tick(); };
  return { m, s, finish, actions, at };
}

test('"Later" downloads wait until the start time, then all start', () => {
  const { m, s, at } = setup({ enabled: true, start: '02:00' });
  const a = m.add({ url: 'https://example.com/a.zip', scheduled: true });
  const b = m.add({ url: 'https://example.com/b.zip', scheduled: true });
  assert.equal(m.get(a.id).status, 'scheduled', 'not started at once');
  at(1, 59);
  assert.equal(m.get(a.id).status, 'scheduled');
  at(2, 0);
  assert.equal(m.get(a.id).status, 'downloading');
  assert.equal(m.get(b.id).status, 'downloading');
  assert.equal(s.status().running, true);
  s.stop(); m.shutdown();
});

test('after the scheduled downloads finish, the chosen action runs after the countdown', async () => {
  const { m, s, at, finish, actions } = setup({ enabled: true, start: '02:00', after: 'shutdown' });
  const a = m.add({ url: 'https://example.com/a.zip', scheduled: true });
  at(2, 0);
  finish(m.get(a.id));
  assert.equal(s.status().pendingAction.action, 'shutdown', 'countdown started');
  assert.deepEqual(actions, [], 'not before the countdown ends');
  await sleep(80);
  assert.deepEqual(actions, ['shutdown']);
  s.stop(); m.shutdown();
});

test('Cancel during the countdown keeps the computer on', async () => {
  const { m, s, at, finish, actions } = setup({ enabled: true, start: '02:00', after: 'sleep' });
  const a = m.add({ url: 'https://example.com/a.zip', scheduled: true });
  at(2, 0);
  finish(m.get(a.id));
  s.cancelAction();
  await sleep(80);
  assert.deepEqual(actions, [], 'cancelled: nothing happened');
  s.stop(); m.shutdown();
});

test('stop time pauses unfinished downloads, puts them back in the schedule, then runs the action', async () => {
  const { m, s, at, actions } = setup({ enabled: true, start: '02:00', stop: '06:00', after: 'hibernate' });
  const a = m.add({ url: 'https://example.com/a.zip', scheduled: true });
  at(2, 0);
  assert.equal(m.get(a.id).status, 'downloading');
  at(6, 0);
  assert.equal(m.get(a.id).status, 'scheduled', 'waits for the next start');
  await sleep(80);
  assert.deepEqual(actions, ['hibernate']);
  s.stop(); m.shutdown();
});

test('only on the chosen days', () => {
  const { m, s, at } = setup({ enabled: true, start: '02:00', days: [5] }); // Friday only; today is Thursday
  const a = m.add({ url: 'https://example.com/a.zip', scheduled: true });
  at(2, 0);
  assert.equal(m.get(a.id).status, 'scheduled', 'Thursday: no start');
  assert.equal(new Date(s.status().nextStart).getDay(), 5, 'next start is Friday');
  at(2, 0, 1); // Friday 02:00
  assert.equal(m.get(a.id).status, 'downloading');
  s.stop(); m.shutdown();
});

test('overnight window (23:00 → 07:00) and opening the app later does not start early', () => {
  const night = setup({ enabled: true, start: '23:00', stop: '07:00' }, new Date(2026, 9, 22, 12, 0));
  assert.equal(night.s.inWindow(new Date(2026, 9, 22, 23, 30)), true);
  assert.equal(night.s.inWindow(new Date(2026, 9, 23, 3, 0)), true, '03:00 next morning still inside');
  assert.equal(night.s.inWindow(new Date(2026, 9, 23, 8, 0)), false);
  night.s.stop(); night.m.shutdown();

  const day = setup({ enabled: true, start: '02:00' }, new Date(2026, 9, 22, 15, 0));
  const a = day.m.add({ url: 'https://example.com/a.zip', scheduled: true });
  day.at(15, 0);
  assert.equal(day.m.get(a.id).status, 'scheduled', 'afternoon: waits for 02:00 tomorrow');
  day.s.stop(); day.m.shutdown();
});

test('queue order: ↑ ↓ / drag change which file downloads first', () => {
  const { m, s } = setup({ enabled: true, start: '02:00' });
  const [a, b, c] = ['a', 'b', 'c'].map((n) => m.add({ url: `https://example.com/${n}.zip`, scheduled: true }));
  const names = () => s.waiting().map((j) => j.url.slice(-5, -4));
  assert.deepEqual(names(), ['a', 'b', 'c']);
  m.move(c.id, 'up');
  assert.deepEqual(names(), ['a', 'c', 'b']);
  m.move(a.id, 'down');
  assert.deepEqual(names(), ['c', 'a', 'b']);
  m.move(b.id, 0); // dragged to the top
  assert.deepEqual(names(), ['b', 'c', 'a']);
  m.move(b.id, 'up'); // already first: stays
  assert.deepEqual(names(), ['b', 'c', 'a']);
  s.stop(); m.shutdown();
});

test('"Download N files at the same time": the next one starts when one finishes, in queue order', () => {
  const { m, s, at, finish } = setup({ enabled: true, start: '02:00', concurrent: 2 });
  const jobs = ['a', 'b', 'c', 'd'].map((n) => m.add({ url: `https://example.com/${n}.zip`, scheduled: true }));
  m.move(jobs[3].id, 0); // d first
  at(2, 0);
  const st = () => jobs.map((j) => m.get(j.id).status);
  assert.deepEqual(st(), ['downloading', 'queued', 'queued', 'downloading'], 'only 2 at a time: d and a');
  finish(m.get(jobs[3].id));
  m.pump();
  assert.deepEqual(st(), ['downloading', 'downloading', 'queued', 'done'], 'b starts when d finishes');
  s.update({ concurrent: 3 });
  assert.equal(m.get(jobs[2].id).status, 'downloading', 'raising the number starts more right away');
  s.stop(); m.shutdown();
});

test('no action when nothing was scheduled, and "Start now" works any time', async () => {
  const { m, s, at, actions } = setup({ enabled: true, start: '02:00', after: 'shutdown' });
  at(2, 0); // window opens with nothing waiting
  await sleep(80);
  assert.deepEqual(actions, [], 'never shut down for an empty schedule');
  const a = m.add({ url: 'https://example.com/a.zip', scheduled: true });
  s.startRun('manual');
  assert.equal(m.get(a.id).status, 'downloading');
  s.stop(); m.shutdown();
});
