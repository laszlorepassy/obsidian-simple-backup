'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { BackupRun, COMPLETE_MARKER } = require('../backup-core');
const { mkTmpDir, rmDir } = require('./helpers');

async function makeFakeVault(root) {
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fsp.writeFile(path.join(root, 'note.md'), 'hello world', 'utf8');
  await fsp.writeFile(path.join(root, 'sub', 'inner.md'), 'inner note', 'utf8');
  await fsp.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'should be excluded', 'utf8');
}

test('run() copies files, excludes configured entries, and writes a completion marker', async () => {
  const root = await mkTmpDir();
  try {
    const source = path.join(root, 'vault');
    const target = path.join(root, 'target');
    await makeFakeVault(source);

    const run = new BackupRun({
      sourceDir: source,
      targetRoot: target,
      vaultName: 'Vault',
      exclude: ['node_modules'],
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 6,
      logFilePath: path.join(root, 'backup-errors.log'),
    });

    const result = await run.run();

    assert.equal(result.files, 2);
    assert.equal(result.errors.length, 0);
    assert.ok(await fileExists(path.join(result.target, 'note.md')));
    assert.ok(await fileExists(path.join(result.target, 'sub', 'inner.md')));
    assert.ok(!(await fileExists(path.join(result.target, 'node_modules'))));
    assert.ok(await fileExists(path.join(result.target, COMPLETE_MARKER)));
  } finally {
    await rmDir(root);
  }
});

test('run() throws when the source vault directory does not exist', async () => {
  const root = await mkTmpDir();
  try {
    const run = new BackupRun({
      sourceDir: path.join(root, 'does-not-exist'),
      targetRoot: path.join(root, 'target'),
      vaultName: 'Vault',
      exclude: [],
    });
    await assert.rejects(() => run.run(), /source vault folder was not found/);
  } finally {
    await rmDir(root);
  }
});

test('a real run() prunes a pre-existing older backup once keepDaily is exceeded', async () => {
  const root = await mkTmpDir();
  try {
    const source = path.join(root, 'vault');
    const target = path.join(root, 'target');
    await makeFakeVault(source);

    // Plant a "yesterday" backup, already complete, before running the real backup.
    const { makeBackupDir } = require('./helpers');
    const yesterday = new Date(Date.now() - 86400000);
    const oldName = await makeBackupDir(target, 'Vault', [
      yesterday.getFullYear(), yesterday.getMonth() + 1, yesterday.getDate(), 1, 0,
    ]);

    const result = await new BackupRun({
      sourceDir: source,
      targetRoot: target,
      vaultName: 'Vault',
      exclude: ['node_modules'],
      keepDaily: 1,
      keepWeekly: 0,
      keepMonthly: 0,
      logFilePath: path.join(root, 'backup-errors.log'),
    }).run();

    assert.deepEqual(result.deleted, [oldName]);
    const remaining = (await fsp.readdir(target, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    assert.deepEqual(remaining, [path.basename(result.target)]);
  } finally {
    await rmDir(root);
  }
});

async function fileExists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
