# Simple Backup

A minimal Obsidian plugin with a single job: copy your entire vault to a folder of your choice, timestamped and versioned, without ever slowing down Obsidian.

## Why

Most sync/backup plugins are built around cloud services, conflict resolution, or partial sync. Simple Backup does none of that — it just makes a plain, timestamped copy of the vault on a schedule (or on demand), and prunes old copies according to a retention policy you control. If you already sync your vault another way and just want a local (or network-drive) safety net, this is it.

## How it works

- On each run, Simple Backup spawns a **separate, low-priority background process** (a forked Node.js child process, `os.setPriority(PRIORITY_BELOW_NORMAL)`) that does the actual file copying. Obsidian's UI thread is never blocked, and disk I/O competes as little as possible with your normal usage.
- The vault is copied into `<target>/<vault-name>-<YYYY-MM-DD-HHmm>/`.
- Common junk/VCS folders (`node_modules`, `.git`, `.trash`, OS metadata files, etc.) are excluded by default and configurable.
- After every backup, a **retention policy** (keep N daily / N weekly / N monthly snapshots) prunes old backups automatically. The snapshot that was just created is always kept.
- Only **errors** are logged, to `backup-errors.log` inside the plugin's own folder — there is no verbose success log to sift through.

## Features

- **Manual trigger**: ribbon icon and a command palette entry ("Run backup now").
- **Scheduled triggers** (each independently toggleable):
  - On Obsidian startup
  - On Obsidian shutdown (the backup process is detached and keeps running even after Obsidian has fully closed)
  - Hourly
  - Daily, at a configurable time
- **Live progress notice**: a small, single, continuously-updating notification shows roughly how far the current backup has gotten (files copied, size so far).
- **Retention/rotation**: configurable number of daily/weekly/monthly snapshots to keep; everything else gets deleted automatically at the end of each run.
- **Folder picker**: a native "Browse…" button next to the target directory field (uses Electron's dialog on desktop).
- **Configurable exclude list** for files/folders that shouldn't be copied.

## Settings

| Setting | Description |
|---|---|
| Target directory | Absolute path of the folder where dated backup snapshots are created. Required. |
| Run on startup | Trigger a backup automatically whenever Obsidian opens the vault. |
| Run on shutdown | Trigger a backup automatically whenever the plugin is unloaded (closing Obsidian, disabling the plugin, or switching vaults); the copy continues in the background after Obsidian exits. |
| Run hourly | Trigger a backup once per hour. |
| Run daily | Trigger a backup once a day at a set `HH:MM` (local time). |
| Keep daily / weekly / monthly | How many most-recent daily/weekly/monthly snapshots to retain. |
| Excluded files/folders | Comma-separated list of names to skip while copying (matched by exact name, not path). |

## Requirements

- Desktop only (Windows/macOS/Linux). The plugin relies on Node.js's `child_process`/`fs`/`os` modules and Electron's native dialog, none of which are available in Obsidian Mobile — the plugin is marked `isDesktopOnly` and won't load on iOS/Android.

## Installation (manual)

1. Copy `manifest.json` and `main.js` into `<your-vault>/.obsidian/plugins/simple-backup/`.
2. Reload Obsidian (or toggle the plugin off/on) and enable **Simple Backup** under `Settings → Community plugins`.
3. Open the plugin's settings and set a target directory before running your first backup.

## Known limitations

- **The plugin can't tell "Obsidian is closing" apart from "this plugin was disabled" or "you switched vaults"** — Obsidian's API fires the same lifecycle hook for all three. "Run on shutdown" runs on all of them.
- **A backup interrupted mid-copy** (Obsidian force-quit, machine lost power, target drive disconnected) is left exactly as it is — it's never auto-deleted, but it's also excluded from the daily/weekly/monthly retention accounting, so it won't accidentally count as "the latest good snapshot" either. Clean it up manually if you find one (it has no `.backup-complete` marker file inside it).
- **The target directory can't be the vault itself.** It can be a subfolder of the vault, or any other location — just not the vault's root path exactly.
- **The "Browse…" folder picker** depends on Electron's `remote.dialog`, which isn't part of every Obsidian/Electron build. If it's unavailable, the button shows a notice and you can still type the path in by hand.

## Project layout

- `main.js` — the whole plugin: settings UI, scheduling, ribbon icon/command, and orchestration of the background process. It embeds the full source of `backup-worker.js` as a string and writes it out to the plugin folder itself before every run (Obsidian's installer only ever downloads `manifest.json`/`main.js`/`styles.css` from a release, so a second top-level file would never reach anyone who installs from the community plugin browser).
- `backup-worker.js` — the readable, independently-testable source of that worker: the standalone Node.js script that actually copies files, writes the completion marker, and applies the retention policy, run as a separate low-priority child process so it never competes with Obsidian's own work.
- `sync-worker.js` — run `node sync-worker.js` after editing `backup-worker.js` to re-embed it into `main.js`.
- `manifest.json` — standard Obsidian plugin manifest.

## License

MIT
