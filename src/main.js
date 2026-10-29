'use strict';

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const {
  DEFAULT_SETTINGS, humanSize, summarizeErrors, BackupRun, dailyScheduleDecision, localDateKey, normalizeDailyTime, targetLocation,
} = require('../backup-core');
const { ScreenWakeLock } = require('./wake-lock');

class SimpleBackupPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.isRunning = false;
    this.activeNotice = null;
    this.dailyRetry = null; // { date, failures, lastAttempt } for today's failed daily backups
    this.warnedAboutTarget = false;
    this.wakeLock = new ScreenWakeLock();
    this.register(() => this.wakeLock.release());

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

  async checkDailySchedule() {
    const now = new Date();
    const decision = dailyScheduleDecision(this.settings, now, this.dailyRetry);
    if (decision.lastDailyRunDate !== this.settings.lastDailyRunDate) {
      this.settings.lastDailyRunDate = decision.lastDailyRunDate;
      await this.saveSettings();
    }
    if (!decision.run) return;

    const today = localDateKey(now);
    const outcome = await this.runBackup({ trigger: 'daily' });
    if (outcome === 'ok' || outcome === 'misconfigured') {
      // Retrying won't fix a settings problem; its notice shows once a day, not every half hour.
      this.settings.lastDailyRunDate = today;
      await this.saveSettings();
    } else if (outcome === 'failed') {
      const failures = this.dailyRetry && this.dailyRetry.date === today ? this.dailyRetry.failures : 0;
      this.dailyRetry = { date: today, failures: failures + 1, lastAttempt: Date.now() };
    }
    // 'busy': another backup is running; if it succeeds, it counts for today.
  }

  /** A warning about where the target folder is, or null if it's fine. */
  targetWarning(targetDir) {
    const basePath = this.getVaultBasePath();
    if (!basePath || !targetDir) return null;
    switch (targetLocation(targetDir, basePath)) {
      case 'vault-root':
        return 'The target directory cannot be the vault itself — pick a folder outside the vault.';
      case 'visible-in-vault':
        return 'This folder is inside the vault, so Obsidian indexes every snapshot as more notes '
          + '(duplicates in search, the graph and the quick switcher). Pick a folder outside the vault, '
          + 'or a hidden one whose name starts with a dot (e.g. .backups).';
      default:
        return null;
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

  /** Resolves to 'ok', 'failed', 'busy' (another backup is running) or 'misconfigured'. */
  async runBackup({ trigger } = {}) {
    if (this.isRunning) {
      // Scheduled triggers colliding with each other shouldn't pop up a notice.
      if (trigger === 'manual') new Notice('A backup is already in progress.');
      return 'busy';
    }

    const basePath = this.getVaultBasePath();
    if (!basePath) {
      new Notice('Error: could not determine the vault path (this plugin only works in desktop Obsidian).');
      return 'misconfigured';
    }

    const targetDir = (this.settings.targetDir || '').trim();
    if (!targetDir) {
      new Notice('Error: no backup target directory set. Open the plugin settings.');
      return 'misconfigured';
    }

    const location = targetLocation(targetDir, basePath);
    if (location === 'vault-root') {
      new Notice('Error: ' + this.targetWarning(targetDir));
      return 'misconfigured';
    }
    if (location === 'visible-in-vault' && !this.warnedAboutTarget) {
      this.warnedAboutTarget = true;
      new Notice('Simple Backup: ' + this.targetWarning(targetDir), 15000);
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

    // Released in the finally below, whichever way the run ends.
    this.wakeLock.acquire();
    let result;
    try {
      result = await run.run();
      this.isRunning = false;
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage(
          result.errors.length
            ? `Backup finished with ${result.errors.length} error(s):
${summarizeErrors(result.errors)}
Details: backup-errors.log`
            : `Backup finished: ${result.files} files, ${humanSize(result.bytes)}`
        );
        // Stays up (created with duration 0) until the user clicks it away,
        // so a backup that ran unattended can still be confirmed.
        this.activeNotice = null;
      }
    } catch (err) {
      this.isRunning = false;
      const message = err && err.message ? err.message : String(err);
      console.error('Simple Backup error:', err);
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage('Backup error: ' + message);
        this.activeNotice = null;
      }
      try {
        // BackupRun logs the errors it hit itself; only log the ones it never saw.
        if (logFilePath && !(err && err.logged)) {
          await fsp.mkdir(path.dirname(logFilePath), { recursive: true });
          await fsp.appendFile(logFilePath, `=== ${new Date().toISOString()} ===\n${message}\n\n`, 'utf8');
        }
      } catch (e) { /* best effort */ }
      return 'failed';
    } finally {
      this.wakeLock.release();
    }

    // Outside the try above: failing to save settings doesn't make a finished
    // backup a failed one.
    this.settings.lastRun = {
      time: Date.now(),
      trigger,
      files: result.files,
      bytes: result.bytes,
      errors: result.errors.length,
      deleted: result.deleted.length,
    };
    try {
      await this.saveSettings();
    } catch (err) {
      console.error('Simple Backup: could not save settings', err);
    }
    return 'ok';
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Older versions accepted times like "24:00" that never fire.
    this.settings.dailyTime = normalizeDailyTime(this.settings.dailyTime) || DEFAULT_SETTINGS.dailyTime;
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
            updateTargetWarning();
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

    const targetWarningEl = containerEl.createEl('p', { cls: 'setting-item-description' });
    targetWarningEl.style.color = 'var(--text-warning)';
    const updateTargetWarning = () => {
      const warning = this.plugin.targetWarning(this.plugin.settings.targetDir);
      targetWarningEl.setText(warning || '');
      targetWarningEl.style.display = warning ? '' : 'none';
    };
    updateTargetWarning();

    new Setting(containerEl)
      .setName('Run on startup')
      .setDesc('Automatically run a backup when Obsidian opens this vault.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runOnStartup)
        .onChange(async (v) => { this.plugin.settings.runOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run hourly')
      .setDesc('Automatically run a backup once per hour.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runHourly)
        .onChange(async (v) => { this.plugin.settings.runHourly = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Run daily')
      .setDesc('Run a backup once a day at the given time (HH:MM, local time). If it fails, e.g. because the target drive isn\'t connected, it is retried every 30 minutes, up to 3 times.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runDaily)
        .onChange(async (v) => { this.plugin.settings.runDaily = v; await this.plugin.saveSettings(); }))
      .addText((text) => text
        .setPlaceholder('20:00')
        .setValue(this.plugin.settings.dailyTime)
        .onChange(async (v) => {
          const time = normalizeDailyTime(v);
          // An invalid time is flagged and not saved; the last valid one stays in effect.
          text.inputEl.style.borderColor = time ? '' : 'var(--text-error)';
          if (time) {
            this.plugin.settings.dailyTime = time;
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

    new Setting(containerEl)
      .addButton((btn) => btn
        .setButtonText('🍪 Buy me a cookie')
        .onClick(() => {
          window.open('https://paypal.me/repassyl', '_blank');
        }));
  }
}

module.exports = SimpleBackupPlugin;
