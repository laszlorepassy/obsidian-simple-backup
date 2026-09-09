'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { COMPLETE_MARKER } = require('../backup-core');

async function mkTmpDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix || 'obsidian-backup-test-'));
}

function pad(n) { return String(n).padStart(2, '0'); }

function stampFor(y, mo, d, h, mi) {
  return `${y}-${pad(mo)}-${pad(d)}-${pad(h)}${pad(mi)}`;
}

/** Creates <targetRoot>/<vaultName>-<y-mo-d-hhmi>, optionally marked complete. */
async function makeBackupDir(targetRoot, vaultName, [y, mo, d, h, mi], { complete = true } = {}) {
  const name = `${vaultName}-${stampFor(y, mo, d, h, mi)}`;
  const dir = path.join(targetRoot, name);
  await fsp.mkdir(dir, { recursive: true });
  if (complete) {
    await fsp.writeFile(path.join(dir, COMPLETE_MARKER), new Date().toISOString(), 'utf8');
  }
  return name;
}

async function listDirNames(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function rmDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

module.exports = { mkTmpDir, stampFor, makeBackupDir, listDirNames, rmDir };
