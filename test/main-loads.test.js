'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

test('main.js loads and exports the plugin class (with a stubbed obsidian module)', () => {
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    if (request === 'obsidian') {
      return path.join(__dirname, 'obsidian-stub.js');
    }
    return origResolve.call(this, request, ...args);
  };
  try {
    delete require.cache[require.resolve('../main.js')];
    const SimpleBackupPlugin = require('../main.js');
    assert.equal(typeof SimpleBackupPlugin, 'function');
  } finally {
    Module._resolveFilename = origResolve;
    delete require.cache[require.resolve('../main.js')];
  }
});
