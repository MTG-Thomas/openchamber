// Agent backend selection store. Per decision FEAT-2010-DEC-1, one backend is
// active at a time (OpenCode default). Selecting ACP constructs an AcpClient
// from the configured agent and installs it as the active agent client; the
// create/prompt seams (session-actions, session-ui-store) then route to it.

import { create } from 'zustand';
import { AcpClient } from '@/lib/agent/acp-client';
import { setActiveAgentClient } from '@/lib/agent/active-client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import type { AgentSelectionState } from '@/lib/agent/config';
import type { AgentBackendType, AcpAgentConfig } from '@/lib/agent/config';

const STORAGE_KEY = 'openchamber.agent-backend.v1';

type PersistedState = AgentSelectionState;

const DEFAULT_STATE: PersistedState = { activeBackend: 'opencode', activeAcpAgentId: null, agents: [] };

const isValidAgentConfig = (value: unknown): value is AcpAgentConfig => {
  if (!value || typeof value !== 'object') return false;
  // SAFETY: value passed the object check above; command presence is the config contract.
  return typeof (value as AcpAgentConfig).command === 'string';
};

// Parse a persisted payload; malformed data falls back to defaults (never
// partial state). Every field is validated before use.
const parsePersisted = (raw: unknown): PersistedState => {
  if (!raw || typeof raw !== 'object') return DEFAULT_STATE;
  // SAFETY: raw passed the object check above; fields are validated below.
  const record = raw as Record<string, unknown>;
  return {
    activeBackend: record.activeBackend === 'acp' ? 'acp' : 'opencode',
    activeAcpAgentId: typeof record.activeAcpAgentId === 'string' ? record.activeAcpAgentId : null,
    agents: Array.isArray(record.agents) ? record.agents.filter(isValidAgentConfig) : [],
  };
};

const loadPersisted = (): PersistedState => {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_STATE;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    return parsePersisted(JSON.parse(raw));
  } catch {
    return DEFAULT_STATE;
  }
};

const persist = (state: PersistedState) => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Best-effort persistence.
  }
};

// Resolve the active ACP agent config, if any.
const resolveActiveAcpAgent = (state: PersistedState): AcpAgentConfig | null => {
  if (state.activeBackend !== 'acp' || !state.activeAcpAgentId) return null;
  return state.agents.find((a) => a.id === state.activeAcpAgentId && a.enabled) ?? null;
};

// Persist to the server so the server can initialize the agent at startup.
// Called alongside localStorage on every settings change.
const persistToServer = (state: PersistedState) => {
  const agent = resolveActiveAcpAgent(state);
  const body = agent
    ? { command: agent.command, args: agent.args, agentName: agent.name, agentId: agent.id }
    : { command: '' }; // empty = clear
  void runtimeFetch('/api/agent/acp/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    // Best-effort — settings still work locally via localStorage.
  });
};

// Apply the selection to the active-client selector. Called on every change.
const applySelection = (state: PersistedState) => {
  const acpAgent = resolveActiveAcpAgent(state);
  if (acpAgent) {
    setActiveAgentClient(
      new AcpClient({
        command: acpAgent.command,
        args: acpAgent.args,
        env: acpAgent.env,
        agentId: acpAgent.id,
        name: acpAgent.name,
      }),
    );
  } else {
    // OpenCode default (or ACP selected but no valid agent configured).
    setActiveAgentClient(null);
  }
};

type AgentBackendStore = PersistedState & {
  setBackend: (backend: AgentBackendType) => void;
  selectAcpAgent: (agentId: string | null) => void;
  addAgent: (agent: Omit<AcpAgentConfig, 'id'>) => string;
  updateAgent: (id: string, patch: Partial<AcpAgentConfig>) => void;
  removeAgent: (id: string) => void;
};

const initialState = loadPersisted();
// Apply the persisted selection on module load so a reload keeps the backend.
applySelection(initialState);

const commit = (next: PersistedState): Partial<AgentBackendStore> => {
  persist(next);
  persistToServer(next);
  applySelection(next);
  return next;
};

export const useAgentBackendStore = create<AgentBackendStore>((set, get) => ({
  ...initialState,

  setBackend: (backend) => {
    const current = get();
    commit({ ...current, activeBackend: backend });
    set({ activeBackend: backend });
  },

  selectAcpAgent: (agentId) => {
    const current = get();
    commit({ ...current, activeAcpAgentId: agentId });
    set({ activeAcpAgentId: agentId });
  },

  addAgent: (agent) => {
    const current = get();
    const id = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const newAgent: AcpAgentConfig = { ...agent, id };
    const next = { ...current, agents: [...current.agents, newAgent] };
    commit(next);
    set({ agents: next.agents });
    return id;
  },

  updateAgent: (id, patch) => {
    const current = get();
    const next = {
      ...current,
      agents: current.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    };
    commit(next);
    set({ agents: next.agents });
  },

  removeAgent: (id) => {
    const current = get();
    const next = {
      ...current,
      agents: current.agents.filter((a) => a.id !== id),
      activeAcpAgentId: current.activeAcpAgentId === id ? null : current.activeAcpAgentId,
    };
    commit(next);
    set({ agents: next.agents, activeAcpAgentId: next.activeAcpAgentId });
  },
}));
