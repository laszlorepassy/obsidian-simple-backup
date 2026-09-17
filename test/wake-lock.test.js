'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ScreenWakeLock } = require('../src/wake-lock');

function setup({ wakeLock } = {}) {
  const state = { visibility: 'visible', listeners: [], sentinels: [], requests: 0 };
  const request = async (type) => {
    assert.equal(type, 'screen');
    state.requests++;
    const sentinel = { released: false, releaseCalls: 0, async release() { this.released = true; this.releaseCalls++; } };
    state.sentinels.push(sentinel);
    return sentinel;
  };
  globalThis.navigator = { wakeLock: wakeLock === undefined ? { request } : wakeLock };
  globalThis.document = {
    get visibilityState() { return state.visibility; },
    addEventListener: (_, l) => state.listeners.push(l),
    removeEventListener: (_, l) => { state.listeners = state.listeners.filter((x) => x !== l); },
  };
  return state;
}

function teardown() {
  delete globalThis.document;
  // navigator is a read-only getter on newer Node; restore by redefining.
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
}

// Newer Node exposes a non-writable `navigator`; make it assignable for the tests.
Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });

test('holds a screen lock until released', async () => {
  const state = setup();
  const lock = new ScreenWakeLock();
  await lock.acquire();
  assert.equal(state.requests, 1);
  await lock.release();
  assert.equal(state.sentinels[0].releaseCalls, 1);
  assert.equal(state.listeners.length, 0);
  teardown();
});

test('re-requests the lock when the window becomes visible again', async () => {
  const state = setup();
  const lock = new ScreenWakeLock();
  await lock.acquire();
  state.sentinels[0].released = true; // the browser dropped it while hidden
  state.listeners.forEach((l) => l());
  await new Promise((r) => setImmediate(r));
  assert.equal(state.requests, 2);
  await lock.release();
  assert.equal(state.sentinels[1].releaseCalls, 1);
  teardown();
});

test('gives back a lock that arrives after release was already called', async () => {
  const state = setup();
  const lock = new ScreenWakeLock();
  const acquiring = lock.acquire();
  await lock.release();
  await acquiring;
  assert.equal(state.sentinels[0].releaseCalls, 1);
  teardown();
});

test('does nothing where the API is missing or refuses', async () => {
  setup({ wakeLock: null });
  await new ScreenWakeLock().acquire();
  teardown();
  setup({ wakeLock: { request: async () => { throw new Error('NotAllowedError'); } } });
  const origDebug = console.debug;
  console.debug = () => {};
  try {
    const lock = new ScreenWakeLock();
    await lock.acquire();
    await lock.release();
  } finally {
    console.debug = origDebug;
    teardown();
  }
});
