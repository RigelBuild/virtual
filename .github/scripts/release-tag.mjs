import { spawnSync } from 'node:child_process';

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rigel\.([1-9][0-9]*)$/;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function versionAt(commit, required = true) {
  try {
    const packageJson = JSON.parse(run('git', ['show', `${commit}:packages/solid-virtual/package.json`]));
    if (typeof packageJson.version !== 'string') throw new Error('package version is not a string');
    return packageJson.version;
  } catch (error) {
    if (!required) return undefined;
    throw error;
  }
}

function incrementDecimal(value) {
  const digits = [...value];
  let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    if (digits[index] === '9') digits[index] = '0';
    else {
      digits[index] = String(Number(digits[index]) + 1);
      carry = 0;
    }
  }
  return carry === 1 ? `1${digits.join('')}` : digits.join('');
}

function validateNextVersion(version) {
  const match = versionPattern.exec(version);
  if (!match) throw new Error(`version '${version}' does not match the required X.Y.Z-rigel.N shape`);

  const [, major, minor, patch] = match;
  const base = `${major}.${minor}.${patch}`;
  const tags = run('git', ['tag', '--list', `v${base}-rigel.*`]).split('\n').filter(Boolean);
  const suffixes = tags.flatMap((tag) => {
    const tagMatch = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rigel\.([1-9][0-9]*)$/.exec(tag);
    return tagMatch && `${tagMatch[1]}.${tagMatch[2]}.${tagMatch[3]}` === base ? [tagMatch[4]] : [];
  });
  const max = suffixes.reduce((current, item) => item.length > current.length || (item.length === current.length && item > current) ? item : current, '0');
  const expected = `${base}-rigel.${incrementDecimal(max)}`;
  if (version !== expected) throw new Error(`expected ${expected}, got ${version}`);
}

function checkPr(baseSha, headSha) {
  const diff = spawnSync('git', ['diff', '--quiet', baseSha, headSha, '--', 'packages/solid-virtual/package.json'], { encoding: 'utf8' });
  if (diff.error) throw diff.error;
  if (diff.status === 0) {
    console.log('packages/solid-virtual/package.json is unchanged; no release version check is needed');
    return;
  }
  if (diff.status !== 1) throw new Error(diff.stderr.trim() || `git diff exited with ${diff.status}`);

  const baseVersion = versionAt(baseSha);
  const headVersion = versionAt(headSha);
  if (baseVersion === headVersion) {
    console.log('package.json version is unchanged; no release version check is needed');
    return;
  }
  validateNextVersion(headVersion);
  console.log(`${headVersion} is the next release version`);
}

function tagExists(tag, repository) {
  const local = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], { encoding: 'utf8' });
  if (local.error) throw local.error;
  if (local.status === 0) return true;
  if (local.status !== 1) throw new Error(local.stderr.trim() || `git show-ref exited with ${local.status}`);

  const remote = spawnSync('gh', ['api', `repos/${repository}/git/ref/tags/${tag}`], { encoding: 'utf8' });
  if (remote.error) throw remote.error;
  return remote.status === 0;
}

function mint(sha, repository) {
  const version = versionAt(sha);
  const tag = `v${version}`;
  if (tagExists(tag, repository)) {
    console.log(`${tag} already exists; nothing to mint`);
    return;
  }

  let target = sha;
  while (true) {
    const parent = spawnSync('git', ['rev-parse', '--verify', `${target}^1`], { encoding: 'utf8' });
    if (parent.error) throw parent.error;
    if (parent.status !== 0) break;
    const parentSha = parent.stdout.trim();
    if (versionAt(parentSha, false) !== version) break;
    target = parentSha;
  }

  validateNextVersion(version);
  const created = spawnSync('gh', [
    'api', '--method', 'POST', `repos/${repository}/git/refs`,
    '-f', `ref=refs/tags/${tag}`, '-f', `sha=${target}`,
  ], { encoding: 'utf8' });
  if (created.error) throw created.error;
  if (created.status === 0) {
    console.log(`Created ${tag} at ${target}`);
    return;
  }

  const response = `${created.stdout}${created.stderr}`;
  if (response.includes('HTTP 422') && response.includes('Reference already exists')) {
    const existing = run('gh', ['api', `repos/${repository}/git/ref/tags/${tag}`, '--jq', '.object.sha']);
    if (existing === target) {
      console.log(`${tag} already points at ${target}`);
      return;
    }
    throw new Error(`${tag} already exists at ${existing}, expected ${target}`);
  }
  throw new Error(response.trim() || `gh api exited with ${created.status}`);
}

function main(args) {
  const [command, ...values] = args;
  if (command === 'check-pr' && values.length === 2) return checkPr(values[0], values[1]);
  if (command === 'mint' && values.length === 2) return mint(values[0], values[1]);
  throw new Error('Usage: release-tag.mjs check-pr <base-sha> <head-sha> | mint <sha> <owner/repo>');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
