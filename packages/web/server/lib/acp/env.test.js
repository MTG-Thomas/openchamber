import { afterEach, describe, expect, it } from 'vitest';
import { isAcpEnabled, resolveAcpRegistryDir } from './env.js';

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
