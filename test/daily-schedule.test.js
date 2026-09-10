'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyScheduleDecision } = require('../backup-core');

function baseSettings(overrides) {
  return Object.assign({
    runDaily: true,
    dailyTime: '20:00',
    lastDailyRunDate: null,
    lastRun: null,
  }, overrides);
}

test('does nothing when runDaily is off', () => {
  const decision = dailyScheduleDecision(baseSettings({ runDaily: false }), new Date(2024, 0, 1, 20, 0));
  assert.deepEqual(decision, { run: false, lastDailyRunDate: null });
});

test('fires exactly at dailyTime on a fresh day', () => {
  const decision = dailyScheduleDecision(baseSettings(), new Date(2024, 0, 1, 20, 0));
  assert.deepEqual(decision, { run: true, lastDailyRunDate: '2024-01-01' });
});

test('does not fire again later the same day once lastDailyRunDate is recorded', () => {
  const settings = baseSettings({ lastDailyRunDate: '2024-01-01' });
  const decision = dailyScheduleDecision(settings, new Date(2024, 0, 1, 20, 5));
  assert.deepEqual(decision, { run: false, lastDailyRunDate: '2024-01-01' });
});

test('catches up if the exact minute was missed (sleep, closed app, a slow tick)', () => {
  // Old behaviour required an exact HH:MM match, so waking up at 20:07 after
  // sleeping through 20:00 meant the daily backup silently never ran that day.
  const decision = dailyScheduleDecision(baseSettings(), new Date(2024, 0, 1, 20, 7));
  assert.deepEqual(decision, { run: true, lastDailyRunDate: '2024-01-01' });
});

test('does not fire before dailyTime has arrived yet', () => {
  const decision = dailyScheduleDecision(baseSettings(), new Date(2024, 0, 1, 19, 59));
  assert.deepEqual(decision, { run: false, lastDailyRunDate: null });
});

test('a backup from another trigger earlier today satisfies the daily requirement without running again', () => {
  // Otherwise runOnStartup:true + dailyTime in the past (e.g. opening Obsidian
  // in the evening) would fire a redundant second full-vault backup every day.
  const settings = baseSettings({
    lastRun: { time: new Date(2024, 0, 1, 9, 0).getTime(), trigger: 'startup' },
  });
  const decision = dailyScheduleDecision(settings, new Date(2024, 0, 1, 20, 0));
  assert.deepEqual(decision, { run: false, lastDailyRunDate: '2024-01-01' });
});

test('a lastRun from yesterday does not suppress today\'s catch-up run', () => {
  const settings = baseSettings({
    lastRun: { time: new Date(2023, 11, 31, 21, 0).getTime(), trigger: 'startup' },
  });
  const decision = dailyScheduleDecision(settings, new Date(2024, 0, 1, 20, 0));
  assert.deepEqual(decision, { run: true, lastDailyRunDate: '2024-01-01' });
});
