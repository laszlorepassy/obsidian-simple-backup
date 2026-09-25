'use strict';

/**
 * Keeps the machine awake while a backup runs.
 *
 * A laptop that dozes off mid-backup suspends Obsidian along with everything
 * else, leaving a half-copied snapshot behind until the lid opens again — and
 * the daily backup, scheduled for an hour when nobody is touching the
 * keyboard, is exactly the one most likely to run into the idle timeout.
 *
 * First choice is Electron's powerSaveBlocker ('prevent-app-suspension'):
 * it blocks idle system sleep but lets the screen turn off, and it keeps
 * working while the Obsidian window is minimized or hidden.
 *
 * Where that isn't reachable (it lives in Electron's main process and is only
 * exposed through `remote`), fall back to Chromium's Screen Wake Lock,
 * `navigator.wakeLock`, which blocks both display and idle system sleep. The
 * browser refuses and drops that lock whenever the window is hidden and never
 * restores it — hence re-requesting on `visibilitychange` for as long as a
 * backup still wants it. Every failure is swallowed: no lock just means the
 * old behavior, never a failed backup.
 */
function defaultPowerSaveBlocker() {
  try {
    const remote = require('electron').remote;
    return remote && remote.powerSaveBlocker ? remote.powerSaveBlocker : null;
  } catch (err) {
    return null;
  }
}

class ScreenWakeLock {
  constructor(opts = {}) {
    this.getPowerSaveBlocker = opts.getPowerSaveBlocker || defaultPowerSaveBlocker;
    this.blocker = null;
    this.blockerId = null;
    this.sentinel = null;
    this.pending = null;
    this.wanted = false;
    this.onVisibilityChange = () => {
      if (this.wanted && document.visibilityState === 'visible') this.request();
    };
  }

  async acquire() {
    if (this.wanted) return;
    this.wanted = true;
    if (this.startBlocker()) return;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    await this.request();
  }

  async release() {
    if (!this.wanted) return;
    this.wanted = false;
    if (this.blocker) {
      try { this.blocker.stop(this.blockerId); } catch (err) { /* already gone */ }
      this.blocker = null;
      this.blockerId = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      if (sentinel) await sentinel.release();
    } catch (err) { /* already released by the browser */ }
  }

  startBlocker() {
    try {
      const blocker = this.getPowerSaveBlocker();
      if (!blocker) return false;
      this.blockerId = blocker.start('prevent-app-suspension');
      this.blocker = blocker;
      return true;
    } catch (err) {
      return false;
    }
  }

  request() {
    // One request at a time: a second one while the first is pending (a
    // visibilitychange, or a new backup right after the last one ended) would
    // otherwise obtain a second lock that nothing ever releases.
    if (this.pending) return this.pending;
    if (this.sentinel && !this.sentinel.released) return Promise.resolve();
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return Promise.resolve();
    this.pending = (async () => {
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        // release() may have run while the request was still pending.
        if (!this.wanted) {
          await sentinel.release();
          return;
        }
        this.sentinel = sentinel;
      } catch (err) {
        console.debug('Simple Backup: could not keep the computer awake during the backup', err);
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}

module.exports = { ScreenWakeLock };
