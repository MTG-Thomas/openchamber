import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/fork/upstream-sync.mjs');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
for (const conflict of [false, true]) test(`upstream intake ${conflict ? 'reports conflicts without merging' : 'merges a clean candidate and dispatches checks'}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'openchamber-intake-'));
  const upstream = join(root, 'upstream');
  const fork = join(root, 'fork.git');
  const checkout = join(root, 'checkout');
  const bin = join(root, 'bin');
  const calls = join(root, 'gh-calls.jsonl');
  const git = (cwd, ...args) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(upstream); mkdirSync(bin);
    git(upstream, 'init', '-b', 'main');
    git(upstream, 'config', 'user.name', 'fixture'); git(upstream, 'config', 'user.email', 'fixture@example.test');
    mkdirSync(join(upstream, 'docs/fork'), { recursive: true });
    writeFileSync(join(upstream, 'docs/fork/note.md'), 'base\n');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'base');
    git(root, 'clone', '--bare', upstream, fork); git(root, 'clone', fork, checkout);
    git(checkout, 'config', 'user.name', 'fixture'); git(checkout, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(join(checkout, 'docs/fork/note.md'), 'fork patch\n');
    git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'fork patch'); git(checkout, 'push', 'origin', 'main');
    writeFileSync(join(upstream, conflict ? 'docs/fork/note.md' : 'upstream.md'), 'upstream change\n');
    git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'upstream change');
    const upstreamHead = git(upstream, 'rev-parse', 'HEAD');
    // Keep all Git operations real; redirect only the external upstream fetch.
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const a=process.argv.slice(2).map(v=>v==='https://github.com/openchamber/openchamber.git'?process.env.FIXTURE_UPSTREAM:v);const r=spawnSync(process.env.FIXTURE_GIT,a,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.includes('list'))process.stdout.write('[]');\n`, { mode: 0o755 });
    execFileSync(process.execPath, [script], { cwd: checkout, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_UPSTREAM: upstream, FIXTURE_GIT: realGit, FIXTURE_CALLS: calls }, stdio: 'pipe' });
    assert.equal(git(checkout, 'branch', '--show-current'), 'upstream-sync/integration');
    assert.equal(git(checkout, 'status', '--porcelain'), '');
    assert.equal(git(checkout, 'show', 'origin/upstream-sync/integration:docs/fork/note.md'), 'fork patch');
    const ghCalls = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(ghCalls.every(args => args.includes('mtg-thomas/openchamber')));
    if (conflict) {
      const report = readFileSync(join(checkout, 'docs/fork/upstream-conflicts.md'), 'utf8');
      assert.ok(report.includes(upstreamHead)); assert.ok(report.includes('docs/fork/note.md'));
      assert.ok(!ghCalls.some(args => args[0] === 'workflow'));
    } else {
      assert.equal(git(checkout, 'show', 'HEAD:upstream.md'), 'upstream change');
      git(checkout, 'merge-base', '--is-ancestor', upstreamHead, 'HEAD');
      assert.ok(ghCalls.some(args => args[0] === 'workflow' && args.includes('fork-checks.yml')));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
