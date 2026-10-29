"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// backup-core.js
var require_backup_core = __commonJS({
  "backup-core.js"(exports2, module2) {
    "use strict";
    var path2 = require("path");
    var fs2 = require("fs");
    var fsp2 = fs2.promises;
    var { pipeline } = require("stream/promises");
    var RETRIES = 3;
    var RETRY_WAIT_MS = 800;
    var COMPLETE_MARKER = ".backup-complete";
    var COPY_STALL_TIMEOUT_MS = 60 * 1e3;
    var COPY_CHUNK_BYTES = 1024 * 1024;
    var DAILY_RETRY_DELAY_MS = 30 * 60 * 1e3;
    var DAILY_MAX_RETRIES = 3;
    var DEFAULT_SETTINGS2 = {
      targetDir: "",
      runOnStartup: false,
      runHourly: false,
      runDaily: true,
      dailyTime: "20:00",
      keepDaily: 3,
      keepWeekly: 4,
      keepMonthly: 12,
      excludeList: ["node_modules", ".git", ".trash", ".DS_Store", "Thumbs.db", "desktop.ini", "$RECYCLE.BIN", "System Volume Information"],
      lastRun: null,
      lastDailyRunDate: null
    };
    function pad(n) {
      return String(n).padStart(2, "0");
    }
    function stamp(d) {
      d = d || /* @__PURE__ */ new Date();
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes());
    }
    function humanSize2(bytes) {
      const u = ["B", "kB", "MB", "GB", "TB"];
      let i = 0;
      let v = bytes || 0;
      while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
      }
      return v.toFixed(i === 0 ? 0 : 1) + " " + u[i];
    }
    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    function copyFileWithStallTimeout(src, dest, stallMs) {
      const ac = new AbortController();
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => ac.abort(), stallMs);
      };
      const rs = fs2.createReadStream(src, { highWaterMark: COPY_CHUNK_BYTES });
      const ws = fs2.createWriteStream(dest, { flags: "wx" });
      rs.on("data", arm);
      arm();
      const copying = pipeline(rs, ws, { signal: ac.signal });
      const stalled = new Promise((_, reject) => {
        ac.signal.addEventListener("abort", () => {
          reject(new Error("No progress for " + Math.round(stallMs / 1e3) + "s, gave up: " + src));
        });
      });
      return Promise.race([copying, stalled]).then(
        () => clearTimeout(timer),
        (err) => {
          clearTimeout(timer);
          copying.catch(() => {
          }).finally(() => fsp2.unlink(dest).catch(() => {
          }));
          throw err;
        }
      );
    }
    function pathApi(platform) {
      return platform === "win32" ? path2.win32 : path2.posix;
    }
    function foldCase(p, platform) {
      return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
    }
    function isSamePath(a, b, platform) {
      platform = platform || process.platform;
      const api = pathApi(platform);
      return foldCase(api.resolve(a), platform) === foldCase(api.resolve(b), platform);
    }
    function targetLocation2(targetDir, vaultDir, platform) {
      platform = platform || process.platform;
      const api = pathApi(platform);
      const rel = api.relative(foldCase(api.resolve(vaultDir), platform), foldCase(api.resolve(targetDir), platform));
      if (rel === "") return "vault-root";
      if (rel === ".." || rel.startsWith(".." + api.sep) || api.isAbsolute(rel)) return "outside";
      return rel.split(api.sep).some((seg) => seg.startsWith(".")) ? "hidden-in-vault" : "visible-in-vault";
    }
    async function fileIdentity(p) {
      try {
        const st = await fsp2.stat(p, { bigint: true });
        if (!st.ino) return null;
        return st.dev + ":" + st.ino;
      } catch (e) {
        return null;
      }
    }
    function normalizeDailyTime2(value) {
      const m = String(value == null ? "" : value).trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return null;
      return pad(h) + ":" + pad(min);
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
      const week = 1 + Math.round(((date - firstThursday) / 864e5 - 3 + (firstThursday.getUTCDay() + 6) % 7) / 7);
      return date.getUTCFullYear() + "-W" + pad(week);
    }
    async function pathExists(p) {
      try {
        await fsp2.access(p);
        return true;
      } catch (e) {
        return false;
      }
    }
    function localDateKey2(d) {
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
    function isSameLocalDay(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    function dailyScheduleDecision2(settings, now, retry) {
      const unchanged = { run: false, lastDailyRunDate: settings.lastDailyRunDate };
      if (!settings.runDaily) return unchanged;
      const today = localDateKey2(now);
      if (settings.lastDailyRunDate === today) return unchanged;
      if (settings.lastRun && settings.lastRun.time && isSameLocalDay(new Date(settings.lastRun.time), now)) {
        return { run: false, lastDailyRunDate: today };
      }
      const dailyTime = normalizeDailyTime2(settings.dailyTime) || DEFAULT_SETTINGS2.dailyTime;
      const hhmm = pad(now.getHours()) + ":" + pad(now.getMinutes());
      if (hhmm < dailyTime) return unchanged;
      if (retry && retry.date === today) {
        if (retry.failures > DAILY_MAX_RETRIES) return unchanged;
        if (now.getTime() - retry.lastAttempt < DAILY_RETRY_DELAY_MS) return unchanged;
      }
      return { run: true, lastDailyRunDate: settings.lastDailyRunDate };
    }
    var BackupRun2 = class {
      constructor(opts) {
        this.sourceDir = opts.sourceDir;
        this.targetRoot = opts.targetRoot;
        this.platform = opts.platform || process.platform;
        this.targetRootId = null;
        this.vaultName = opts.vaultName;
        this.exclude = new Set(opts.exclude || []);
        this.keepDaily = Number.isFinite(opts.keepDaily) ? opts.keepDaily : 7;
        this.keepWeekly = Number.isFinite(opts.keepWeekly) ? opts.keepWeekly : 4;
        this.keepMonthly = Number.isFinite(opts.keepMonthly) ? opts.keepMonthly : 6;
        this.logFilePath = opts.logFilePath;
        this.onProgress = opts.onProgress || (() => {
        });
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
        return await fileIdentity(dir) === this.targetRootId;
      }
      copyFileOnce(src, dest) {
        return copyFileWithStallTimeout(src, dest, this.stallTimeoutMs);
      }
      async countFiles(dir) {
        let entries;
        try {
          entries = await fsp2.readdir(dir, { withFileTypes: true });
        } catch (err) {
          return 0;
        }
        let count = 0;
        for (const entry of entries) {
          if (this.exclude.has(entry.name)) continue;
          if (dir === this.sourceDir && entry.name === COMPLETE_MARKER) continue;
          const from = path2.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (!await this.isTargetRoot(from)) count += await this.countFiles(from);
          } else if (entry.isFile()) count++;
        }
        return count;
      }
      async copyFileWithRetry(src, dest, size) {
        for (let attempt = 1; ; attempt++) {
          const tmpDest = dest + ".tmp-" + process.pid + "-" + Date.now() + "-" + attempt;
          try {
            await this.copyFileOnce(src, tmpDest);
            try {
              const st = await fsp2.stat(src);
              await fsp2.chmod(tmpDest, st.mode);
              await fsp2.utimes(tmpDest, st.atime, st.mtime);
            } catch (e) {
            }
            await fsp2.rename(tmpDest, dest);
            this.stats.files++;
            this.stats.bytes += size;
            return;
          } catch (err) {
            try {
              await fsp2.unlink(tmpDest);
            } catch (e) {
            }
            if (attempt >= RETRIES) {
              this.stats.errors.push(src + "  ->  " + err.message);
              return;
            }
            await sleep(RETRY_WAIT_MS * attempt);
          }
        }
      }
      async copyTree(srcDir, destDir) {
        let entries;
        try {
          entries = await fsp2.readdir(srcDir, { withFileTypes: true });
        } catch (err) {
          this.stats.errors.push(srcDir + "  ->  " + err.message);
          return;
        }
        try {
          await fsp2.mkdir(destDir, { recursive: true });
        } catch (err) {
          this.stats.errors.push(srcDir + "  ->  " + err.message);
          return;
        }
        this.stats.dirs++;
        for (const entry of entries) {
          if (this.exclude.has(entry.name)) {
            this.stats.skipped++;
            continue;
          }
          if (srcDir === this.sourceDir && entry.name === COMPLETE_MARKER) continue;
          const from = path2.join(srcDir, entry.name);
          const to = path2.join(destDir, entry.name);
          if (entry.isSymbolicLink()) {
            try {
              await fsp2.symlink(await fsp2.readlink(from), to);
            } catch (e) {
              this.stats.skipped++;
            }
            continue;
          }
          if (entry.isDirectory()) {
            if (await this.isTargetRoot(from)) {
              this.stats.skipped++;
              continue;
            }
            await this.copyTree(from, to);
            continue;
          }
          if (entry.isFile()) {
            let size = 0;
            try {
              size = (await fsp2.stat(from)).size;
            } catch (e) {
            }
            await this.copyFileWithRetry(from, to, size);
            this.onProgress({ files: this.stats.files, total: this.totalFiles, bytes: this.stats.bytes });
          }
        }
      }
      async applyRetention(prefix) {
        const deleted = [];
        let entries;
        try {
          entries = await fsp2.readdir(this.targetRoot, { withFileTypes: true });
        } catch (err) {
          this.stats.errors.push(this.targetRoot + "  ->  " + err.message);
          return deleted;
        }
        const backups = [];
        for (const e of entries) {
          if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
          const date = parseBackupDate(e.name, prefix);
          if (!(date instanceof Date) || isNaN(date)) continue;
          const complete = await pathExists(path2.join(this.targetRoot, e.name, COMPLETE_MARKER));
          if (!complete) continue;
          backups.push({ name: e.name, date });
        }
        backups.sort((a, b) => b.date - a.date);
        if (backups.length === 0) return deleted;
        const keep = /* @__PURE__ */ new Set([backups[0].name]);
        const keepLatestPerGroup = (keyFn, limit) => {
          const seen = /* @__PURE__ */ new Set();
          for (const b of backups) {
            const key = keyFn(b.date);
            if (!seen.has(key)) {
              seen.add(key);
              if (seen.size <= limit) keep.add(b.name);
            }
          }
        };
        keepLatestPerGroup((d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()), this.keepDaily);
        keepLatestPerGroup((d) => isoWeekKey(d), this.keepWeekly);
        keepLatestPerGroup((d) => d.getFullYear() + "-" + pad(d.getMonth() + 1), this.keepMonthly);
        for (const b of backups) {
          if (!keep.has(b.name)) {
            try {
              await fsp2.rm(path2.join(this.targetRoot, b.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
              deleted.push(b.name);
            } catch (err) {
              this.stats.errors.push(path2.join(this.targetRoot, b.name) + "  ->  " + err.message);
            }
          }
        }
        return deleted;
      }
      // Writes the marker, replacing whatever is there (remove first: an existing
      // read-only or locked file makes an in-place overwrite fail with EPERM), and
      // retries, since cloud drives like pCloud can be briefly busy.
      async writeCompleteMarker(target) {
        const file = path2.join(target, COMPLETE_MARKER);
        let lastErr;
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
          try {
            try {
              await fsp2.unlink(file);
            } catch (e) {
            }
            await fsp2.writeFile(file, (/* @__PURE__ */ new Date()).toISOString(), "utf8");
            return;
          } catch (err) {
            lastErr = err;
            if (attempt < RETRIES) await sleep(RETRY_WAIT_MS * attempt);
          }
        }
        throw lastErr;
      }
      async writeErrorLog(target) {
        if (!this.stats.errors.length) return;
        const lines = [];
        lines.push("=== " + (/* @__PURE__ */ new Date()).toISOString() + " ===");
        lines.push("Target: " + target);
        for (const e of this.stats.errors) lines.push("  - " + e);
        lines.push("");
        try {
          await fsp2.mkdir(path2.dirname(this.logFilePath), { recursive: true });
          await fsp2.appendFile(this.logFilePath, lines.join("\n") + "\n", "utf8");
        } catch (e) {
        }
      }
      async run() {
        if (!await pathExists(this.sourceDir)) {
          throw new Error("The source vault folder was not found: " + this.sourceDir);
        }
        const prefix = this.vaultName + "-";
        const target = path2.join(this.targetRoot, prefix + stamp());
        let deleted;
        try {
          await fsp2.mkdir(this.targetRoot, { recursive: true });
          this.targetRootId = await fileIdentity(this.targetRoot);
          if (await pathExists(target)) {
            throw new Error("The target folder already exists: " + target);
          }
          this.totalFiles = await this.countFiles(this.sourceDir);
          this.onProgress({ files: 0, total: this.totalFiles, bytes: 0 });
          await this.copyTree(this.sourceDir, target);
          try {
            await this.writeCompleteMarker(target);
          } catch (err) {
            this.stats.errors.push(target + "  ->  could not write completion marker: " + err.message);
          }
          deleted = await this.applyRetention(prefix);
        } catch (err) {
          this.stats.errors.push("Backup aborted: " + err.message);
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
          target
        };
      }
    };
    function summarizeErrors2(errors, maxShown = 2, maxLen = 160) {
      const short = (e) => {
        const t = String(e).replace(/\s+/g, " ");
        return t.length > maxLen ? t.slice(0, maxLen - 1) + "\u2026" : t;
      };
      const shown = errors.slice(0, maxShown).map(short);
      const more = errors.length - shown.length;
      return shown.join("\n") + (more > 0 ? `
(+${more} more)` : "");
    }
    module2.exports = {
      summarizeErrors: summarizeErrors2,
      RETRIES,
      RETRY_WAIT_MS,
      COMPLETE_MARKER,
      COPY_STALL_TIMEOUT_MS,
      DAILY_RETRY_DELAY_MS,
      DAILY_MAX_RETRIES,
      DEFAULT_SETTINGS: DEFAULT_SETTINGS2,
      pad,
      stamp,
      humanSize: humanSize2,
      sleep,
      copyFileWithStallTimeout,
      isSamePath,
      targetLocation: targetLocation2,
      fileIdentity,
      normalizeDailyTime: normalizeDailyTime2,
      parseBackupDate,
      isoWeekKey,
      pathExists,
      localDateKey: localDateKey2,
      isSameLocalDay,
      dailyScheduleDecision: dailyScheduleDecision2,
      BackupRun: BackupRun2
    };
  }
});

