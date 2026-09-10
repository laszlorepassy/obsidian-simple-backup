'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const RETRIES = 3;
const RETRY_WAIT_MS = 800;
const COMPLETE_MARKER = '.backup-complete';
const COPY_TIMEOUT_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  targetDir: '',
  runOnStartup: true,
  runHourly: false,
  runDaily: true,
  dailyTime: '20:00',
  keepDaily: 7,
  keepWeekly: 4,
  keepMonthly: 6,
  excludeList: ['node_modules', '.git', '.trash', '.DS_Store', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information'],
  lastRun: null,
  lastDailyRunDate: null,
};

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + '-' + pad(d.getHours()) + pad(d.getMinutes());
}

function humanSize(bytes) {
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out after ' + ms + 'ms: ' + label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

async function pathExists(p) {
  try { await fsp.access(p); return true; } catch (e) { return false; }
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Decides whether the daily schedule should fire "now". Pure function (no I/O,
 * no Date.now() inside) so the scheduling logic can be unit-tested without a
 * live timer or the Obsidian runtime.
 *
 * Catches up (fires as soon as the current time passes dailyTime) instead of
 * requiring an exact HH:MM match, so a missed minute (sleep, Obsidian closed,
 * a slow tick) doesn't skip the whole day. But if a backup from any trigger
 * (startup/manual/hourly) already completed today, that satisfies the daily
 * requirement instead of firing a second full backup.
 */
function dailyScheduleDecision(settings, now) {
  if (!settings.runDaily) return { run: false, lastDailyRunDate: settings.lastDailyRunDate };

  const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  if (settings.lastDailyRunDate === today) return { run: false, lastDailyRunDate: settings.lastDailyRunDate };

  if (settings.lastRun && settings.lastRun.time && isSameLocalDay(new Date(settings.lastRun.time), now)) {
    return { run: false, lastDailyRunDate: today };
  }

  const hhmm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  if (hhmm >= settings.dailyTime) {
    return { run: true, lastDailyRunDate: today };
  }

  return { run: false, lastDailyRunDate: settings.lastDailyRunDate };
}

/**
 * Runs one backup: copies sourceDir into a dated snapshot under targetRoot,
 * then applies the daily/weekly/monthly retention policy. Every filesystem
 * call is async (fs.promises), so the actual I/O happens on Node's libuv
 * thread pool instead of Obsidian's main thread -- the UI never blocks,
 * with no separate OS process needed to achieve that.
 */
class BackupRun {
  constructor(opts) {
    this.sourceDir = opts.sourceDir;
    this.targetRoot = opts.targetRoot;
    this.targetRootResolved = path.resolve(opts.targetRoot);
    this.vaultName = opts.vaultName;
    this.exclude = new Set(opts.exclude || []);
    this.keepDaily = Number.isFinite(opts.keepDaily) ? opts.keepDaily : 7;
    this.keepWeekly = Number.isFinite(opts.keepWeekly) ? opts.keepWeekly : 4;
    this.keepMonthly = Number.isFinite(opts.keepMonthly) ? opts.keepMonthly : 6;
    this.logFilePath = opts.logFilePath;
    this.onProgress = opts.onProgress || (() => {});
    this.stats = { dirs: 0, files: 0, bytes: 0, skipped: 0, errors: [] };
    this.totalFiles = 0;
  }

  async countFiles(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return 0;
    }

    let count = 0;
    for (const entry of entries) {
      if (this.exclude.has(entry.name)) continue;
      const from = path.join(dir, entry.name);
      if (path.resolve(from) === this.targetRootResolved) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) count += await this.countFiles(from);
      else if (entry.isFile()) count++;
    }
    return count;
  }

  async copyFileWithRetry(src, dest, size) {
    for (let attempt = 1; ; attempt++) {
      // Copy to a per-attempt temp path and rename into place on success. withTimeout()
      // can't actually cancel the underlying fsp.copyFile -- on timeout the write may still
      // be in flight -- so copying straight to `dest` risks a retry's copyFile racing the
      // timed-out one on the very same path and leaving a corrupted file. A unique temp
      // path per attempt means a still-running timed-out copy can never collide with dest.
      const tmpDest = dest + '.tmp-' + process.pid + '-' + Date.now() + '-' + attempt;
      try {
        await withTimeout(fsp.copyFile(src, tmpDest), COPY_TIMEOUT_MS, src);
        try {
          const st = await fsp.stat(src);
          await fsp.utimes(tmpDest, st.atime, st.mtime);
        } catch (e) { /* not critical */ }
        await fsp.rename(tmpDest, dest);
        this.stats.files++;
        this.stats.bytes += size;
        return;
      } catch (err) {
        try { await fsp.unlink(tmpDest); } catch (e) { /* best effort; may still be in use */ }
        if (attempt >= RETRIES) {
          this.stats.errors.push(src + '  ->  ' + err.message);
          return;
        }
        await sleep(RETRY_WAIT_MS * attempt);
      }
    }
  }

  async copyTree(srcDir, destDir) {
    let entries;
    try {
      entries = await fsp.readdir(srcDir, { withFileTypes: true });
    } catch (err) {
      this.stats.errors.push(srcDir + '  ->  ' + err.message);
      return;
    }

    await fsp.mkdir(destDir, { recursive: true });
    this.stats.dirs++;

    for (const entry of entries) {
      if (this.exclude.has(entry.name)) { this.stats.skipped++; continue; }

      const from = path.join(srcDir, entry.name);
      const to = path.join(destDir, entry.name);

      if (path.resolve(from) === this.targetRootResolved) { this.stats.skipped++; continue; }

      if (entry.isSymbolicLink()) {
        try {
          await fsp.symlink(await fsp.readlink(from), to);
        } catch (e) {
          this.stats.skipped++;
        }
        continue;
      }

      if (entry.isDirectory()) {
        await this.copyTree(from, to);
        continue;
      }

      if (entry.isFile()) {
        let size = 0;
        try { size = (await fsp.stat(from)).size; } catch (e) { /* doesn't matter */ }
        await this.copyFileWithRetry(from, to, size);
        this.onProgress({ files: this.stats.files, total: this.totalFiles, bytes: this.stats.bytes });
      }
    }
  }

  async applyRetention(prefix) {
    const deleted = [];
    let entries;
    try {
      entries = await fsp.readdir(this.targetRoot, { withFileTypes: true });
    } catch (err) {
      this.stats.errors.push(this.targetRoot + '  ->  ' + err.message);
      return deleted;
    }

    const backups = [];
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
      const date = parseBackupDate(e.name, prefix);
      if (!(date instanceof Date) || isNaN(date)) continue;
      // Only manage backups that finished copying. A folder from a run that
      // crashed or was interrupted mid-copy has no marker and is left
      // untouched, so it never gets mistaken for "the latest good snapshot"
      // and never displaces a genuinely complete older backup.
      const complete = await pathExists(path.join(this.targetRoot, e.name, COMPLETE_MARKER));
      if (!complete) continue;
      backups.push({ name: e.name, date });
    }

    backups.sort((a, b) => b.date - a.date);
    if (backups.length === 0) return deleted;

    // The snapshot that was just created is always kept, regardless of the retention counts.
    const keep = new Set([backups[0].name]);

    const keepLatestPerGroup = (keyFn, limit) => {
      const seen = new Set();
      for (const b of backups) {
        const key = keyFn(b.date);
        if (!seen.has(key)) {
          seen.add(key);
          if (seen.size <= limit) keep.add(b.name);
        }
      }
    };

    keepLatestPerGroup((d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), this.keepDaily);
    keepLatestPerGroup((d) => isoWeekKey(d), this.keepWeekly);
    keepLatestPerGroup((d) => d.getFullYear() + '-' + pad(d.getMonth() + 1), this.keepMonthly);

    for (const b of backups) {
      if (!keep.has(b.name)) {
        try {
          // maxRetries/retryDelay make fs.rm retry on ENOTEMPTY/EBUSY/EPERM: on
          // network drives an AV/indexer/sync client can transiently hold a file
          // open mid-delete, and without retries the recursive delete aborts
          // partway -- removing the completion marker but leaving the rest of
          // the tree behind, which then hides the leftover folder from every
          // future retention run.
          await fsp.rm(path.join(this.targetRoot, b.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
          deleted.push(b.name);
        } catch (err) {
          this.stats.errors.push(path.join(this.targetRoot, b.name) + '  ->  ' + err.message);
        }
      }
    }

    return deleted;
  }

  async writeErrorLog(target) {
    if (!this.stats.errors.length) return;
    const lines = [];
    lines.push('=== ' + new Date().toISOString() + ' ===');
    lines.push('Target: ' + target);
    for (const e of this.stats.errors) lines.push('  - ' + e);
    lines.push('');
    try {
      await fsp.mkdir(path.dirname(this.logFilePath), { recursive: true });
      await fsp.appendFile(this.logFilePath, lines.join('\n') + '\n', 'utf8');
    } catch (e) { /* if even this fails, there's nothing more we can do */ }
  }

  async run() {
    if (!(await pathExists(this.sourceDir))) {
      throw new Error('The source vault folder was not found: ' + this.sourceDir);
    }

    await fsp.mkdir(this.targetRoot, { recursive: true });

    const prefix = this.vaultName + '-';
    const target = path.join(this.targetRoot, prefix + stamp());

    if (await pathExists(target)) {
      throw new Error('The target folder already exists: ' + target);
    }

    this.totalFiles = await this.countFiles(this.sourceDir);
    this.onProgress({ files: 0, total: this.totalFiles, bytes: 0 });

    await this.copyTree(this.sourceDir, target);

    try {
      await fsp.writeFile(path.join(target, COMPLETE_MARKER), new Date().toISOString(), 'utf8');
    } catch (err) {
      this.stats.errors.push(target + '  ->  could not write completion marker: ' + err.message);
    }

    const deleted = await this.applyRetention(prefix);
    await this.writeErrorLog(target);

    return {
      files: this.stats.files,
      dirs: this.stats.dirs,
      bytes: this.stats.bytes,
      skipped: this.stats.skipped,
      errors: this.stats.errors,
      deleted,
      target,
    };
  }
}

module.exports = {
  RETRIES,
  RETRY_WAIT_MS,
  COMPLETE_MARKER,
  COPY_TIMEOUT_MS,
  DEFAULT_SETTINGS,
  pad,
  stamp,
  humanSize,
  sleep,
  withTimeout,
  parseBackupDate,
  isoWeekKey,
  pathExists,
  isSameLocalDay,
  dailyScheduleDecision,
  BackupRun,
};
