import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAcpEnabled, resolveAcpRegistryDir, getStartupAcpConfig } from './env.js';
import { writeAcpAgentConfig, clearAcpAgentConfig } from './acp-config.js';

const cases = [
  ['true', true],
  ['1', true],
  ['false', false],
  ['0', false],
  ['', false],
  [undefined, false],
];

describe('isAcpEnabled', () => {
  afterEach(() => { delete process.env.OPENCHAMBER_ACP_ENABLED; });

  it.each(cases)('returns %s for OPENCHAMBER_ACP_ENABLED=%s', (value, expected) => {
    if (value !== undefined) process.env.OPENCHAMBER_ACP_ENABLED = value;
    else delete process.env.OPENCHAMBER_ACP_ENABLED;
    expect(isAcpEnabled()).toBe(expected);
  });

  it('defaults to off (OpenCode remains the default backend)', () => {
    delete process.env.OPENCHAMBER_ACP_ENABLED;
    expect(isAcpEnabled()).toBe(false);
  });
});

describe('resolveAcpRegistryDir', () => {
  afterEach(() => { delete process.env.OPENCHAMBER_ACP_AGENT_REGISTRY; });

  it('honors the OPENCHAMBER_ACP_AGENT_REGISTRY override', () => {
    process.env.OPENCHAMBER_ACP_AGENT_REGISTRY = '/tmp/acp-test-registry';
    expect(resolveAcpRegistryDir()).toBe('/tmp/acp-test-registry');
  });

  it('returns null when no override is set', () => {
    delete process.env.OPENCHAMBER_ACP_AGENT_REGISTRY;
    expect(resolveAcpRegistryDir()).toBeNull();
  });
});

describe('persisted ACP agent config', () => {
  const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
  const originalCommand = process.env.OPENCHAMBER_ACP_COMMAND;
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
    if (originalCommand === undefined) delete process.env.OPENCHAMBER_ACP_COMMAND;
    else process.env.OPENCHAMBER_ACP_COMMAND = originalCommand;
  });

  it('is stored in and read from OPENCHAMBER_DATA_DIR', () => {
    delete process.env.OPENCHAMBER_ACP_COMMAND;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-config-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    try {
      writeAcpAgentConfig({ command: 'my-agent', agentId: 'a1' });
      expect(fs.existsSync(path.join(dataDir, 'acp-agent-config.json'))).toBe(true);
      expect(getStartupAcpConfig()).toMatchObject({ command: 'my-agent', agentId: 'a1' });

      clearAcpAgentConfig();
      expect(fs.existsSync(path.join(dataDir, 'acp-agent-config.json'))).toBe(false);
      expect(getStartupAcpConfig()).toBeNull();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
