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

test('a folder the target cannot create costs only that folder, not the whole backup', { skip: process.platform === 'win32' && "the fixture needs a '?' folder name, which Windows cannot create" }, async () => {
  const root = await mkTmpDir();
  const realMkdir = fsp.mkdir;
  try {
    const source = path.join(root, 'vault');
    const target = path.join(root, 'target');
    await makeFakeVault(source);
    await fsp.mkdir(path.join(source, 'bad?name'));
    await fsp.writeFile(path.join(source, 'bad?name', 'x.md'), 'x', 'utf8');

    // Simulate an NTFS/exFAT/SMB target that rejects '?' in names.
    fsp.mkdir = async (p, o) => {
      if (path.basename(p) === 'bad?name') throw Object.assign(new Error('EINVAL: invalid argument'), { code: 'EINVAL' });
      return realMkdir(p, o);
    };
    const result = await new BackupRun({
      sourceDir: source, targetRoot: target, vaultName: 'Vault', exclude: ['node_modules'],
      logFilePath: path.join(root, 'backup-errors.log'),
    }).run();
    fsp.mkdir = realMkdir;

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /bad\?name/);
    assert.ok(await fileExists(path.join(result.target, 'note.md')));
    assert.ok(await fileExists(path.join(result.target, 'sub', 'inner.md')));
    assert.ok(await fileExists(path.join(result.target, COMPLETE_MARKER)));
  } finally {
    fsp.mkdir = realMkdir;
    await rmDir(root);
  }
});

test('a target inside the vault is never copied into its own snapshot, even when reached by a different path', async (t) => {
  const root = await mkTmpDir();
  try {
    const source = path.join(root, 'vault');
    await makeFakeVault(source);
    await fsp.mkdir(path.join(source, '.backups'));
    // The user typed the target through a symlink, so the path differs from
    // the folder copyTree walks into -- like a differently-cased path on Windows.
    try {
      await fsp.symlink(path.join(source, '.backups'), path.join(root, 'link'), 'dir');
    } catch (e) {
      t.skip('cannot create symlinks here');
      return;
    }
    const target = path.join(root, 'link');

    for (let i = 0; i < 2; i++) {
      const run = new BackupRun({ sourceDir: source, targetRoot: target, vaultName: i ? 'Second' : 'First', exclude: ['node_modules'] });
      const result = await run.run();
      assert.equal(result.files, 2);
      assert.ok(!(await fileExists(path.join(result.target, '.backups'))));
    }
  } finally {
    await rmDir(root);
  }
});

test('a run that aborts still writes the errors it collected to the log', async () => {
  const root = await mkTmpDir();
  try {
    const source = path.join(root, 'vault');
    const target = path.join(root, 'target');
    const logFilePath = path.join(root, 'backup-errors.log');
    await makeFakeVault(source);

    const run = new BackupRun({ sourceDir: source, targetRoot: target, vaultName: 'Vault', exclude: [], logFilePath });
    run.stats.errors.push('earlier file error');
    run.applyRetention = async () => { throw new Error('boom'); };

    await assert.rejects(() => run.run(), (err) => err.message === 'boom' && err.logged === true);
    const log = await fsp.readFile(logFilePath, 'utf8');
    assert.match(log, /earlier file error/);
    assert.match(log, /Backup aborted: boom/);
  } finally {
    await rmDir(root);
  }
});

test('a stale completion marker in the vault is not copied and the fresh one is written', async () => {
  const root = await mkTmpDir();
  try {
    const source = path.join(root, 'vault');
    const target = path.join(root, 'target');
    await makeFakeVault(source);
    await fsp.writeFile(path.join(source, COMPLETE_MARKER), 'stale-marker', 'utf8');
    const result = await new BackupRun({
      sourceDir: source, targetRoot: target, vaultName: 'Vault', exclude: ['node_modules'],
      logFilePath: path.join(root, 'backup-errors.log'),
    }).run();
    assert.equal(result.errors.length, 0);
    const marker = await fsp.readFile(path.join(result.target, COMPLETE_MARKER), 'utf8');
    assert.notEqual(marker, 'stale-marker');
  } finally {
    await rmDir(root);
  }
});

test('summarizeErrors shows the first errors and counts the rest', () => {
  const { summarizeErrors } = require('../backup-core');
  const out = summarizeErrors(['a  ->  boom', 'b  ->  bang', 'c', 'd']);
  assert.match(out, /boom/);
  assert.match(out, /\(\+2 more\)/);
});
