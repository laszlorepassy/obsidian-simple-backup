'use strict';

// Bundles src/main.js + backup-core.js into a single, self-contained main.js
// at the repo root. This is what actually gets installed/released — Obsidian's
// community plugin installer and BRAT only ever fetch manifest.json, main.js,
// and styles.css, so main.js can't have a require('./backup-core') that
// points at a file they never download.
const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['src/main.js'],
  outfile: 'main.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  external: ['obsidian', 'electron'],
});

console.log('Built main.js from src/main.js + backup-core.js');
