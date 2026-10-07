import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AgentModelConfig } from '@/lib/agent/types';

const config: AgentModelConfig = {
  configId: 'model', currentValue: 'spark',
  options: [{ value: 'spark', name: 'Spark' }, { value: 'spark-contributor', name: 'Spark Contributor' }],
};
const draftReads: string[] = [];
const draftWrites: Array<[string, string, string]> = [];
const ownerReads: string[] = [];
const draftClient = {
  backend: 'acp',
  listModels: async (sessionId: string) => { draftReads.push(sessionId); return config; },
  setModel: async (sessionId: string, configId: string, value: string) => {
    draftWrites.push([sessionId, configId, value]); return { ...config, currentValue: value };
  },
};
const ownerClient = {
  backend: 'acp',
  listModels: async (sessionId: string) => { ownerReads.push(sessionId); return config; },
};
const ownedSession = { id: 'existing-acp' };
mock.module('@/lib/agent/active-client', () => ({
  getActiveAgentClient: () => draftClient,
  getSessionAgentClient: (session: unknown) => session === ownedSession ? ownerClient : { backend: 'opencode' },
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: { getState: () => ({ entityById: new Map([['existing-acp', ownedSession]]) }) },
}));

const { useAcpModelStore } = await import('./useAcpModelStore');

describe('ACP composer model ownership', () => {
  beforeEach(() => {
    draftReads.length = 0; draftWrites.length = 0; ownerReads.length = 0;
    useAcpModelStore.setState({ bySession: {}, loading: {} });
  });

  test('a new chat lists and selects the draft agent models without sending a fake session ID', async () => {
    await useAcpModelStore.getState().load('acp-new-session');
    expect(useAcpModelStore.getState().bySession['acp-new-session']).toEqual(config);
    await useAcpModelStore.getState().select('acp-new-session', 'spark-contributor');
    expect(draftReads).toEqual(['']);
    expect(draftWrites).toEqual([['', 'model', 'spark-contributor']]);
    expect(useAcpModelStore.getState().bySession['acp-new-session'].currentValue).toBe('spark-contributor');
  });

  test('an existing session uses its owner despite a different draft agent', async () => {
    await useAcpModelStore.getState().load('existing-acp');
    expect(ownerReads).toEqual(['existing-acp']);
    expect(draftReads).toEqual([]);
  });

  test('an unknown existing session does not fall back to the selected draft agent', async () => {
    await useAcpModelStore.getState().load('unknown-session');
    expect(draftReads).toEqual([]);
    expect(useAcpModelStore.getState().bySession['unknown-session']).toBeUndefined();
    expect(useAcpModelStore.getState().loading['unknown-session']).toBe(false);
  });
});
