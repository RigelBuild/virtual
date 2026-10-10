import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited with ${result.status}`);
  }
  return result.stdout.trim();
}

function main() {
  const { EVENT_NAME, REF, GITHUB_OUTPUT } = process.env;
  if (EVENT_NAME === 'workflow_dispatch') {
    appendFileSync(GITHUB_OUTPUT, 'publish=false\n');
    console.log('workflow_dispatch is a no-op; nothing to publish');
    return;
  }
  if (EVENT_NAME !== 'push' || !REF?.startsWith('refs/tags/')) {
    throw new Error(`publisher accepts only tag pushes; event=${EVENT_NAME} ref=${REF}`);
  }

  const tag = REF.slice('refs/tags/'.length);
  const match = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rigel\.([1-9][0-9]*)$/.exec(tag);
  if (!match) throw new Error(`tag ${tag} does not match the required vX.Y.Z-rigel.N shape`);

  const commit = run('git', ['rev-parse', '--verify', `${REF}^{commit}`]);
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/rigel-release'], { encoding: 'utf8' });
  if (ancestry.error) throw ancestry.error;
  if (ancestry.status !== 0) {
    throw new Error(`${commit} from ${REF} is not reachable from origin/rigel-release`);
  }

  const packageJson = JSON.parse(run('git', ['show', `${commit}:packages/solid-virtual/package.json`]));
  if (tag !== `v${packageJson.version}`) {
    throw new Error(`tag ${tag} does not match packages/solid-virtual/package.json version ${packageJson.version}`);
  }

  appendFileSync(GITHUB_OUTPUT, 'publish=true\n');
  console.log(`${tag} is reachable from rigel-release and matches package version ${packageJson.version}`);
}

try {
  main();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
