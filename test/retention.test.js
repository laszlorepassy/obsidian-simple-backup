'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { BackupRun } = require('../backup-core');
const { mkTmpDir, makeBackupDir, listDirNames, rmDir } = require('./helpers');

function makeRun(targetRoot, opts) {
  return new BackupRun(Object.assign({
    sourceDir: targetRoot, // unused by applyRetention
    targetRoot,
    vaultName: 'Vault',
    exclude: [],
    keepDaily: 0,
    keepWeekly: 0,
    keepMonthly: 0,
  }, opts));
}

test('keeps only the N most recent distinct days when only keepDaily is set', async () => {
  const dir = await mkTmpDir();
  try {
    // 5 backups, one per day, most recent first: day 5 (kept), 4 (kept), 3, 2, 1 (deleted)
    await makeBackupDir(dir, 'Vault', [2024, 1, 1, 20, 0]);
    await makeBackupDir(dir, 'Vault', [2024, 1, 2, 20, 0]);
    await makeBackupDir(dir, 'Vault', [2024, 1, 3, 20, 0]);
    await makeBackupDir(dir, 'Vault', [2024, 1, 4, 20, 0]);
    const newest = await makeBackupDir(dir, 'Vault', [2024, 1, 5, 20, 0]);

    const run = makeRun(dir, { keepDaily: 2 });
    const deleted = await run.applyRetention('Vault-');

    assert.deepEqual(deleted.sort(), ['Vault-2024-01-01-2000', 'Vault-2024-01-02-2000', 'Vault-2024-01-03-2000']);
    const remaining = await listDirNames(dir);
    assert.deepEqual(remaining, ['Vault-2024-01-04-2000', 'Vault-2024-01-05-2000']);
    assert.ok(remaining.includes(newest));
  } finally {
    await rmDir(dir);
  }
});

test('with keepDaily=1, only the latest backup of the day survives, even with several runs the same day', async () => {
  const dir = await mkTmpDir();
  try {
    await makeBackupDir(dir, 'Vault', [2024, 1, 5, 8, 0]);
    await makeBackupDir(dir, 'Vault', [2024, 1, 5, 14, 0]);
    const newest = await makeBackupDir(dir, 'Vault', [2024, 1, 5, 20, 0]);

    const run = makeRun(dir, { keepDaily: 1 });
    const deleted = await run.applyRetention('Vault-');

    assert.deepEqual(deleted.sort(), ['Vault-2024-01-05-0800', 'Vault-2024-01-05-1400']);
    assert.deepEqual(await listDirNames(dir), [newest]);
  } finally {
    await rmDir(dir);
  }
});

test('the just-created (most recent) snapshot is always kept even if all keep-counts are 0', async () => {
  const dir = await mkTmpDir();
  try {
    await makeBackupDir(dir, 'Vault', [2024, 1, 1, 20, 0]);
    const newest = await makeBackupDir(dir, 'Vault', [2024, 1, 2, 20, 0]);

    const run = makeRun(dir, { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 });
    const deleted = await run.applyRetention('Vault-');

    assert.deepEqual(deleted, ['Vault-2024-01-01-2000']);
    assert.deepEqual(await listDirNames(dir), [newest]);
  } finally {
    await rmDir(dir);
  }
});

test('weekly rule keeps a backup from an earlier week outside the daily window (union semantics)', async () => {
  const dir = await mkTmpDir();
  try {
    // Two backups three weeks apart, one per week. keepDaily=1 alone would only
    // keep the newest; keepWeekly=2 should additionally save the older one.
    const older = await makeBackupDir(dir, 'Vault', [2024, 1, 1, 20, 0]); // Monday, ISO week 2024-W01
    const newer = await makeBackupDir(dir, 'Vault', [2024, 1, 15, 20, 0]); // Monday, ISO week 2024-W03

    const run = makeRun(dir, { keepDaily: 1, keepWeekly: 2, keepMonthly: 0 });
    const deleted = await run.applyRetention('Vault-');

    assert.deepEqual(deleted, []);
    assert.deepEqual((await listDirNames(dir)).sort(), [older, newer].sort());
  } finally {
    await rmDir(dir);
  }
});

test('monthly rule keeps one backup per month beyond the daily/weekly window', async () => {
  const dir = await mkTmpDir();
  try {
    const jan = await makeBackupDir(dir, 'Vault', [2024, 1, 10, 20, 0]);
    const feb = await makeBackupDir(dir, 'Vault', [2024, 2, 10, 20, 0]);
    const mar = await makeBackupDir(dir, 'Vault', [2024, 3, 10, 20, 0]);

    const run = makeRun(dir, { keepDaily: 1, keepWeekly: 0, keepMonthly: 3 });
    const deleted = await run.applyRetention('Vault-');

    assert.deepEqual(deleted, []);
    assert.deepEqual((await listDirNames(dir)).sort(), [jan, feb, mar].sort());
  } finally {
    await rmDir(dir);
  }
});

