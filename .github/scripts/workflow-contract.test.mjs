import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const publisherPath = join(root, '.github/workflows/publish-rigelbuild.yml');
const resolverPath = join(scriptsDir, 'resolve-release-source.mjs');
const releasePath = join(root, '.github/workflows/release-tag.yaml');
const publisher = readFileSync(publisherPath, 'utf8');
const release = readFileSync(releasePath, 'utf8');

function passes(name, condition) {
  assert.ok(condition, `FAIL ${name}`);
  console.log(`ok   ${name}`);
}

passes(
  'publisher tag glob accepts only tracking releases',
  /tags:\s*\n\s*-\s*'v\*\.\*\.\*-rigel\.\*'/.test(publisher),
);
passes(
  'resolve gates publisher output and has a dispatch no-op path',
  /outputs:\s*\n\s*publish: \$\{\{ steps\.resolve\.outputs\.publish \}\}/.test(publisher)
    && /needs: \[resolve\]/.test(publisher)
    && /needs\.resolve\.outputs\.publish == 'true'/.test(publisher)
    && /name: Resolve and validate release tag/.test(publisher),
);
const resolver = readFileSync(resolverPath, 'utf8');
passes(
  'publisher resolve checks tag shape, ancestry, and package version',
  resolver.includes('const match = /^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-rigel\\.([1-9][0-9]*)$/')
    && resolver.includes("['merge-base', '--is-ancestor', commit, 'origin/rigel-release']")
    && resolver.includes('tag !== `v${packageJson.version}`'),
);

const tempDir = mkdtempSync(join(tmpdir(), 'virtual-dispatch-'));
try {
  const outputPath = join(tempDir, 'github-output');
  const dispatch = spawnSync(process.execPath, [resolverPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVENT_NAME: 'workflow_dispatch',
      REF: 'refs/heads/rigel-release',
      GITHUB_OUTPUT: outputPath,
    },
  });
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.equal(readFileSync(outputPath, 'utf8'), 'publish=false\n');
  assert.match(dispatch.stdout, /workflow_dispatch is a no-op/);
  console.log('ok   workflow_dispatch is a no-op');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
passes(
  'release-tag Requirement 1 workflow shape',
  /^'on':\s*$/m.test(release)
    && /pull_request:\s*\n\s*branches: \[rigel-release\]/.test(release)
    && /push:\s*\n\s*branches: \[rigel-release\]/.test(release)
    && /workflow_dispatch:/.test(release)
    && /^permissions:\s*\n\s*contents: read/m.test(release)
    && /check:\s*\n\s*if: github\.event_name == 'pull_request'[\s\S]*?permissions:\s*\n\s*contents: read/.test(release)
    && /mint:\s*\n\s*if: github\.event_name != 'pull_request'[\s\S]*?environment: rigel-release/.test(release)
    && /name: Require release-branch dispatch[\s\S]*?github\.ref != 'refs\/heads\/rigel-release'[\s\S]*?name: Checkout[\s\S]*?fetch-depth: 0/.test(release)
    && /name: Create scoped release App token[\s\S]*?uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3\.2\.0[\s\S]*?client-id: \$\{\{ vars\.AUTOMATION_APP_CLIENT_ID \}\}[\s\S]*?private-key: \$\{\{ secrets\.AUTOMATION_APP_PRIVATE_KEY \}\}[\s\S]*?permission-contents: write[\s\S]*?repositories: virtual/.test(release)
    && /Mint release tag if needed[\s\S]*?release-tag\.mjs mint/.test(release)
    && !/^\s*concurrency:/m.test(release),
);
const guardDir = mkdtempSync(join(tmpdir(), 'virtual-publisher-guard-'));
try {
  const runGit = (args) => {
    const result = spawnSync('git', args, { cwd: guardDir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const init = spawnSync('git', ['init', '-q', '-b', 'rigel-release'], { cwd: guardDir, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  runGit(['config', 'user.name', 'test']);
  runGit(['config', 'user.email', 'test@example.invalid']);
  mkdirSync(join(guardDir, 'packages/solid-virtual'), { recursive: true });
  writeFileSync(join(guardDir, 'packages/solid-virtual/package.json'), JSON.stringify({ version: '3.0.0-rigel.1' }));
  runGit(['add', '.']);
  runGit(['commit', '-q', '-m', 'release']);
  const commit = runGit(['rev-parse', 'HEAD']);
  runGit(['update-ref', 'refs/remotes/origin/rigel-release', commit]);
  runGit(['tag', 'v3.0.0-rigel.1', commit]);

  const accepted = spawnSync(process.execPath, [resolverPath], {
    cwd: guardDir,
    encoding: 'utf8',
    env: { ...process.env, EVENT_NAME: 'push', REF: 'refs/tags/v3.0.0-rigel.1', GITHUB_OUTPUT: join(guardDir, 'accepted-output') },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(readFileSync(join(guardDir, 'accepted-output'), 'utf8'), 'publish=true\n');
  console.log('ok   valid release tag passes shape, ancestry, and version guards');

  runGit(['tag', 'v3.0.0-rigel.2', commit]);
  const rejected = spawnSync(process.execPath, [resolverPath], {
    cwd: guardDir,
    encoding: 'utf8',
    env: { ...process.env, EVENT_NAME: 'push', REF: 'refs/tags/v3.0.0-rigel.2', GITHUB_OUTPUT: join(guardDir, 'rejected-output') },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not match packages\/solid-virtual\/package\.json version 3\.0\.0-rigel\.1/);
  console.log('ok   release tag mismatching package version is rejected');
  const sideCommit = runGit(['commit-tree', `${commit}^{tree}`, '-m', 'detached tag']);
  runGit(['tag', 'v3.0.0-rigel.3', sideCommit]);
  const detached = spawnSync(process.execPath, [resolverPath], {
    cwd: guardDir,
    encoding: 'utf8',
    env: { ...process.env, EVENT_NAME: 'push', REF: 'refs/tags/v3.0.0-rigel.3', GITHUB_OUTPUT: join(guardDir, 'detached-output') },
  });
  assert.notEqual(detached.status, 0);
  assert.match(detached.stderr, /not reachable from origin\/rigel-release/);
  console.log('ok   release tag outside rigel-release ancestry is rejected');
} finally {
  rmSync(guardDir, { recursive: true, force: true });
}
