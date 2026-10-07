import { getRuntimeKey } from '@/lib/runtime-switch';
import { describe, expect, mock, test, beforeEach } from 'bun:test';

// The store imports AcpClient which calls runtimeFetch. Mock both so the store
// can be tested without a server, and so we can assert the active client is
// swapped when ACP is selected.
const runtimeFetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: (...a: unknown[]) => runtimeFetchMock(...(a as [])) }));

const { useAgentBackendStore, refreshAcpAvailability } = await import('@/stores/useAgentBackendStore');
const { getActiveAgentClient } = await import('@/lib/agent/active-client');

const answerStatus = (body: unknown, status = 200) => {
  runtimeFetchMock.mockImplementation(() => Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  ));
};

const reset = () => {
  useAgentBackendStore.setState({ activeBackend: 'opencode', activeAcpAgentId: null, agents: [], storedBackend: null });
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

  test('an incomplete selected ACP agent cannot silently create an OpenCode session', () => {
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: 'pi-acp', enabled: true });
    useAgentBackendStore.getState().setBackend('acp');
    useAgentBackendStore.getState().selectAcpAgent(id);
    useAgentBackendStore.getState().updateAgent(id, { enabled: false });
    // applySelection resolves no active ACP agent -> resets to OpenCode default
    expect(useAgentBackendStore.getState().activeBackend).toBe('acp'); // backend flag unchanged...
    expect(useAgentBackendStore.getState().activeAcpAgentId).toBe(id); // ...but no enabled agent matches
    expect(getActiveAgentClient().backend).toBe('acp'); // fails visibly, cannot create an OpenCode session
  });

  test('a stored ACP choice is not used while the server reports ACP disabled, and is kept', async () => {
    // bun has no localStorage: a minimal stand-in so the stored choice is observable.
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => { entries.set(key, value); },
        removeItem: (key: string) => { entries.delete(key); },
        clear: () => entries.clear(),
      },
    });
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: 'pi-acp', enabled: true });
    useAgentBackendStore.getState().setBackend('acp');
    useAgentBackendStore.getState().selectAcpAgent(id);
    expect(getActiveAgentClient().backend).toBe('acp');

    answerStatus({ enabled: false });
    await refreshAcpAvailability();
    expect(useAgentBackendStore.getState().activeBackend).toBe('opencode');
    expect(getActiveAgentClient().backend).toBe('opencode');

    // Editing settings meanwhile must not overwrite the stored choice.
    useAgentBackendStore.getState().updateAgent(id, { name: 'pi 2' });
    const stored = JSON.parse(localStorage.getItem(`openchamber.agent-backend.v2:${getRuntimeKey()}`) ?? '{}');
    expect(stored.activeBackend).toBe('acp');
    expect(stored.activeAcpAgentId).toBe(id);

    // ACP enabled again: the stored choice is back in use.
    answerStatus({ enabled: true });
    await refreshAcpAvailability();
    expect(useAgentBackendStore.getState().activeBackend).toBe('acp');
    expect(getActiveAgentClient().backend).toBe('acp');
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('an unclear status answer changes nothing', async () => {
    const id = useAgentBackendStore.getState().addAgent({ name: 'pi', command: 'pi-acp', enabled: true });
    useAgentBackendStore.getState().setBackend('acp');
    useAgentBackendStore.getState().selectAcpAgent(id);
    answerStatus({ error: 'unavailable' }, 503);
    await refreshAcpAvailability();
    expect(useAgentBackendStore.getState().activeBackend).toBe('acp');
  });
});
