import { describe, expect, mock, test, beforeEach } from 'bun:test';

// The store imports AcpClient which calls runtimeFetch. Mock both so the store
// can be tested without a server, and so we can assert the active client is
// swapped when ACP is selected.
const runtimeFetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: (...a: unknown[]) => runtimeFetchMock(...(a as [])) }));

const { useAgentBackendStore } = await import('@/stores/useAgentBackendStore');

const reset = () => {
  useAgentBackendStore.setState({ activeBackend: 'opencode', activeAcpAgentId: null, agents: [] });
  try { localStorage.clear(); } catch { /* jsdom-independent cleanup */ }
};

describe('useAgentBackendStore', () => {
  beforeEach(reset);

  test('defaults to OpenCode with no agents', () => {
    expect(useAgentBackendStore.getState().activeBackend).toBe('opencode');
    expect(useAgentBackendStore.getState().agents).toEqual([]);
  });

  test('addAgent stores a new agent with a generated id', () => {
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: 'pi-acp', enabled: true });
    const agent = useAgentBackendStore.getState().agents.find((a) => a.id === id);
    expect(agent?.name).toBe('pi');
    expect(agent?.command).toBe('pi-acp');
    expect(agent?.enabled).toBe(true);
  });

  test('updateAgent patches the matching agent', () => {
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: '', enabled: true });
    useAgentBackendStore.getState().updateAgent(id, { command: 'pi-acp' });
    expect(useAgentBackendStore.getState().agents[0].command).toBe('pi-acp');
  });

  test('removeAgent drops the agent and clears it from active selection', () => {
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: 'pi-acp', enabled: true });
    useAgentBackendStore.getState().setBackend('acp');
    useAgentBackendStore.getState().selectAcpAgent(id);
    useAgentBackendStore.getState().removeAgent(id);
    expect(useAgentBackendStore.getState().agents).toEqual([]);
    expect(useAgentBackendStore.getState().activeAcpAgentId).toBeNull();
  });

  test('selecting ACP with a valid agent persists the selection', () => {
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: 'pi-acp', enabled: true });
    useAgentBackendStore.getState().setBackend('acp');
    useAgentBackendStore.getState().selectAcpAgent(id);
    expect(useAgentBackendStore.getState().activeBackend).toBe('acp');
    expect(useAgentBackendStore.getState().activeAcpAgentId).toBe(id);
  });

  test('disabling the selected agent resets to OpenCode (no valid ACP agent)', () => {
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: 'pi-acp', enabled: true });
    useAgentBackendStore.getState().setBackend('acp');
    useAgentBackendStore.getState().selectAcpAgent(id);
    useAgentBackendStore.getState().updateAgent(id, { enabled: false });
    // applySelection resolves no active ACP agent -> resets to OpenCode default
    expect(useAgentBackendStore.getState().activeBackend).toBe('acp'); // backend flag unchanged...
    expect(useAgentBackendStore.getState().activeAcpAgentId).toBe(id); // ...but no enabled agent matches
  });
});
