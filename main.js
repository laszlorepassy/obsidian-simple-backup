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

    this.addRibbonIcon('archive', 'Vault mentése most', () => {
      this.runBackup({ trigger: 'manual' });
    });

    this.addCommand({
      id: 'run-backup-now',
      name: 'Mentés indítása most',
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
      new Notice('A fájlválasztó nem érhető el ezen az Obsidian/Electron verzión — add meg kézzel az elérési utat.');
      return null;
    }

    try {
      const result = await remote.dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: 'Mentések célkönyvtára',
        defaultPath: this.settings.targetDir || undefined,
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    } catch (err) {
      new Notice('Hiba a fájlválasztó megnyitásakor: ' + (err && err.message ? err.message : String(err)));
      return null;
    }
  }

  runBackup({ trigger, detached = false } = {}) {
    if (this.isRunning) {
      new Notice('Mentés már folyamatban van.');
      return;
    }

    const basePath = this.getVaultBasePath();
    if (!basePath) {
      new Notice('Hiba: nem sikerült meghatározni a vault elérési útját (csak asztali Obsidianban működik).');
      return;
    }

    const targetDir = (this.settings.targetDir || '').trim();
    if (!targetDir) {
      new Notice('Hiba: nincs beállítva mentési célkönyvtár. Nyisd meg a beállításokat.');
      return;
    }

    const pluginDir = this.getPluginDir();
    const workerPath = path.join(pluginDir, 'backup-worker.js');
    if (!fs.existsSync(workerPath)) {
      new Notice('Hiba: a backup-worker.js nem található a plugin mappájában.');
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
    this.activeNotice = new Notice('Mentés indul...', 0);

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
      new Notice('Hiba a mentés indításakor: ' + err.message);
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
          this.activeNotice.setMessage(`Mentés: ${msg.files} fájl, ${humanSize(msg.bytes)}`);
        }
        return;
      }

      if (msg.type === 'done') {
        this.isRunning = false;
        if (this.activeNotice) {
          const notice = this.activeNotice;
          notice.setMessage(
            msg.errors && msg.errors.length
              ? `Mentés kész, hibákkal (${msg.errors.length}). Napló: backup-errors.log`
              : `Mentés kész: ${msg.files} fájl, ${humanSize(msg.bytes)}`
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
          notice.setMessage('Mentési hiba: ' + msg.message);
          setTimeout(() => notice.hide(), 6000);
          this.activeNotice = null;
        }
      }
    });

    child.on('error', (err) => {
      this.isRunning = false;
      if (this.activeNotice) {
        const notice = this.activeNotice;
        notice.setMessage('Mentési folyamat hiba: ' + err.message);
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

    containerEl.createEl('h2', { text: 'Simple Backup beállítások' });

    new Setting(containerEl)
      .setName('Cél könyvtár')
      .setDesc('A mappa, ahová a mentések kerülnek (teljes elérési út).')
      .addText((text) => {
        text
          .setPlaceholder('pl. D:\\Backups\\Obsidian')
          .setValue(this.plugin.settings.targetDir)
          .onChange(async (value) => {
            this.plugin.settings.targetDir = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = '100%';
      })
      .addButton((btn) => btn
        .setButtonText('Tallózás…')
        .onClick(async () => {
          const dir = await this.plugin.pickDirectory();
          if (dir) {
            this.plugin.settings.targetDir = dir;
            await this.plugin.saveSettings();
            this.display();
          }
        }));

    new Setting(containerEl)
      .setName('Mentés indításkor')
      .setDesc('Obsidian indulásakor automatikusan fusson a mentés.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runOnStartup)
        .onChange(async (v) => { this.plugin.settings.runOnStartup = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Mentés leállításkor')
      .setDesc('Obsidian bezárásakor automatikusan induljon a mentés (a háttérfolyamat bezárás után is folytatódik).')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runOnShutdown)
        .onChange(async (v) => { this.plugin.settings.runOnShutdown = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Óránkénti mentés')
      .setDesc('Óránként automatikusan fusson a mentés.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.runHourly)
        .onChange(async (v) => { this.plugin.settings.runHourly = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Napi mentés')
      .setDesc('Naponta egyszer, a megadott időpontban fusson a mentés (ÓÓ:PP, helyi idő).')
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

    containerEl.createEl('h3', { text: 'Megőrzési szabályok' });
    containerEl.createEl('p', {
      text: 'Minden mentés végén a plugin ellenőrzi a meglévő mentések számát, és törli a felesleges régieket. A legutóbb készült mentés mindig megmarad.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Napi mentések megőrzése')
      .setDesc('Az utolsó N napból egy-egy mentés maradjon meg.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.keepDaily))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.keepDaily = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Heti mentések megőrzése')
      .setDesc('Az utolsó N hétből egy-egy mentés maradjon meg.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.keepWeekly))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.keepWeekly = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Havi mentések megőrzése')
      .setDesc('Az utolsó N hónapból egy-egy mentés maradjon meg.')
      .addText((text) => text
        .setValue(String(this.plugin.settings.keepMonthly))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.keepMonthly = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Kihagyott elemek' });
    new Setting(containerEl)
      .setName('Kihagyott fájlok/mappák')
      .setDesc('Vesszővel elválasztott lista (pl. node_modules, .git, .trash).')
      .addTextArea((ta) => ta
        .setValue(this.plugin.settings.excludeList.join(', '))
        .onChange(async (v) => {
          this.plugin.settings.excludeList = v.split(',').map((s) => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Kézi mentés' });
    new Setting(containerEl)
      .setName('Mentés indítása most')
      .addButton((btn) => btn
        .setButtonText('Mentés indítása')
        .setCta()
        .onClick(() => this.plugin.runBackup({ trigger: 'manual' })));

    if (this.plugin.settings.lastRun) {
      const lr = this.plugin.settings.lastRun;
      const when = new Date(lr.time).toLocaleString();
      const parts = [`${lr.files} fájl`];
      parts.push(lr.errors ? `${lr.errors} hiba` : 'hiba nélkül');
      if (lr.deleted) parts.push(`${lr.deleted} régi mentés törölve`);
      containerEl.createEl('p', {
        text: `Utolsó mentés (${lr.trigger}): ${when} — ${parts.join(', ')}`,
        cls: 'setting-item-description',
      });
    }
  }
}

module.exports = SimpleBackupPlugin;
