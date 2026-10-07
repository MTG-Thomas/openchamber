// Run in a clean CI checkout of the fork's main. No semantic conflict resolution.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const repository = 'mtg-thomas/openchamber';
const base = 'main';
const branch = 'upstream-sync/integration';
if (git('status', '--porcelain')) throw new Error('Upstream intake requires a clean checkout');
git('fetch', 'origin', base);
git('fetch', 'https://github.com/openchamber/openchamber.git', 'main');
const upstream = git('rev-parse', 'FETCH_HEAD');
const fork = git('rev-parse', `origin/${base}`);
const common = git('merge-base', fork, upstream);
const paths = (a, b) => git('diff', '--name-only', a, b).split('\n').filter(Boolean);
const patch = new Set(paths(common, fork));
const overlap = paths(common, upstream).filter((path) => patch.has(path));
git('checkout', '-B', branch, fork);
if (spawnSync('git', ['merge-base', '--is-ancestor', upstream, fork]).status === 0) process.exit(0);
git('config', 'user.name', 'OpenChamber upstream intake');
git('config', 'user.email', 'upstream-intake@users.noreply.github.com');
const merged = spawnSync('git', ['merge', '--no-edit', upstream], { encoding: 'utf8' });
let conflicts = [];
if (merged.status !== 0) {
  conflicts = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  git('merge', '--abort');
  if (!conflicts.length) throw new Error('Upstream merge failed without merge conflicts');
  const report = `# Upstream integration blocked\n\nUpstream: ${upstream}\nFork: ${fork}\n\nResolve these conflicts manually:\n\n${conflicts.map(path => `- ${path}`).join('\n')}\n`;
  writeFileSync('docs/fork/upstream-conflicts.md', report);
  git('add', 'docs/fork/upstream-conflicts.md');
  git('commit', '-m', 'docs(sync): report unresolved upstream integration conflicts');
}
// Only this workflow owns this branch; lease prevents overwriting a concurrent update.
spawnSync('git', ['fetch', 'origin', branch], { stdio: 'ignore' });
git('push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`);
const body = `## What and why\n\nIntegrate upstream ${upstream} into our patch queue at ${fork}.\n\n${conflicts.length ? 'BLOCKED: this branch contains a conflict report only. No conflicted code was integrated. Resolve manually before review.' : 'Merge candidate; no semantic conflicts were resolved automatically.'}\n\n## Patch overlap\n\n${overlap.map(path => `- ${path}`).join('\n') || 'No overlap.'}\n\n## Validation\n\nRun the fork checks workflow on this branch. GITHUB_TOKEN PR creation does not trigger PR workflows; the intake workflow explicitly dispatches checks. Conflicts require manual integration and fresh checks.\n`;
writeFileSync('/tmp/openchamber-upstream-pr.md', body);
const existing = execFileSync('gh', ['pr', 'list', '--repo', repository, '--head', branch, '--base', base, '--state', 'open', '--json', 'number'], { encoding: 'utf8' });
const prs = JSON.parse(existing);
const args = prs.length ? ['pr', 'edit', String(prs[0].number)] : ['pr', 'create', '--head', branch, '--base', base];
execFileSync('gh', [...args, '--repo', repository, '--title', conflicts.length ? 'Upstream integration blocked: manual conflicts' : 'Integrate upstream OpenChamber', '--body-file', '/tmp/openchamber-upstream-pr.md'], { stdio: 'inherit' });
if (!conflicts.length) execFileSync('gh', ['workflow', 'run', 'fork-checks.yml', '--repo', repository, '--ref', branch], { stdio: 'inherit' });
