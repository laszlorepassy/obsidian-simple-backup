'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { BackupRun, copyFileWithStallTimeout } = require('../backup-core');
const { mkTmpDir, rmDir } = require('./helpers');

function makeRun(extra) {
  return new BackupRun(Object.assign({
    sourceDir: '.', // unused by copyFileWithRetry directly
    targetRoot: '.',
    vaultName: 'Vault',
  }, extra));
}

test('copyFileWithRetry never copies onto the real destination path (each attempt uses a fresh temp path, moved into place only via rename)', async () => {
  // Regression test: an early implementation copied straight onto dest. A stalled
  // attempt's write can linger in the OS after it's abandoned, so a retry on the
  // SAME path could race it and corrupt the file. Every attempt must target a
  // unique temp path.
  const dir = await mkTmpDir();
  try {
    const src = path.join(dir, 'src.txt');
    await fsp.writeFile(src, 'hello world', 'utf8');
    const dest = path.join(dir, 'dest.txt');

    const calledPaths = [];
    const run = makeRun();
    const realCopyOnce = run.copyFileOnce.bind(run);
    run.copyFileOnce = async (s, d) => {
      calledPaths.push(d);
      if (calledPaths.length === 1) throw Object.assign(new Error('simulated transient failure'), { code: 'EBUSY' });
      return realCopyOnce(s, d);
    };
    await run.copyFileWithRetry(src, dest, 11);

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

// Swaps fs.createReadStream for a source that emits `chunks` one every `everyMs`,
// then either ends or (with hang: true) goes silent forever.
async function withFakeSource({ chunks, everyMs, hang }, fn) {
  const real = fs.createReadStream;
  fs.createReadStream = () => {
    let sent = 0;
    let timer;
    return new Readable({
      read() {
        timer = setTimeout(() => {
          if (sent < chunks) { sent++; this.push(Buffer.alloc(1024, 'x')); } else if (!hang) this.push(null);
        }, everyMs);
      },
      destroy(err, cb) { clearTimeout(timer); cb(err); },
    });
  };
  try { return await fn(); } finally { fs.createReadStream = real; }
}

test('a slow copy that keeps making progress is not cut off, however long it takes in total', async () => {
  // The old limit was 60s for the whole file, so any file too big to copy in a
  // minute (a video on a network drive) could never be backed up.
  const dir = await mkTmpDir();
  try {
    const dest = path.join(dir, 'out.bin');
    const started = Date.now();
    await withFakeSource({ chunks: 10, everyMs: 30 }, () => copyFileWithStallTimeout('ignored', dest, 100));
    assert.ok(Date.now() - started > 200, 'total time should well exceed the stall timeout');
    assert.equal((await fsp.stat(dest)).size, 10 * 1024);
  } finally {
    await rmDir(dir);
  }
});

test('a copy that stops making progress is abandoned and its temp file removed', async () => {
  const dir = await mkTmpDir();
  try {
    const dest = path.join(dir, 'out.bin');
    await withFakeSource({ chunks: 2, everyMs: 10, hang: true }, () =>
      assert.rejects(copyFileWithStallTimeout('ignored', dest, 100), /No progress/));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await fsp.readdir(dir), []);
  } finally {
    await rmDir(dir);
  }
});

test('copyFileWithStallTimeout copies a real file byte for byte', async () => {
  const dir = await mkTmpDir();
  try {
    const src = path.join(dir, 'src.bin');
    const data = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    await fsp.writeFile(src, data);
    await copyFileWithStallTimeout(src, path.join(dir, 'dest.bin'), 1000);
    assert.ok(data.equals(await fsp.readFile(path.join(dir, 'dest.bin'))));
  } finally {
    await rmDir(dir);
  }
});
