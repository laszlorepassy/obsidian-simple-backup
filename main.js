'use strict';

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const RETRIES = 3;
const RETRY_WAIT_MS = 800;
const COMPLETE_MARKER = '.backup-complete';
const COPY_TIMEOUT_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  targetDir: '',
  runOnStartup: false,
  runOnShutdown: false,
  runHourly: false,
  runDaily: false,
  dailyTime: '03:00',
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
      try {
        await withTimeout(fsp.copyFile(src, dest), COPY_TIMEOUT_MS, src);
        try {
          const st = await fsp.stat(src);
          await fsp.utimes(dest, st.atime, st.mtime);
        } catch (e) { /* not critical */ }
        this.stats.files++;
        this.stats.bytes += size;
        return;
      } catch (err) {
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
          await fsp.rm(path.join(this.targetRoot, b.name), { recursive: true, force: true });
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

class SimpleBackupPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.isRunning = false;
    this.activeNotice = null;

    this.addRibbonIcon('archive', 'Back up vault now', () => {
      this.runBackup({ trigger: 'manual' });
    });

    this.addCommand({
      id: 'run-backup-now',
      name: 'Run backup now',
      callback: () => this.runBackup({ trigger: 'manual' }),
    });

    this.addSettingTab(new SimpleBackupSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.runOnStartup) {
        this.runBackup({ trigger: 'startup' });
      }
    });

    this.registerInterval(window.setInterval(() => {
      if (this.settings.runHourly) {
        this.runBackup({ trigger: 'hourly' });
      }
    }, 60 * 60 * 1000));

    this.registerInterval(window.setInterval(() => {
      this.checkDailySchedule();
    }, 60 * 1000));
  }

  onunload() {
    if (this.settings && this.settings.runOnShutdown) {
      // Best-effort: this runs inside Obsidian's own process, so it only
      // completes if Obsidian stays open long enough to finish copying.
      this.runBackup({ trigger: 'shutdown' });
    }
  }

  checkDailySchedule() {
    if (!this.settings.runDaily) return;
    const now = new Date();
    const hh = pad(now.getHours());
    const mm = pad(now.getMinutes());
    const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    if (`${hh}:${mm}` === this.settings.dailyTime && this.settings.lastDailyRunDate !== today) {
      this.settings.lastDailyRunDate = today;
      this.saveSettings();
      this.runBackup({ trigger: 'daily' });
    }
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter && typeof adapter.getBasePath === 'function') {
      return adapter.getBasePath();
    }
    return null;
  }

  getPluginDir() {
    const base = this.getVaultBasePath();
    if (!base) return null;
    return path.join(base, this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  getLogFilePath() {
    const dir = this.getPluginDir();
    return dir ? path.join(dir, 'backup-errors.log') : null;
  }

  async pickDirectory() {
    let remote;
    try {
      remote = require('electron').remote;
    } catch (err) {
      remote = null;
    }

    if (!remote || !remote.dialog) {
      new Notice('The folder picker is not available on this Obsidian/Electron version — enter the path manually.');
      return null;
    }

    try {
      const result = await remote.dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Backup target directory',
        defaultPath: this.settings.targetDir || undefined,
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (err) {
      new Notice('Error opening the folder picker: ' + (err && err.message ? err.message : String(err)));
      return null;
    }
  }

  async runBackup({ trigger } = {}) {
    if (this.isRunning) {
      new Notice('A backup is already in progress.');
      return;
    }

    const basePath = this.getVaultBasePath();
    if (!basePath) {
      new Notice('Error: could not determine the vault path (this plugin only works in desktop Obsidian).');
      return;
    }

    const targetDir = (this.settings.targetDir || '').trim();
    if (!targetDir) {
      new Notice('Error: no backup target directory set. Open the plugin settings.');
      return;
    }

    if (path.resolve(targetDir) === path.resolve(basePath)) {
      new Notice('Error: the target directory cannot be the vault itself — pick (or create) a subfolder or a separate location.');
      return;
    }

    const vaultName = this.app.vault.getName();
    const logFilePath = this.getLogFilePath();

    this.isRunning = true;
    this.activeNotice = new Notice('Backup: scanning files...', 0);

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
      },
    });

    try {
      const result = await run.run();
      this.isRunning = false;
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage(
          result.errors.length
            ? `Backup finished with errors (${result.errors.length}). See backup-errors.log`
            : `Backup finished: ${result.files} files, ${humanSize(result.bytes)}`
        );
        setTimeout(() => notice.hide(), 4000);
        this.activeNotice = null;
      }
      this.settings.lastRun = {
        time: Date.now(),
        trigger,
        files: result.files,
        bytes: result.bytes,
        errors: result.errors.length,
        deleted: result.deleted.length,
      };
      await this.saveSettings();
    } catch (err) {
      this.isRunning = false;
      const message = err && err.message ? err.message : String(err);
      console.error('Simple Backup error:', err);
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage('Backup error: ' + message);
        setTimeout(() => notice.hide(), 8000);
        this.activeNotice = null;
      }
      try {
        if (logFilePath) {
          await fsp.mkdir(path.dirname(logFilePath), { recursive: true });
          await fsp.appendFile(logFilePath, `=== ${new Date().toISOString()} ===\n${message}\n\n`, 'utf8');
        }
      } catch (e) { /* best effort */ }
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class SimpleBackupSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Simple Backup settings' });

    new Setting(containerEl)
      .setName('Target directory')
      .setDesc('The folder where backups are created (full path).')
      .addText((text) => {
        text
          .setPlaceholder('e.g. D:\\Backups\\Obsidian')
          .setValue(this.plugin.settings.targetDir)
          .onChange(async (value) => {
            this.plugin.settings.targetDir = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      })
      .addButton((btn) => btn
        .setButtonText('Browse…')
        .onClick(async () => {
          const dir = await this.plugin.pickDirectory();
          if (dir) {
            this.plugin.settings.targetDir = dir;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    new Setting(containerEl)
      .setName('Run on startup')
      .setDesc('Automatically run a backup when Obsidian opens this vault.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runOnStartup)
        .onChange(async (v) => { this.plugin.settings.runOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run on shutdown')
      .setDesc('Best-effort: try to run a backup whenever this plugin is unloaded (closing Obsidian, disabling the plugin, or switching vaults). It runs inside Obsidian itself, so it only completes if Obsidian stays open long enough to finish copying — for a large vault, prefer "Run on startup" or a scheduled time instead.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runOnShutdown)
        .onChange(async (v) => { this.plugin.settings.runOnShutdown = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run hourly')
      .setDesc('Automatically run a backup once per hour.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runHourly)
        .onChange(async (v) => { this.plugin.settings.runHourly = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run daily')
      .setDesc('Run a backup once a day at the given time (HH:MM, local time).')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runDaily)
        .onChange(async (v) => { this.plugin.settings.runDaily = v; await this.plugin.saveSettings(); }))
      .addText((text) => text
        .setPlaceholder('03:00')
        .setValue(this.plugin.settings.dailyTime)
        .onChange(async (v) => {
          const trimmed = v.trim();
          if (/^\d{2}:\d{2}$/.test(trimmed)) {
            this.plugin.settings.dailyTime = trimmed;
            await this.plugin.saveSettings();
          }
        }));

    containerEl.createEl('h3', { text: 'Retention policy (auto-delete old backups)' });
    containerEl.createEl('p', {
      text: 'After every backup, old snapshots are pruned automatically using the three rules below. Each rule keeps its own snapshots (e.g. "1 per day" and "1 per week" can both point at the same or different snapshots), and a snapshot is deleted only if none of the three rules want it anymore. The snapshot just created by this run is never deleted, even if all three numbers are set to 0.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Daily snapshots to keep')
      .setDesc('Keeps 1 snapshot (the most recent that day) for each of the last N calendar days. Example: 7 = never lose more than a day of work, going back a week.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.keepDaily))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.keepDaily = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Weekly snapshots to keep')
      .setDesc('Keeps 1 snapshot (the most recent that week) for each of the last N calendar weeks. Example: 4 = one checkpoint per week, for the last month.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.keepWeekly))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.keepWeekly = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Monthly snapshots to keep')
      .setDesc('Keeps 1 snapshot (the most recent that month) for each of the last N calendar months. Example: 6 = one checkpoint per month, for the last half year.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.keepMonthly))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.keepMonthly = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Excluded items' });
    new Setting(containerEl)
      .setName('Excluded files/folders')
      .setDesc('Comma-separated list (e.g. node_modules, .git, .trash).')
      .addTextArea((ta) => ta
        .setValue(this.plugin.settings.excludeList.join(', '))
        .onChange(async (v) => {
          this.plugin.settings.excludeList = v.split(',').map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Manual backup' });
    new Setting(containerEl)
      .setName('Run backup now')
      .addButton((btn) => btn
        .setButtonText('Run backup')
        .setCta()
        .onClick(() => this.plugin.runBackup({ trigger: 'manual' })));

    if (this.plugin.settings.lastRun) {
      const lr = this.plugin.settings.lastRun;
      const when = new Date(lr.time).toLocaleString();
      const parts = [`${lr.files} files`];
      parts.push(lr.errors ? `${lr.errors} errors` : 'no errors');
      if (lr.deleted) parts.push(`${lr.deleted} old backups deleted`);
      containerEl.createEl('p', {
        text: `Last backup (${lr.trigger}): ${when} — ${parts.join(', ')}`,
        cls: 'setting-item-description',
      });
    }
  }
}

module.exports = SimpleBackupPlugin;
