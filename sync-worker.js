#!/usr/bin/env node
'use strict';

/**
 * Keeps main.js's embedded copy of backup-worker.js in sync.
 *
 * Obsidian's built-in plugin installer only downloads manifest.json, main.js,
 * and styles.css from a release, so backup-worker.js can't ship as a separate
 * file for real community-plugin installs. Instead, main.js embeds its full
 * source as a string (between the WORKER_SOURCE markers below) and writes it
 * to the plugin folder at runtime.
 *
 * Run this after editing backup-worker.js: node sync-worker.js
 */

const fs = require('fs');
const path = require('path');

const workerPath = path.join(__dirname, 'backup-worker.js');
const mainPath = path.join(__dirname, 'main.js');

const workerSource = fs.readFileSync(workerPath, 'utf8');
const escaped = workerSource
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${');

const mainSource = fs.readFileSync(mainPath, 'utf8');
const startMarker = '// WORKER_SOURCE_START';
const endMarker = '// WORKER_SOURCE_END';
const startIdx = mainSource.indexOf(startMarker);
const endIdx = mainSource.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error('Could not find WORKER_SOURCE markers in main.js');
  process.exit(1);
}

const before = mainSource.slice(0, startIdx + startMarker.length);
const after = mainSource.slice(endIdx);
const block = `\nconst WORKER_SOURCE = \`${escaped}\`;\n`;

fs.writeFileSync(mainPath, before + block + after, 'utf8');
console.log('main.js updated with the latest backup-worker.js source.');
