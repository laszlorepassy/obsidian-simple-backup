'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pipeline } = require('stream/promises');

const RETRIES = 3;
const RETRY_WAIT_MS = 800;
const COMPLETE_MARKER = '.backup-complete';
// How long a single file copy may go without moving a single byte before it's
// considered hung. Not a limit on the whole copy: a multi-GB video on a slow
// network drive can take many minutes, and that's fine as long as it progresses.
const COPY_STALL_TIMEOUT_MS = 60 * 1000;
const COPY_CHUNK_BYTES = 1024 * 1024;
// After a failed daily backup (e.g. the target drive isn't plugged in), try
// again this much later, at most DAILY_MAX_RETRIES times that day.
const DAILY_RETRY_DELAY_MS = 30 * 60 * 1000;
const DAILY_MAX_RETRIES = 3;

const DEFAULT_SETTINGS = {
  targetDir: '',
  runOnStartup: false,
  runHourly: false,
  runDaily: true,
  dailyTime: '20:00',
  keepDaily: 3,
  keepWeekly: 4,
  keepMonthly: 12,
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

/**
 * Copies src to dest (which must not exist yet), failing if no data moves for
 * stallMs. Unlike racing fsp.copyFile against a timer, a stalled copy is really
 * cancelled: both streams are destroyed, so a retry never competes with a
 * zombie copy of the same file. Reads pause while a slow write catches up
 * (backpressure), so a hung target stalls the reads too and trips the timer.
 */
function copyFileWithStallTimeout(src, dest, stallMs) {
  const ac = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(), stallMs);
  };

  const rs = fs.createReadStream(src, { highWaterMark: COPY_CHUNK_BYTES });
  const ws = fs.createWriteStream(dest, { flags: 'wx' });
  rs.on('data', arm);
  arm();

  const copying = pipeline(rs, ws, { signal: ac.signal });
  // Don't wait for the pipeline to wind down after an abort: a write stuck in
  // the OS may not return for a long time.
  const stalled = new Promise((_, reject) => {
    ac.signal.addEventListener('abort', () => {
      reject(new Error('No progress for ' + Math.round(stallMs / 1000) + 's, gave up: ' + src));
    });
  });

  return Promise.race([copying, stalled]).then(
    () => clearTimeout(timer),
    (err) => {
      clearTimeout(timer);
      // The temp file may still be held open by the stuck write; remove it
      // once the streams have actually let go of it.
      copying.catch(() => {}).finally(() => fsp.unlink(dest).catch(() => {}));
      throw err;
    }
  );
}