// src/wake-lock.js
var require_wake_lock = __commonJS({
  "src/wake-lock.js"(exports2, module2) {
    "use strict";
    function defaultPowerSaveBlocker() {
      try {
        const remote = require("electron").remote;
        return remote && remote.powerSaveBlocker ? remote.powerSaveBlocker : null;
      } catch (err) {
        return null;
      }
    }
    var ScreenWakeLock2 = class {
      constructor(opts = {}) {
        this.getPowerSaveBlocker = opts.getPowerSaveBlocker || defaultPowerSaveBlocker;
        this.blocker = null;
        this.blockerId = null;
        this.sentinel = null;
        this.pending = null;
        this.wanted = false;
        this.onVisibilityChange = () => {
          if (this.wanted && document.visibilityState === "visible") this.request();
        };
      }
      async acquire() {
        if (this.wanted) return;
        this.wanted = true;
        if (this.startBlocker()) return;
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", this.onVisibilityChange);
        }
        await this.request();
      }
      async release() {
        if (!this.wanted) return;
        this.wanted = false;
        if (this.blocker) {
          try {
            this.blocker.stop(this.blockerId);
          } catch (err) {
          }
          this.blocker = null;
          this.blockerId = null;
        }
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", this.onVisibilityChange);
        }
        const sentinel = this.sentinel;
        this.sentinel = null;
        try {
          if (sentinel) await sentinel.release();
        } catch (err) {
        }
      }
      startBlocker() {
        try {
          const blocker = this.getPowerSaveBlocker();
          if (!blocker) return false;
          this.blockerId = blocker.start("prevent-app-suspension");
          this.blocker = blocker;
          return true;
        } catch (err) {
          return false;
        }
      }
      request() {
        if (this.pending) return this.pending;
        if (this.sentinel && !this.sentinel.released) return Promise.resolve();
        if (typeof navigator === "undefined" || !navigator.wakeLock) return Promise.resolve();
        this.pending = (async () => {
          try {
            const sentinel = await navigator.wakeLock.request("screen");
            if (!this.wanted) {
              await sentinel.release();
              return;
            }
            this.sentinel = sentinel;
          } catch (err) {
            console.debug("Simple Backup: could not keep the computer awake during the backup", err);
          } finally {
            this.pending = null;
          }
        })();
        return this.pending;
      }
    };
    module2.exports = { ScreenWakeLock: ScreenWakeLock2 };
  }
});

