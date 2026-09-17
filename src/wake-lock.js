'use strict';

/**
 * Keeps the screen (and with it the machine) awake while a backup runs.
 *
 * A laptop that dozes off mid-backup suspends Obsidian along with everything
 * else, leaving a half-copied snapshot behind until the lid opens again — and
 * the daily backup, scheduled for an hour when nobody is touching the
 * keyboard, is exactly the one most likely to run into the idle timeout.
 * Chromium's Screen Wake Lock, which Obsidian's Electron exposes as
 * `navigator.wakeLock`, blocks both display and idle system sleep.
 *
 * The browser drops the lock on its own whenever the window is hidden
 * (minimized) and never restores it — hence re-requesting on
 * `visibilitychange` for as long as a backup still wants it. Every failure is
 * swallowed: no wake lock just means the old behavior, never a failed backup.
 */
class ScreenWakeLock {
  constructor() {
    this.sentinel = null;
    this.wanted = false;
    this.onVisibilityChange = () => {
      if (this.wanted && document.visibilityState === 'visible') this.request();
    };
  }

  async acquire() {
    if (this.wanted) return;
    this.wanted = true;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    await this.request();
  }

  async release() {
    if (!this.wanted) return;
    this.wanted = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    const sentinel = this.sentinel;
    this.sentinel = null;
    try {
      if (sentinel) await sentinel.release();
    } catch (err) { /* already released by the browser */ }
  }

  async request() {
    if (this.sentinel && !this.sentinel.released) return;
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      // release() may have run while the request was still pending.
      if (!this.wanted) {
        await sentinel.release();
        return;
      }
      this.sentinel = sentinel;
    } catch (err) {
      console.debug('Simple Backup: could not keep the screen on during the backup', err);
    }
  }
}

module.exports = { ScreenWakeLock };
