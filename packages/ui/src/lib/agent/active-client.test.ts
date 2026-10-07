import { describe, expect, test } from 'bun:test';
import type { Session } from '../opencode/model';
import type { AgentClient } from './types';

// active-client holds a module-level mutable. Tests verify the default and the
// override/reset behavior.

const { getActiveAgentClient, setActiveAgentClient, replaceSessionAgentClients, getSessionAgentClient } = await import('./active-client');
const { opencodeClient } = await import('../opencode/client');

const fakeClient = (backend: 'acp'): AgentClient => ({
  backend,
  capabilities: () => ({ canCancel: true }),
  createSession: async () => { throw new Error('Not used in this test'); },
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

const ownedSession = (agentId: string): Session => ({
  id: 'same', projectID: 'repo', directory: '/repo', title: 'Muse',
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, metadata: { openchamber: { acp: true, agentId } },
});
test('existing sessions follow backend ownership while drafts use a different selection', () => {
  const muse = fakeClient('acp');
  replaceSessionAgentClients([['muse', muse]]);
  setActiveAgentClient(null);
  expect(getSessionAgentClient(ownedSession('muse'))).toBe(muse);
  setActiveAgentClient(muse);
  expect(getSessionAgentClient(undefined)).toBe(opencodeClient);
  expect(getSessionAgentClient({ ...ownedSession('muse'), metadata: {} })).toBe(opencodeClient);
  expect(() => getSessionAgentClient(ownedSession('other'))).toThrow('owns this session');
  setActiveAgentClient(null); replaceSessionAgentClients([]);
});
