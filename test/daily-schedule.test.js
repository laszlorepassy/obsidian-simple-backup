'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyScheduleDecision, DAILY_RETRY_DELAY_MS, DAILY_MAX_RETRIES } = require('../backup-core');

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

test('fires exactly at dailyTime on a fresh day, without marking the day done before the backup succeeds', () => {
  const decision = dailyScheduleDecision(baseSettings(), new Date(2024, 0, 1, 20, 0));
  assert.deepEqual(decision, { run: true, lastDailyRunDate: null });
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
  assert.deepEqual(decision, { run: true, lastDailyRunDate: null });
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
  assert.deepEqual(decision, { run: true, lastDailyRunDate: null });
});

test('a failed daily backup is retried after the retry delay, not on the very next tick', () => {
  const failedAt = new Date(2024, 0, 1, 20, 0);
  const retry = { date: '2024-01-01', failures: 1, lastAttempt: failedAt.getTime() };

  const soon = dailyScheduleDecision(baseSettings(), new Date(2024, 0, 1, 20, 1), retry);
  assert.equal(soon.run, false);

  const later = dailyScheduleDecision(baseSettings(), new Date(failedAt.getTime() + DAILY_RETRY_DELAY_MS), retry);
  assert.equal(later.run, true);
});

test('gives up for the day after DAILY_MAX_RETRIES retries', () => {
  const retry = { date: '2024-01-01', failures: DAILY_MAX_RETRIES + 1, lastAttempt: new Date(2024, 0, 1, 20, 0).getTime() };
  const decision = dailyScheduleDecision(baseSettings(), new Date(2024, 0, 1, 23, 59), retry);
  assert.equal(decision.run, false);
});

test('yesterday\'s failed attempts do not hold back today\'s backup', () => {
  const retry = { date: '2023-12-31', failures: DAILY_MAX_RETRIES + 1, lastAttempt: new Date(2023, 11, 31, 23, 50).getTime() };
  const decision = dailyScheduleDecision(baseSettings(), new Date(2024, 0, 1, 20, 0), retry);
  assert.equal(decision.run, true);
});

test('an invalid saved dailyTime falls back to the default instead of never firing', () => {
  // "24:00" sorts after every real HH:MM, so it used to silently disable the schedule.
  const decision = dailyScheduleDecision(baseSettings({ dailyTime: '24:00' }), new Date(2024, 0, 1, 20, 0));
  assert.equal(decision.run, true);
});
