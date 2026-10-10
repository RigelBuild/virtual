import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./release-tag.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'virtual-release-tag-'));
const repo = join(dir, 'repo');
const bin = join(dir, 'bin');
const ghLog = join(dir, 'gh.log');
const ghMarker = join(dir, 'gh-marker');
mkdirSync(repo);
mkdirSync(bin);
writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2).join(' ');
if (args.includes('--method POST') || args.includes('git/ref/tags/')) {
  appendFileSync(process.env.GH_LOG, args + '\\n');
}
if (args.includes('--method POST')) {
  if (process.env.GH_MODE === 'collision') {
    writeFileSync(process.env.GH_MARKER, 'exists');
    console.error('Reference already exists');
    console.error('HTTP 422');
    process.exit(1);
  }
  process.exit(0);
}
if (args.includes('git/ref/tags/')) {
  if (process.env.GH_MODE === 'existing') process.exit(0);
  if (process.env.GH_MODE === 'collision' && existsSync(process.env.GH_MARKER)) {
    console.log(process.env.GH_EXISTING_SHA);
    process.exit(0);
  }
  process.exit(1);
}
console.error('unexpected gh call:', args);
process.exit(2);
`);
const chmod = spawnSync('chmod', ['+x', join(bin, 'gh')], { encoding: 'utf8' });
assert.equal(chmod.status, 0, chmod.stderr);

const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  GH_LOG: ghLog,
  GH_MARKER: ghMarker,
};
function git(args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function versionCommit(version) {
  mkdirSync(join(repo, 'packages/solid-virtual'), { recursive: true });
  writeFileSync(join(repo, 'packages/solid-virtual/package.json'), JSON.stringify({ name: '@rigelbuild/solid-virtual', version }));
  git(['add', '.']);
  git(['commit', '-q', '-m', version]);
  return git(['rev-parse', 'HEAD']);
}
function invoke(args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, ...extraEnv } });
}

try {
  const init = spawnSync('git', ['init', '-q', '-b', 'rigel-release'], { cwd: repo, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.invalid']);
  const old = versionCommit('3.17.0-rigel.8');
  const base = old;
  const next = versionCommit('3.17.0-rigel.9');
  git(['tag', 'v3.17.0-rigel.8', old]);
  writeFileSync(join(repo, 'vendor.txt'), 'vendor refresh');
  git(['add', 'vendor.txt']);
  git(['commit', '-q', '-m', 'vendor refresh']);
  const noop = git(['rev-parse', 'HEAD']);
  let result = invoke(['check-pr', base, next]);
  assert.equal(result.status, 0, result.stderr);
  console.log('ok   next tracking release passes PR check');

  const skipped = versionCommit('3.17.0-rigel.10');
  result = invoke(['check-pr', next, skipped]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected 3\.17\.0-rigel\.9/);
  console.log('ok   skipped tracking suffix fails PR check');

  git(['checkout', '-q', '-b', 'vendor-refresh', next]);
  writeFileSync(join(repo, 'vendor.txt'), 'refreshed');
  git(['add', 'vendor.txt']);
  git(['commit', '-q', '-m', 'vendor refresh']);
  const unchanged = git(['rev-parse', 'HEAD']);
  result = invoke(['check-pr', next, unchanged]);
  assert.equal(result.status, 0, result.stderr);
  console.log('ok   vendor update without a version bump passes PR check');

  result = invoke(['mint', unchanged, 'RigelBuild/virtual']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(ghLog, 'utf8'), /refs\/tags\/v3\.17\.0-rigel\.9/);
  assert.match(readFileSync(ghLog, 'utf8'), new RegExp(`sha=${next}`));
  console.log('ok   mint creates tracking tag at version-setting commit');

  const before = readFileSync(ghLog, 'utf8');
  result = invoke(['mint', unchanged, 'RigelBuild/virtual'], { GH_MODE: 'existing' });
  assert.equal(result.status, 0, result.stderr);
  const after = readFileSync(ghLog, 'utf8');
  assert.equal(after.split('--method POST').length, before.split('--method POST').length);
  console.log('ok   existing remote release tag is a no-op');

  result = invoke(['mint', next, 'RigelBuild/virtual'], { GH_MODE: 'collision', GH_EXISTING_SHA: next });
  assert.equal(result.status, 0, result.stderr);
  console.log('ok   same-target 422 succeeds');
  rmSync(ghMarker, { force: true });
  result = invoke(['mint', next, 'RigelBuild/virtual'], { GH_MODE: 'collision', GH_EXISTING_SHA: old });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already exists at .*expected/);
  console.log('ok   conflicting 422 fails');

  mkdirSync(join(repo, 'packages/solid-virtual'), { recursive: true });
  writeFileSync(join(repo, 'packages/solid-virtual/package.json'), JSON.stringify({ name: '@rigelbuild/solid-virtual', version: '3.0.0-rc.0' }));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'existing rc release']);
  const rc = git(['rev-parse', 'HEAD']);
  git(['tag', 'v3.0.0-rc.0', rc]);
  const rcMint = invoke(['mint', rc, 'RigelBuild/virtual']);
  assert.equal(rcMint.status, 0, rcMint.stderr);
  assert.match(rcMint.stdout, /already exists; nothing to mint/);
  console.log('ok   existing v3.0.0-rc.0 remains a mint no-op');

  mkdirSync(join(repo, 'packages/solid-virtual'), { recursive: true });
  writeFileSync(join(repo, 'packages/solid-virtual/package.json'), JSON.stringify({ name: '@rigelbuild/solid-virtual', version: '3.17.0-rigel.10' }));
  git(['add', '.']);
  git(['commit', '-q', '-m', 'multi-digit tracking version']);
  const multiDigit = git(['rev-parse', 'HEAD']);
  git(['tag', 'v3.17.0-rigel.9', next]);
  const multiDigitCheck = invoke(['check-pr', next, multiDigit]);
  assert.equal(multiDigitCheck.status, 0, multiDigitCheck.stderr);
  console.log('ok   decimal suffix ordering accepts 10 after 9');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