test('a backup with no completion marker is left alone and does not count as the latest', async () => {
  const dir = await mkTmpDir();
  try {
    const complete = await makeBackupDir(dir, 'Vault', [2024, 1, 1, 20, 0]);
    // This one is "newer" by name/date but never finished copying.
    const incomplete = await makeBackupDir(dir, 'Vault', [2024, 1, 2, 20, 0], { complete: false });

    const run = makeRun(dir, { keepDaily: 5, keepWeekly: 5, keepMonthly: 5 });
    const deleted = await run.applyRetention('Vault-');

    assert.deepEqual(deleted, []);
    assert.deepEqual((await listDirNames(dir)).sort(), [complete, incomplete].sort());
  } finally {
    await rmDir(dir);
  }
});

test('directories belonging to a different vault name are never touched', async () => {
  const dir = await mkTmpDir();
  try {
    await makeBackupDir(dir, 'Vault', [2024, 1, 1, 20, 0]);
    const other = await makeBackupDir(dir, 'OtherVault', [2024, 1, 1, 20, 0]);
    const newest = await makeBackupDir(dir, 'Vault', [2024, 1, 2, 20, 0]);

    const run = makeRun(dir, { keepDaily: 0, keepWeekly: 0, keepMonthly: 0 });
    const deleted = await run.applyRetention('Vault-');

    assert.deepEqual(deleted, ['Vault-2024-01-01-2000']);
    assert.deepEqual((await listDirNames(dir)).sort(), [newest, other].sort());
  } finally {
    await rmDir(dir);
  }
});

test('deleting a stale backup asks fs.rm to retry on transient errors (EBUSY/ENOTEMPTY from an AV/indexer/sync client on a network drive)', async () => {
  const dir = await mkTmpDir();
  try {
    const older = await makeBackupDir(dir, 'Vault', [2024, 1, 1, 20, 0]);
    await makeBackupDir(dir, 'Vault', [2024, 1, 2, 20, 0]);

    const fs = require('fs');
    const realRm = fs.promises.rm;
    let capturedOpts = null;
    fs.promises.rm = (p, opts) => {
      capturedOpts = opts;
      return realRm(p, opts);
    };

    let deleted;
    try {
      const run = makeRun(dir, { keepDaily: 1 });
      deleted = await run.applyRetention('Vault-');
    } finally {
      fs.promises.rm = realRm;
    }

    assert.deepEqual(deleted, [older]);
    // Without maxRetries, fs.rm never retries a recursive delete on ENOTEMPTY/EBUSY/EPERM,
    // so a single transient lock (e.g. AV briefly holding a file open on a network drive)
    // aborts the delete partway through -- removing the completion marker but leaving the
    // rest of the folder behind, which then hides it from every future retention run.
    assert.ok(capturedOpts && capturedOpts.maxRetries >= 1, 'fs.rm must be called with maxRetries so transient locks are retried instead of aborting the delete');
    assert.ok(capturedOpts && capturedOpts.retryDelay >= 1, 'fs.rm must be called with a retryDelay backoff between retries');
  } finally {
    await rmDir(dir);
  }
});

test('a long history is pruned to exactly the daily+weekly+monthly union, nothing more nothing less', async () => {
  const dir = await mkTmpDir();
  try {
    // One backup a day for 40 days, most recent = day 40 = 2024-02-09.
    const names = [];
    const start = new Date(2024, 0, 1, 20, 0); // Jan 1
    for (let i = 0; i < 40; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      names.push(await makeBackupDir(dir, 'Vault', [d.getFullYear(), d.getMonth() + 1, d.getDate(), 20, 0]));
    }

    const run = makeRun(dir, { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
    await run.applyRetention('Vault-');

    const remaining = new Set(await listDirNames(dir));

    // Independently recompute the expected keep-set the same way the plugin describes it
    // (latest per day for the last 7 distinct days / latest per ISO week for the last 4 weeks /
    // latest per month for the last 6 months), then assert the filesystem matches exactly.
    const { parseBackupDate, isoWeekKey, pad } = require('../backup-core');
    const parsed = names.map((n) => ({ name: n, date: parseBackupDate(n, 'Vault-') }))
      .sort((a, b) => b.date - a.date);
    const expectedKeep = new Set([parsed[0].name]);
    const addTop = (keyFn, limit) => {
      const seen = new Set();
      for (const b of parsed) {
        const k = keyFn(b.date);
        if (!seen.has(k)) {
          seen.add(k);
          if (seen.size <= limit) expectedKeep.add(b.name);
        }
      }
    };
    addTop((d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), 7);
    addTop((d) => isoWeekKey(d), 4);
    addTop((d) => d.getFullYear() + '-' + pad(d.getMonth() + 1), 6);

    assert.deepEqual(remaining, expectedKeep);
    assert.ok(remaining.size < names.length, 'retention should have deleted something out of 40 daily backups');
  } finally {
    await rmDir(dir);
  }
});
