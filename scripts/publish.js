#!/usr/bin/env node
'use strict';

// Release script: tags the current version, pushes it, and creates a
// matching GitHub release with the exact assets Obsidian's community
// plugin installer / BRAT expect (manifest.json, main.js, styles.css
// if present). Run this after bumping the version in manifest.json,
// package.json and versions.json and committing that bump.
//
// Usage:
//   node scripts/publish.js            do the release
//   node scripts/publish.js --dry-run  run all checks, change nothing

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function sh(cmd, args, opts = {}) {
  // On Windows, npm is a .cmd shim, which Node refuses to spawn directly
  // without shell:true. Only turn shell:true on for that one case — it
  // mangles quoting of multi-word args (e.g. `git tag -m "..."`), and
  // git/gh are plain .exe files that don't need it.
  let shell = false;
  if (process.platform === 'win32' && cmd === 'npm') {
    cmd = 'npm.cmd';
    shell = true;
  }
  const result = execFileSync(cmd, args, { cwd: root, encoding: 'utf8', shell, ...opts });
  return typeof result === 'string' ? result.trim() : result;
}

function fail(message) {
  console.error(`\nRelease aborted: ${message}`);
  process.exit(1);
}

function step(label) {
  console.log(`\n== ${label} ==`);
}

// --- 1. Clean working tree, on main, up to date with remote tags -------

step('Checking git state');

const branch = sh('git', ['branch', '--show-current']);
if (branch !== 'main') {
  fail(`releases are cut from "main", but current branch is "${branch}"`);
}

const status = sh('git', ['status', '--porcelain']);
if (status !== '') {
  fail('working tree is not clean — commit or stash your changes first');
}

// --- 2. Version consistency across manifest/package/versions -----------

step('Checking version metadata');

const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
const versions = readJson('versions.json');
const version = manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`manifest.json version "${version}" doesn't look like semver`);
}
if (pkg.version !== version) {
  fail(`package.json version (${pkg.version}) != manifest.json version (${version})`);
}
if (versions[version] !== manifest.minAppVersion) {
  fail(`versions.json is missing an entry "${version}": "${manifest.minAppVersion}"`);
}

console.log(`Releasing version ${version} (minAppVersion ${manifest.minAppVersion})`);

// --- 3. Make sure this version hasn't been released already ------------

step('Checking for an existing release');

const localTag = sh('git', ['tag', '-l', version]);
if (localTag !== '') {
  fail(`local tag ${version} already exists`);
}
const remoteTag = sh('git', ['ls-remote', '--tags', 'origin', version]);
if (remoteTag !== '') {
  fail(`tag ${version} already exists on origin`);
}

// --- 4. Tests must pass --------------------------------------------------

step('Running tests');
sh('npm', ['test'], { stdio: 'inherit' });

// --- 5. Rebuild main.js and make sure it matches what's committed ------

step('Rebuilding main.js from src/ and checking it is up to date');
sh('node', ['build.js'], { stdio: 'inherit' });

const mainDiff = sh('git', ['status', '--porcelain', 'main.js']);
if (mainDiff !== '') {
  fail('build.js changed main.js — src/ and the committed main.js are out of sync; commit the rebuilt main.js and try again');
}

// --- 6. Push the commit, tag it, push the tag ---------------------------

const ahead = sh('git', ['rev-list', '--count', 'origin/main..HEAD']);

if (dryRun) {
  console.log(`\nDry run OK. Would push ${ahead} commit(s), tag ${version}, push the tag, and let the release workflow publish it.`);
  process.exit(0);
}

step('Pushing main');
if (ahead !== '0') {
  sh('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
} else {
  console.log('origin/main already up to date');
}

// Use the "Bump to X: ..." commit subject as release notes when one exists
// for this version (it needn't be HEAD — other commits may have landed on
// top of the bump before this release was cut). The notes travel in the tag
// message; the release workflow turns them into the GitHub release notes
// (or generates notes when there are none).
const bumpSubject = sh('git', [
  'log', '-1', '--format=%s',
  `--grep=^Bump to ${version.replace(/\./g, '\\.')}:`,
]);
const bumpMatch = bumpSubject.match(new RegExp(`^Bump to ${version.replace(/\./g, '\\.')}:\\s*(.+)$`));
const tagMessage = bumpMatch ? `Release ${version}\n\n${bumpMatch[1]}` : `Release ${version}`;

step(`Tagging ${version}`);
sh('git', ['tag', '-a', version, '-m', tagMessage]);
sh('git', ['push', 'origin', version], { stdio: 'inherit' });

// --- 7. The release workflow builds, attests and publishes -------------

// Releases are created by .github/workflows/release.yml, so that the assets are
// built on GitHub and carry build-provenance attestations.
step('Waiting for the release workflow (.github/workflows/release.yml)');
let runId = '';
for (let i = 0; i < 20 && !runId; i++) {
  runId = sh('gh', ['run', 'list', '--workflow', 'release.yml', '--branch', version, '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId // empty']);
  if (!runId) execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 3000)']);
}
if (!runId) {
  fail(`tag ${version} was pushed, but no release workflow run appeared; check the Actions tab`);
}
try {
  sh('gh', ['run', 'watch', runId, '--exit-status'], { stdio: 'inherit' });
} catch (err) {
  fail(`the release workflow failed (tag ${version} is already pushed); see: gh run view ${runId} --log-failed`);
}

console.log(`\nDone. Released ${version}.`);
