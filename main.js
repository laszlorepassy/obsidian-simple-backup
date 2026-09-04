'use strict';

const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

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

function humanSize(bytes) {
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
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
      this.runBackup({ trigger: 'shutdown', detached: true });
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

  runBackup({ trigger, detached = false } = {}) {
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

    const pluginDir = this.getPluginDir();
    const workerPath = path.join(pluginDir, 'backup-worker.js');
    if (!fs.existsSync(workerPath)) {
      new Notice('Error: backup-worker.js not found in the plugin folder.');
      return;
    }

    const vaultName = this.app.vault.getName();
    const logFilePath = this.getLogFilePath();

    const config = {
      exclude: this.settings.excludeList,
      keepDaily: this.settings.keepDaily,
      keepWeekly: this.settings.keepWeekly,
      keepMonthly: this.settings.keepMonthly,
    };

    const args = [basePath, targetDir, vaultName, JSON.stringify(config), logFilePath];

    this.isRunning = true;
    this.activeNotice = new Notice('Backup starting...', 0);

    let child;
    try {
      child = fork(workerPath, args, {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: detached,
        windowsHide: true,
      });
    } catch (err) {
      this.isRunning = false;
      if (this.activeNotice) this.activeNotice.hide();
      new Notice('Error starting the backup: ' + err.message);
      return;
    }

    if (detached) {
      child.unref();
    }

    let lastUpdate = 0;
    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'progress') {
        const now = Date.now();
        if (now - lastUpdate > 400 && this.activeNotice) {
          lastUpdate = now;
          const fileLabel = msg.total ? `${msg.files}/${msg.total} files` : `${msg.files} files`;
          this.activeNotice.setMessage(`Backing up: ${fileLabel}, ${humanSize(msg.bytes)}`);
        }
        return;
      }

      if (msg.type === 'done') {
        this.isRunning = false;
        if (this.activeNotice) {
          const notice = this.activeNotice;
          notice.setMessage(
            msg.errors && msg.errors.length
              ? `Backup finished with errors (${msg.errors.length}). See backup-errors.log`
              : `Backup finished: ${msg.files} files, ${humanSize(msg.bytes)}`
          );
          setTimeout(() => notice.hide(), 4000);
          this.activeNotice = null;
        }
        this.settings.lastRun = {
          time: Date.now(),
          trigger,
          files: msg.files,
          bytes: msg.bytes,
          errors: msg.errors ? msg.errors.length : 0,
          deleted: msg.deleted ? msg.deleted.length : 0,
        };
        this.saveSettings();
        return;
      }

      if (msg.type === 'error') {
        this.isRunning = false;
        if (this.activeNotice) {
          const notice = this.activeNotice;
          notice.setMessage('Backup error: ' + msg.message);
          setTimeout(() => notice.hide(), 6000);
          this.activeNotice = null;
        }
      }
    });

    child.on('error', (err) => {
      this.isRunning = false;
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage('Backup process error: ' + err.message);
        setTimeout(() => notice.hide(), 6000);
        this.activeNotice = null;
      }
    });

    child.on('exit', () => {
      this.isRunning = false;
    });
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
      .setDesc('Automatically run a backup when Obsidian closes (the background process keeps running after Obsidian exits).')
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