// src/main.js
var { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");
var path = require("path");
var fs = require("fs");
var fsp = fs.promises;
var {
  DEFAULT_SETTINGS,
  humanSize,
  summarizeErrors,
  BackupRun,
  dailyScheduleDecision,
  localDateKey,
  normalizeDailyTime,
  targetLocation
} = require_backup_core();
var { ScreenWakeLock } = require_wake_lock();
var SimpleBackupPlugin = class extends Plugin {
  async onload() {
    await this.loadSettings();
    this.isRunning = false;
    this.activeNotice = null;
    this.dailyRetry = null;
    this.warnedAboutTarget = false;
    this.wakeLock = new ScreenWakeLock();
    this.register(() => this.wakeLock.release());
    this.addRibbonIcon("archive", "Back up vault now", () => {
      this.runBackup({ trigger: "manual" });
    });
    this.addCommand({
      id: "run-backup-now",
      name: "Run backup now",
      callback: () => this.runBackup({ trigger: "manual" })
    });
    this.addSettingTab(new SimpleBackupSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.runOnStartup) {
        this.runBackup({ trigger: "startup" });
      }
    });
    this.registerInterval(window.setInterval(() => {
      if (this.settings.runHourly) {
        this.runBackup({ trigger: "hourly" });
      }
    }, 60 * 60 * 1e3));
    this.registerInterval(window.setInterval(() => {
      this.checkDailySchedule();
    }, 60 * 1e3));
  }
  async checkDailySchedule() {
    const now = /* @__PURE__ */ new Date();
    const decision = dailyScheduleDecision(this.settings, now, this.dailyRetry);
    if (decision.lastDailyRunDate !== this.settings.lastDailyRunDate) {
      this.settings.lastDailyRunDate = decision.lastDailyRunDate;
      await this.saveSettings();
    }
    if (!decision.run) return;
    const today = localDateKey(now);
    const outcome = await this.runBackup({ trigger: "daily" });
    if (outcome === "ok" || outcome === "misconfigured") {
      this.settings.lastDailyRunDate = today;
      await this.saveSettings();
    } else if (outcome === "failed") {
      const failures = this.dailyRetry && this.dailyRetry.date === today ? this.dailyRetry.failures : 0;
      this.dailyRetry = { date: today, failures: failures + 1, lastAttempt: Date.now() };
    }
  }
  /** A warning about where the target folder is, or null if it's fine. */
  targetWarning(targetDir) {
    const basePath = this.getVaultBasePath();
    if (!basePath || !targetDir) return null;
    switch (targetLocation(targetDir, basePath)) {
      case "vault-root":
        return "The target directory cannot be the vault itself \u2014 pick a folder outside the vault.";
      case "visible-in-vault":
        return "This folder is inside the vault, so Obsidian indexes every snapshot as more notes (duplicates in search, the graph and the quick switcher). Pick a folder outside the vault, or a hidden one whose name starts with a dot (e.g. .backups).";
      default:
        return null;
    }
  }
  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    return null;
  }
  getPluginDir() {
    const base = this.getVaultBasePath();
    if (!base) return null;
    return path.join(base, this.app.vault.configDir, "plugins", this.manifest.id);
  }
  getLogFilePath() {
    const dir = this.getPluginDir();
    return dir ? path.join(dir, "backup-errors.log") : null;
  }
  async pickDirectory() {
    let remote;
    try {
      remote = require("electron").remote;
    } catch (err) {
      remote = null;
    }
    if (!remote || !remote.dialog) {
      new Notice("The folder picker is not available on this Obsidian/Electron version \u2014 enter the path manually.");
      return null;
    }
    try {
      const result = await remote.dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Backup target directory",
        defaultPath: this.settings.targetDir || void 0
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (err) {
      new Notice("Error opening the folder picker: " + (err && err.message ? err.message : String(err)));
      return null;
    }
  }
  /** Resolves to 'ok', 'failed', 'busy' (another backup is running) or 'misconfigured'. */
  async runBackup({ trigger } = {}) {
    if (this.isRunning) {
      if (trigger === "manual") new Notice("A backup is already in progress.");
      return "busy";
    }
    const basePath = this.getVaultBasePath();
    if (!basePath) {
      new Notice("Error: could not determine the vault path (this plugin only works in desktop Obsidian).");
      return "misconfigured";
    }
    const targetDir = (this.settings.targetDir || "").trim();
    if (!targetDir) {
      new Notice("Error: no backup target directory set. Open the plugin settings.");
      return "misconfigured";
    }
    const location = targetLocation(targetDir, basePath);
    if (location === "vault-root") {
      new Notice("Error: " + this.targetWarning(targetDir));
      return "misconfigured";
    }
    if (location === "visible-in-vault" && !this.warnedAboutTarget) {
      this.warnedAboutTarget = true;
      new Notice("Simple Backup: " + this.targetWarning(targetDir), 15e3);
    }
    const vaultName = this.app.vault.getName();
    const logFilePath = this.getLogFilePath();
    this.isRunning = true;
    this.activeNotice = new Notice("Backup: scanning files...", 0);
    let lastUpdate = 0;
    const run = new BackupRun({
      sourceDir: basePath,
      targetRoot: targetDir,
      vaultName,
      exclude: this.settings.excludeList,
      keepDaily: this.settings.keepDaily,
      keepWeekly: this.settings.keepWeekly,
      keepMonthly: this.settings.keepMonthly,
      logFilePath,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastUpdate > 400 && this.activeNotice) {
          lastUpdate = now;
          const fileLabel = p.total ? `${p.files}/${p.total} files` : `${p.files} files`;
          this.activeNotice.setMessage(`Backing up: ${fileLabel}, ${humanSize(p.bytes)}`);
        }
      }
    });
    this.wakeLock.acquire();
    let result;
    try {
      result = await run.run();
      this.isRunning = false;
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage(
          result.errors.length ? `Backup finished with ${result.errors.length} error(s):
${summarizeErrors(result.errors)}
Details: backup-errors.log` : `Backup finished: ${result.files} files, ${humanSize(result.bytes)}`
        );
        this.activeNotice = null;
      }
    } catch (err) {
      this.isRunning = false;
      const message = err && err.message ? err.message : String(err);
      console.error("Simple Backup error:", err);
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage("Backup error: " + message);
        this.activeNotice = null;
      }
      try {
        if (logFilePath && !(err && err.logged)) {
          await fsp.mkdir(path.dirname(logFilePath), { recursive: true });
          await fsp.appendFile(logFilePath, `=== ${(/* @__PURE__ */ new Date()).toISOString()} ===
${message}

`, "utf8");
        }
      } catch (e) {
      }
      return "failed";
    } finally {
      this.wakeLock.release();
    }
    this.settings.lastRun = {
      time: Date.now(),
      trigger,
      files: result.files,
      bytes: result.bytes,
      errors: result.errors.length,
      deleted: result.deleted.length
    };
    try {
      await this.saveSettings();
    } catch (err) {
      console.error("Simple Backup: could not save settings", err);
    }
    return "ok";
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.dailyTime = normalizeDailyTime(this.settings.dailyTime) || DEFAULT_SETTINGS.dailyTime;
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
var SimpleBackupSettingTab = class extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Simple Backup settings" });
    new Setting(containerEl).setName("Target directory").setDesc("The folder where backups are created (full path).").addText((text) => {
      text.setPlaceholder("e.g. D:\\Backups\\Obsidian").setValue(this.plugin.settings.targetDir).onChange(async (value) => {
        this.plugin.settings.targetDir = value.trim();
        await this.plugin.saveSettings();
        updateTargetWarning();
      });
      text.inputEl.style.width = "100%";
    }).addButton((btn) => btn.setButtonText("Browse\u2026").onClick(async () => {
      const dir = await this.plugin.pickDirectory();
      if (dir) {
        this.plugin.settings.targetDir = dir;
        await this.plugin.saveSettings();
        this.display();
      }
    }));
    const targetWarningEl = containerEl.createEl("p", { cls: "setting-item-description" });
    targetWarningEl.style.color = "var(--text-warning)";
    const updateTargetWarning = () => {
      const warning = this.plugin.targetWarning(this.plugin.settings.targetDir);
      targetWarningEl.setText(warning || "");
      targetWarningEl.style.display = warning ? "" : "none";
    };
    updateTargetWarning();
    new Setting(containerEl).setName("Run on startup").setDesc("Automatically run a backup when Obsidian opens this vault.").addToggle((t) => t.setValue(this.plugin.settings.runOnStartup).onChange(async (v) => {
      this.plugin.settings.runOnStartup = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Run hourly").setDesc("Automatically run a backup once per hour.").addToggle((t) => t.setValue(this.plugin.settings.runHourly).onChange(async (v) => {
      this.plugin.settings.runHourly = v;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Run daily").setDesc("Run a backup once a day at the given time (HH:MM, local time). If it fails, e.g. because the target drive isn't connected, it is retried every 30 minutes, up to 3 times.").addToggle((t) => t.setValue(this.plugin.settings.runDaily).onChange(async (v) => {
      this.plugin.settings.runDaily = v;
      await this.plugin.saveSettings();
    })).addText((text) => text.setPlaceholder("20:00").setValue(this.plugin.settings.dailyTime).onChange(async (v) => {
      const time = normalizeDailyTime(v);
      text.inputEl.style.borderColor = time ? "" : "var(--text-error)";
      if (time) {
        this.plugin.settings.dailyTime = time;
        await this.plugin.saveSettings();
      }
    }));
    containerEl.createEl("h3", { text: "Retention policy (auto-delete old backups)" });
    containerEl.createEl("p", {
      text: 'After every backup, old snapshots are pruned automatically using the three rules below. Each rule keeps its own snapshots (e.g. "1 per day" and "1 per week" can both point at the same or different snapshots), and a snapshot is deleted only if none of the three rules want it anymore. The snapshot just created by this run is never deleted, even if all three numbers are set to 0.',
      cls: "setting-item-description"
    });
    new Setting(containerEl).setName("Daily snapshots to keep").setDesc("Keeps 1 snapshot (the most recent that day) for each of the last N calendar days. Example: 7 = never lose more than a day of work, going back a week.").addText((text) => text.setValue(String(this.plugin.settings.keepDaily)).onChange(async (v) => {
      const n = parseInt(v, 10);
      this.plugin.settings.keepDaily = Number.isFinite(n) && n >= 0 ? n : 0;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Weekly snapshots to keep").setDesc("Keeps 1 snapshot (the most recent that week) for each of the last N calendar weeks. Example: 4 = one checkpoint per week, for the last month.").addText((text) => text.setValue(String(this.plugin.settings.keepWeekly)).onChange(async (v) => {
      const n = parseInt(v, 10);
      this.plugin.settings.keepWeekly = Number.isFinite(n) && n >= 0 ? n : 0;
      await this.plugin.saveSettings();
    }));
    new Setting(containerEl).setName("Monthly snapshots to keep").setDesc("Keeps 1 snapshot (the most recent that month) for each of the last N calendar months. Example: 6 = one checkpoint per month, for the last half year.").addText((text) => text.setValue(String(this.plugin.settings.keepMonthly)).onChange(async (v) => {
      const n = parseInt(v, 10);
      this.plugin.settings.keepMonthly = Number.isFinite(n) && n >= 0 ? n : 0;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Excluded items" });
    new Setting(containerEl).setName("Excluded files/folders").setDesc("Comma-separated list (e.g. node_modules, .git, .trash).").addTextArea((ta) => ta.setValue(this.plugin.settings.excludeList.join(", ")).onChange(async (v) => {
      this.plugin.settings.excludeList = v.split(",").map((s) => s.trim()).filter(Boolean);
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Manual backup" });
    new Setting(containerEl).setName("Run backup now").addButton((btn) => btn.setButtonText("Run backup").setCta().onClick(() => this.plugin.runBackup({ trigger: "manual" })));
    if (this.plugin.settings.lastRun) {
      const lr = this.plugin.settings.lastRun;
      const when = new Date(lr.time).toLocaleString();
      const parts = [`${lr.files} files`];
      parts.push(lr.errors ? `${lr.errors} errors` : "no errors");
      if (lr.deleted) parts.push(`${lr.deleted} old backups deleted`);
      containerEl.createEl("p", {
        text: `Last backup (${lr.trigger}): ${when} \u2014 ${parts.join(", ")}`,
        cls: "setting-item-description"
      });
    }
    new Setting(containerEl).addButton((btn) => btn.setButtonText("\u{1F36A} Buy me a cookie").onClick(() => {
      window.open("https://paypal.me/repassyl", "_blank");
    }));
  }
};
module.exports = SimpleBackupPlugin;
