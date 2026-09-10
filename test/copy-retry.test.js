'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { BackupRun } = require('../backup-core');
const { mkTmpDir, rmDir } = require('./helpers');

function makeRun(extra) {
  return new BackupRun(Object.assign({
    sourceDir: '.', // unused by copyFileWithRetry directly
    targetRoot: '.',
    vaultName: 'Vault',
  }, extra));
}

test('copyFileWithRetry never calls fs.copyFile with the real destination path (each attempt uses a fresh temp path, moved into place only via rename)', async () => {
  // Regression test: the previous implementation called fsp.copyFile(src, dest) directly.
  // withTimeout() cannot cancel that in-flight copy, so on a timeout a retry re-invoking
  // fsp.copyFile(src, dest) would race the still-running first attempt on the SAME path,
  // risking a corrupted destination file. Every attempt must target a unique temp path.
  const dir = await mkTmpDir();
  try {
    const src = path.join(dir, 'src.txt');
    await fsp.writeFile(src, 'hello world', 'utf8');
    const dest = path.join(dir, 'dest.txt');

    const realCopyFile = fs.promises.copyFile;
    const calledPaths = [];
    let callCount = 0;
    fs.promises.copyFile = async (s, d) => {
      callCount++;
      calledPaths.push(d);
      if (callCount === 1) throw Object.assign(new Error('simulated transient failure'), { code: 'EBUSY' });
      return realCopyFile(s, d);
    };

    let run;
    try {
      run = makeRun();
      await run.copyFileWithRetry(src, dest, 11);
    } finally {
      fs.promises.copyFile = realCopyFile;
    }

    assert.equal(calledPaths.length, 2, 'expected one failed attempt and one successful retry');
    assert.ok(calledPaths.every((p) => p !== dest), 'fs.copyFile must never be called with the final destination path directly');
    assert.notEqual(calledPaths[0], calledPaths[1], 'each attempt must use its own unique temp path');

    assert.equal(await fsp.readFile(dest, 'utf8'), 'hello world');
    assert.equal(run.stats.files, 1);
    assert.equal(run.stats.errors.length, 0);

    const leftovers = (await fsp.readdir(dir)).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no leftover temp files should remain after a successful copy');
  } finally {
    await rmDir(dir);
  }
});

test('copyFileWithRetry never creates a partial/garbage destination file when every attempt fails', async () => {
  const dir = await mkTmpDir();
  try {
    const src = path.join(dir, 'does-not-exist.txt');
    const dest = path.join(dir, 'dest.txt');

    const run = makeRun();
    await run.copyFileWithRetry(src, dest, 0);

    assert.equal(run.stats.errors.length, 1);
    assert.ok(run.stats.errors[0].includes(src));

    const entries = await fsp.readdir(dir);
    assert.deepEqual(entries, [], 'dest.txt and any temp file must not exist after every attempt fails');
  } finally {
    await rmDir(dir);
  }
});
