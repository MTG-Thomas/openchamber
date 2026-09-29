import { describe, expect, test } from 'bun:test';
import type { AgentClient } from './types';

// active-client holds a module-level mutable. Tests verify the default and the
// override/reset behavior.

const { getActiveAgentClient, setActiveAgentClient } = await import('./active-client');
const { opencodeClient } = await import('../opencode/client');

const fakeClient = (backend: 'acp'): AgentClient => ({
  backend,
  capabilities: () => ({ canCancel: true }),
  createSession: () => Promise.resolve({} as never),
  sendMessage: () => Promise.resolve(''),
  abortSession: () => Promise.resolve(true),
});

describe('active-client selector', () => {
  test('defaults to the OpenCode client', () => {
    setActiveAgentClient(null);
    expect(getActiveAgentClient().backend).toBe('opencode');
  });

  test('returns the overridden client after setActiveAgentClient', () => {
    const acp = fakeClient('acp');
    setActiveAgentClient(acp);
    expect(getActiveAgentClient()).toBe(acp);
    expect(getActiveAgentClient().backend).toBe('acp');
  });

  test('resets to OpenCode on null', () => {
    setActiveAgentClient(fakeClient('acp'));
    setActiveAgentClient(null);
    expect(getActiveAgentClient()).toBe(opencodeClient);
    expect(getActiveAgentClient().backend).toBe('opencode');
  });
});
