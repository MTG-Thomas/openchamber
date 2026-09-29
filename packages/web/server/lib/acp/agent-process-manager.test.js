import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerAcpAgent,
  unregisterAcpAgent,
  reapOrphanedAcpAgents,
} from './agent-process-manager.js';

const tmpDirs = [];
const makeTmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-pm-'));
  tmpDirs.push(dir);
  return dir;
};

let registryDir;
const previousRegistryEnv = process.env.OPENCHAMBER_ACP_AGENT_REGISTRY;

beforeEach(() => {
  registryDir = makeTmpDir();
  process.env.OPENCHAMBER_ACP_AGENT_REGISTRY = registryDir;
});

afterEach(() => {
  if (typeof previousRegistryEnv === 'string') {
    process.env.OPENCHAMBER_ACP_AGENT_REGISTRY = previousRegistryEnv;
  } else {
    delete process.env.OPENCHAMBER_ACP_AGENT_REGISTRY;
  }
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tmpDirs.length = 0;
});

const entryPath = (pid) => path.join(registryDir, `${pid}.json`);

describe('agent-process-manager registry', () => {
  it('registers a per-pid JSON record with the ACP fields (TC-10)', () => {
    registerAcpAgent({ pid: 4242, agentId: 'agent-1', command: '/usr/local/bin/claude-code' });

    const file = entryPath(4242);
    expect(fs.existsSync(file)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(entry).toMatchObject({
      pid: 4242,
      agentId: 'agent-1',
      command: '/usr/local/bin/claude-code',
      transport: 'stdio',
    });
    expect(entry.ownerPid).toBe(process.pid);
    expect(typeof entry.spawnedAt).toBe('string');
  });

  it('uses one file per pid (no cross-entry write contention) (TC-10)', () => {
    registerAcpAgent({ pid: 100, agentId: 'a', command: 'agent-a' });
    registerAcpAgent({ pid: 200, agentId: 'b', command: 'agent-b' });

    expect(fs.existsSync(entryPath(100))).toBe(true);
    expect(fs.existsSync(entryPath(200))).toBe(true);

    // Re-registering a pid overwrites only that pid's file.
    registerAcpAgent({ pid: 100, agentId: 'a2', command: 'agent-a2' });
    const entry = JSON.parse(fs.readFileSync(entryPath(100), 'utf8'));
    expect(entry.agentId).toBe('a2');
    expect(JSON.parse(fs.readFileSync(entryPath(200), 'utf8')).agentId).toBe('b');
  });

  it('unregisters (removes) a pid record on teardown (TC-10)', () => {
    registerAcpAgent({ pid: 7, agentId: 'a', command: 'agent-a' });
    expect(fs.existsSync(entryPath(7))).toBe(true);

    unregisterAcpAgent(7);
    expect(fs.existsSync(entryPath(7))).toBe(false);
  });
});

describe('agent-process-manager reaper safety', () => {
  it('prunes registry entries whose pid is already dead (TC-10)', async () => {
    // A very high fake pid is effectively guaranteed not to be a live process.
    const deadPid = 9_999_999;
    registerAcpAgent({ pid: deadPid, agentId: 'a', command: 'some-agent', ownerPid: process.pid });

    const result = await reapOrphanedAcpAgents();
    expect(result.inspected).toBe(1);
    // Not reaped (it was already dead), but its file is pruned.
    expect(fs.existsSync(entryPath(deadPid))).toBe(false);
  });

  it('never reaps a process whose owner is still alive and identity does not match (TC-11)', async () => {
    // The test process itself is alive; recorded command won't match the test
    // runner's command line, so the identity check fails and we leave it alone.
    registerAcpAgent({
      pid: process.pid,
      agentId: 'a',
      command: 'definitely-not-the-test-runner-binary',
      ownerPid: process.pid,
    });

    const result = await reapOrphanedAcpAgents();
    expect(result.reaped).toBe(0);
    // File is kept because the process is alive and we did not reap it.
    expect(fs.existsSync(entryPath(process.pid))).toBe(true);
  });

  it('returns empty counts when the registry is empty', async () => {
    const result = await reapOrphanedAcpAgents();
    expect(result).toEqual({ inspected: 0, reaped: 0 });
  });
});