// Windows and macOS file systems are case-insensitive by default, so
// "d:\vault\Backups" and "D:\Vault\backups" are the same folder there.
function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function foldCase(p, platform) {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

function isSamePath(a, b, platform) {
  platform = platform || process.platform;
  const api = pathApi(platform);
  return foldCase(api.resolve(a), platform) === foldCase(api.resolve(b), platform);
}

/**
 * Where the backup target sits relative to the vault:
 *   'outside'        -- anywhere outside the vault (the normal case)
 *   'vault-root'     -- the vault folder itself (refused)
 *   'hidden-in-vault'-- inside the vault, under a dot-folder Obsidian doesn't index
 *   'visible-in-vault' -- inside the vault where Obsidian indexes every snapshot
 *                       as more notes (duplicates in search, graph, quick switcher)
 */
function targetLocation(targetDir, vaultDir, platform) {
  platform = platform || process.platform;
  const api = pathApi(platform);
  const rel = api.relative(foldCase(api.resolve(vaultDir), platform), foldCase(api.resolve(targetDir), platform));
  if (rel === '') return 'vault-root';
  if (rel === '..' || rel.startsWith('..' + api.sep) || api.isAbsolute(rel)) return 'outside';
  return rel.split(api.sep).some((seg) => seg.startsWith('.')) ? 'hidden-in-vault' : 'visible-in-vault';
}

/** dev+inode identity of a path, or null where the file system doesn't provide one. */
async function fileIdentity(p) {
  try {
    const st = await fsp.stat(p, { bigint: true });
    if (!st.ino) return null;
    return st.dev + ':' + st.ino;
  } catch (e) {
    return null;
  }
}

/**
 * Normalizes a daily time typed by the user ("9:05", " 20:00 ") to "HH:MM",
 * or returns null if it isn't a real time of day. The schedule compares
 * times as strings, so e.g. "24:00" would otherwise silently never fire.
 */
function normalizeDailyTime(value) {
  const m = String(value == null ? '' : value).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return pad(h) + ':' + pad(min);
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

function localDateKey(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
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
 *
 * Firing doesn't mark the day as done: the caller records lastDailyRunDate
 * only once the backup succeeds. A failed one (target drive not plugged in,
 * say) is retried DAILY_RETRY_DELAY_MS later, up to DAILY_MAX_RETRIES times;
 * `retry` is { date, failures, lastAttempt } for today's failed attempts.
 */
function dailyScheduleDecision(settings, now, retry) {
  const unchanged = { run: false, lastDailyRunDate: settings.lastDailyRunDate };
  if (!settings.runDaily) return unchanged;

  const today = localDateKey(now);
  if (settings.lastDailyRunDate === today) return unchanged;

  if (settings.lastRun && settings.lastRun.time && isSameLocalDay(new Date(settings.lastRun.time), now)) {
    return { run: false, lastDailyRunDate: today };
  }

  const dailyTime = normalizeDailyTime(settings.dailyTime) || DEFAULT_SETTINGS.dailyTime;
  const hhmm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  if (hhmm < dailyTime) return unchanged;

  if (retry && retry.date === today) {
    if (retry.failures > DAILY_MAX_RETRIES) return unchanged;
    if (now.getTime() - retry.lastAttempt < DAILY_RETRY_DELAY_MS) return unchanged;
  }

  return { run: true, lastDailyRunDate: settings.lastDailyRunDate };
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
    this.platform = opts.platform || process.platform;
    this.targetRootId = null; // dev+inode, filled in by run() once the folder exists
    this.vaultName = opts.vaultName;
    this.exclude = new Set(opts.exclude || []);
    this.keepDaily = Number.isFinite(opts.keepDaily) ? opts.keepDaily : 7;
    this.keepWeekly = Number.isFinite(opts.keepWeekly) ? opts.keepWeekly : 4;
    this.keepMonthly = Number.isFinite(opts.keepMonthly) ? opts.keepMonthly : 6;
    this.logFilePath = opts.logFilePath;
    this.onProgress = opts.onProgress || (() => {});
    this.stallTimeoutMs = opts.stallTimeoutMs || COPY_STALL_TIMEOUT_MS;
    this.stats = { dirs: 0, files: 0, bytes: 0, skipped: 0, errors: [] };
    this.totalFiles = 0;
  }

  /**
   * Whether dir is the backup target folder, so a target inside the vault
   * isn't copied into its own snapshots. Compared by path (ignoring case where
   * the OS does) and, where available, by dev+inode, which also catches the
   * same folder reached through a symlink, junction or differently-typed path.
   */
  async isTargetRoot(dir) {
    if (isSamePath(dir, this.targetRoot, this.platform)) return true;
    if (!this.targetRootId) return false;
    return (await fileIdentity(dir)) === this.targetRootId;
  }

  copyFileOnce(src, dest) {
    return copyFileWithStallTimeout(src, dest, this.stallTimeoutMs);
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
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!(await this.isTargetRoot(from))) count += await this.countFiles(from);
      }
      else if (entry.isFile()) count++;
    }
    return count;
  }

  async copyFileWithRetry(src, dest, size) {
    for (let attempt = 1; ; attempt++) {
      // Copy to a per-attempt temp path and rename into place on success, so a
      // failed or stalled attempt never leaves a truncated file under the real
      // name, and a stuck write from an abandoned attempt (the OS may not let
      // go of it right away) can never collide with the next attempt's file.
      const tmpDest = dest + '.tmp-' + process.pid + '-' + Date.now() + '-' + attempt;
      try {
        await this.copyFileOnce(src, tmpDest);
        try {
          const st = await fsp.stat(src);
          await fsp.chmod(tmpDest, st.mode);
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

    // A folder the target can't hold (a name with ':' or '?' on an NTFS/exFAT/SMB
    // target, say) costs just that folder, not the whole backup.
    try {
      await fsp.mkdir(destDir, { recursive: true });
    } catch (err) {
      this.stats.errors.push(srcDir + '  ->  ' + err.message);
      return;
    }
    this.stats.dirs++;

    for (const entry of entries) {
      if (this.exclude.has(entry.name)) { this.stats.skipped++; continue; }

      const from = path.join(srcDir, entry.name);
      const to = path.join(destDir, entry.name);

      if (entry.isSymbolicLink()) {
        try {
          await fsp.symlink(await fsp.readlink(from), to);
        } catch (e) {
          this.stats.skipped++;
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (await this.isTargetRoot(from)) { this.stats.skipped++; continue; }
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

    const prefix = this.vaultName + '-';
    const target = path.join(this.targetRoot, prefix + stamp());
    let deleted;

    try {
      await fsp.mkdir(this.targetRoot, { recursive: true });
      this.targetRootId = await fileIdentity(this.targetRoot);

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

      deleted = await this.applyRetention(prefix);
    } catch (err) {
      // Keep the per-file errors collected so far, not just the fatal one.
      this.stats.errors.push('Backup aborted: ' + err.message);
      await this.writeErrorLog(target);
      err.logged = true;
      throw err;
    }
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
  COPY_STALL_TIMEOUT_MS,
  DAILY_RETRY_DELAY_MS,
  DAILY_MAX_RETRIES,
  DEFAULT_SETTINGS,
  pad,
  stamp,
  humanSize,
  sleep,
  copyFileWithStallTimeout,
  isSamePath,
  targetLocation,
  fileIdentity,
  normalizeDailyTime,
  parseBackupDate,
  isoWeekKey,
  pathExists,
  localDateKey,
  isSameLocalDay,
  dailyScheduleDecision,
  BackupRun,
};
