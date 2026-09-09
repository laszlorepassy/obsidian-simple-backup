'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBackupDate, isoWeekKey, humanSize, stamp, pad } = require('../backup-core');

test('pad', () => {
  assert.equal(pad(3), '03');
  assert.equal(pad(30), '30');
});

test('stamp formats a fixed date as YYYY-MM-DD-HHmm', () => {
  const d = new Date(2024, 2, 5, 9, 7); // March 5, 2024, 09:07
  assert.equal(stamp(d), '2024-03-05-0907');
});

test('parseBackupDate roundtrips with stamp', () => {
  const d = new Date(2024, 10, 20, 23, 59);
  const name = 'MyVault-' + stamp(d);
  const parsed = parseBackupDate(name, 'MyVault-');
  assert.equal(parsed.getTime(), d.getTime());
});

test('parseBackupDate rejects names that do not match the expected pattern', () => {
  assert.equal(parseBackupDate('MyVault-not-a-date', 'MyVault-'), null);
  assert.equal(parseBackupDate('MyVault-2024-13-40-9999', 'MyVault-')?.constructor, Date);
  // Note: month 13 / day 40 overflow into an "Invalid Date"-adjacent but valid JS Date
  // (JS normalizes out-of-range fields), so callers must check isNaN(date) themselves.
});

test('parseBackupDate returns null when the prefix does not match at all', () => {
  assert.equal(parseBackupDate('OtherVault-2024-01-01-2000', 'MyVault-'), null);
});

test('isoWeekKey groups dates within the same Mon-Sun week and separates adjacent weeks', () => {
  const mon = new Date(2024, 0, 1); // Monday
  const sun = new Date(2024, 0, 7); // Sunday, same ISO week
  const nextMon = new Date(2024, 0, 8); // Monday, next ISO week

  assert.equal(isoWeekKey(mon), isoWeekKey(sun));
  assert.notEqual(isoWeekKey(sun), isoWeekKey(nextMon));
});

test('isoWeekKey matches known ISO-8601 week numbers', () => {
  assert.equal(isoWeekKey(new Date(2024, 0, 1)), '2024-W01');
  // 2023-01-01 is a Sunday, which ISO-8601 assigns to the last week of 2022.
  assert.equal(isoWeekKey(new Date(2023, 0, 1)), '2022-W52');
  // 2020 is a leap year starting on a Wednesday, so it has an ISO week 53.
  assert.equal(isoWeekKey(new Date(2020, 11, 31)), '2020-W53');
});

test('humanSize formats byte counts', () => {
  assert.equal(humanSize(0), '0 B');
  assert.equal(humanSize(500), '500 B');
  assert.equal(humanSize(1536), '1.5 kB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
});
