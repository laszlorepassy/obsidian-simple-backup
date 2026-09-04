#!/usr/bin/env node
'use strict';

/**
 * Backup script that runs in a separate, low-priority process.
 * Arguments: <sourceDir> <targetRoot> <vaultName> <configJson> <logFilePath>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch (e) {
  // platform doesn't support it, not a problem
}

const [sourceDir, targetRoot, vaultName, configJson, logFilePath] = process.argv.slice(2);

let config = {};
try { config = JSON.parse(configJson || '{}'); } catch (e) { config = {}; }

const EXCLUDE = new Set(config.exclude || []);
const KEEP_DAILY = Number.isFinite(config.keepDaily) ? config.keepDaily : 7;
const KEEP_WEEKLY = Number.isFinite(config.keepWeekly) ? config.keepWeekly : 4;
const KEEP_MONTHLY = Number.isFinite(config.keepMonthly) ? config.keepMonthly : 6;

const RETRIES = 3;
const RETRY_WAIT_MS = 800;

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function send(msg) {
  if (process.connected && typeof process.send === 'function') {
    try { process.send(msg); } catch (e) { /* the parent process may already be gone */ }
  }
}

const stats = { dirs: 0, files: 0, bytes: 0, skipped: 0, errors: [] };
const targetRootResolved = targetRoot ? path.resolve(targetRoot) : null;
let totalFiles = 0;

function countFiles(srcDir) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) continue;

    const from = path.join(srcDir, entry.name);
    if (targetRootResolved && path.resolve(from) === targetRootResolved) continue;
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      count += countFiles(from);
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

function copyFileWithRetry(src, dest, size) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      try {
        const st = fs.statSync(src);
        fs.utimesSync(dest, st.atime, st.mtime);
      } catch (e) { /* not critical */ }
      stats.files++;
      stats.bytes += size;
      return;
    } catch (err) {
      if (attempt >= RETRIES) {
        stats.errors.push(src + '  ->  ' + err.message);
        return;
      }
      sleep(RETRY_WAIT_MS * attempt);
    }
  }
}

function copyTree(srcDir, destDir) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    stats.errors.push(srcDir + '  ->  ' + err.message);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  stats.dirs++;

  for (const entry of entries) {
    if (EXCLUDE.has(entry.name)) { stats.skipped++; continue; }

    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);

    if (targetRootResolved && path.resolve(from) === targetRootResolved) { stats.skipped++; continue; }

    if (entry.isSymbolicLink()) {
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch (e) {
        stats.skipped++;
      }
      continue;
    }

    if (entry.isDirectory()) {
      copyTree(from, to);
      continue;
    }

    if (entry.isFile()) {
      let size = 0;
      try { size = fs.statSync(from).size; } catch (e) { /* doesn't matter */ }
      copyFileWithRetry(from, to, size);
      if (stats.files % 25 === 0) {
        send({ type: 'progress', files: stats.files, total: totalFiles, bytes: stats.bytes });
      }
    }
  }
}

function parseBackupDate(name, prefix) {
  const rest = name.slice(prefix.length);
  const m = rest.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return date.getUTCFullYear() + '-W' + pad(week);
}

function applyRetention(prefix) {
  const deleted = [];
  let entries;
  try {
    entries = fs.readdirSync(targetRoot, { withFileTypes: true });
  } catch (err) {
    stats.errors.push(targetRoot + '  ->  ' + err.message);
    return deleted;
  }

  const backups = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => ({ name: e.name, date: parseBackupDate(e.name, prefix) }))
    .filter((b) => b.date instanceof Date && !isNaN(b.date));

  backups.sort((a, b) => b.date - a.date);
  if (backups.length === 0) return deleted;

  // The snapshot that was just created is always kept, regardless of the retention counts.
  const keep = new Set([backups[0].name]);

  function keepLatestPerGroup(keyFn, limit) {
    const seen = new Set();
    for (const b of backups) {
      const key = keyFn(b.date);
      if (!seen.has(key)) {
        seen.add(key);
        if (seen.size <= limit) keep.add(b.name);
      }
    }
  }

  keepLatestPerGroup((d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), KEEP_DAILY);
  keepLatestPerGroup((d) => isoWeekKey(d), KEEP_WEEKLY);
  keepLatestPerGroup((d) => d.getFullYear() + '-' + pad(d.getMonth() + 1), KEEP_MONTHLY);

  for (const b of backups) {
    if (!keep.has(b.name)) {
      try {
        fs.rmSync(path.join(targetRoot, b.name), { recursive: true, force: true });
        deleted.push(b.name);
      } catch (err) {
        stats.errors.push(path.join(targetRoot, b.name) + '  ->  ' + err.message);
      }
    }
  }

  return deleted;
}

function writeErrorLog(target) {
  if (!stats.errors.length) return;
  const lines = [];
  lines.push('=== ' + new Date().toISOString() + ' ===');
  lines.push('Target: ' + target);
  for (const e of stats.errors) lines.push('  - ' + e);
  lines.push('');
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* if even this fails, there's nothing more we can do */ }
}

function main() {
  if (!sourceDir || !targetRoot || !vaultName) {
    send({ type: 'error', message: 'Missing parameters for the backup process.' });
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(sourceDir)) {
    send({ type: 'error', message: 'The source vault folder was not found: ' + sourceDir });
    process.exitCode = 1;
    return;
  }

  try {
    fs.mkdirSync(targetRoot, { recursive: true });
  } catch (err) {
    send({ type: 'error', message: 'The target directory could not be created: ' + err.message });
    process.exitCode = 1;
    return;
  }

  const prefix = vaultName + '-';
  const target = path.join(targetRoot, prefix + stamp());

  if (fs.existsSync(target)) {
    send({ type: 'error', message: 'The target folder already exists: ' + target });
    process.exitCode = 1;
    return;
  }

  totalFiles = countFiles(sourceDir);
  send({ type: 'progress', files: 0, total: totalFiles, bytes: 0 });

  copyTree(sourceDir, target);
  const deleted = applyRetention(prefix);
  writeErrorLog(target);

  send({
    type: 'done',
    files: stats.files,
    dirs: stats.dirs,
    bytes: stats.bytes,
    skipped: stats.skipped,
    errors: stats.errors,
    deleted,
    target,
  });

  process.exitCode = stats.errors.length ? 2 : 0;
}

main();
