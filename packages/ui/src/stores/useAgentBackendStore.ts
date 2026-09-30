// Agent backend selection store. Per decision FEAT-2010-DEC-1, one backend is
// active at a time (OpenCode default). Selecting ACP constructs an AcpClient
// from the configured agent and installs it as the active agent client; the
// create/prompt seams (session-actions, session-ui-store) then route to it.

import { create } from 'zustand';
import { z } from 'zod';
import { toast } from '@/components/ui';
import { formatMessage, useI18nStore } from '@/lib/i18n';
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

// Whether the server reported ACP as disabled. While it is, the stored ACP
// choice stays in storage but is not used: the effective backend is OpenCode.
let acpDisabledByServer = false;

// Resolve the active ACP agent config, if any.
const resolveActiveAcpAgent = (state: PersistedState): AcpAgentConfig | null => {
  if (acpDisabledByServer) return null;
  if (state.activeBackend !== 'acp' || !state.activeAcpAgentId) return null;
  return state.agents.find((a) => a.id === state.activeAcpAgentId && a.enabled) ?? null;
};

// Persist to the server so the server can initialize the agent at startup.
// Called alongside localStorage on every settings change.
const persistToServer = (state: PersistedState) => {
  const agent = resolveActiveAcpAgent(state);
  const body = agent
    ? { command: agent.command, args: agent.args, env: agent.env, agentName: agent.name, agentId: agent.id }
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
  /** The user's stored backend choice while the server has ACP disabled (`activeBackend` is then OpenCode). */
  storedBackend: AgentBackendType | null;
  setBackend: (backend: AgentBackendType) => void;
  selectAcpAgent: (agentId: string | null) => void;
  addAgent: (agent: Omit<AcpAgentConfig, 'id'>) => string;
  updateAgent: (id: string, patch: Partial<AcpAgentConfig>) => void;
  removeAgent: (id: string) => void;
};

const initialState = loadPersisted();
// Apply the persisted selection on module load so a reload keeps the backend.
applySelection(initialState);

// The user's own selection: what is stored, which differs from the visible
// `activeBackend` while the server has ACP disabled.
const selectionOf = (state: AgentBackendStore): PersistedState => ({
  activeBackend: state.storedBackend ?? state.activeBackend,
  activeAcpAgentId: state.activeAcpAgentId,
  agents: state.agents,
});

// The visible backend for a user selection.
const visibleBackend = (selection: PersistedState): AgentBackendType =>
  acpDisabledByServer ? 'opencode' : selection.activeBackend;

const commit = (next: PersistedState): Partial<AgentBackendStore> => {
  persist(next);
  persistToServer(next);
  applySelection(next);
  return {
    ...next,
    activeBackend: visibleBackend(next),
    storedBackend: acpDisabledByServer ? next.activeBackend : null,
  };
};

const acpStatusSchema = z.object({ enabled: z.boolean() });

// Ask the server whether ACP is enabled. A stored ACP selection is not used
// when it is not: fall back to OpenCode, say so, and keep the stored choice.
// Anything other than a clear answer (network error, 5xx) changes nothing.
export const refreshAcpAvailability = async (): Promise<void> => {
  let disabled: boolean;
  try {
    const response = await runtimeFetch('/api/agent/acp/status', { headers: { Accept: 'application/json' } });
    if (response.status === 404) {
      disabled = true; // a server without ACP support at all
    } else if (response.ok) {
      const parsed = acpStatusSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return;
      disabled = !parsed.data.enabled;
    } else {
      return;
    }
  } catch {
    return;
  }
  if (disabled === acpDisabledByServer) return;
  acpDisabledByServer = disabled;
  const selection = selectionOf(useAgentBackendStore.getState());
  applySelection(selection);
  useAgentBackendStore.setState({
    activeBackend: visibleBackend(selection),
    storedBackend: disabled ? selection.activeBackend : null,
  });
  if (disabled && selection.activeBackend === 'acp') {
    toast.info(formatMessage(useI18nStore.getState().dictionary, 'settings.agentBackend.unavailable'));
  }
};

export const useAgentBackendStore = create<AgentBackendStore>((set, get) => ({
  ...initialState,

  storedBackend: null,

  setBackend: (backend) => {
    set(commit({ ...selectionOf(get()), activeBackend: backend }));
  },

  selectAcpAgent: (agentId) => {
    set(commit({ ...selectionOf(get()), activeAcpAgentId: agentId }));
  },

  addAgent: (agent) => {
    const current = selectionOf(get());
    const id = `acp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const newAgent: AcpAgentConfig = { ...agent, id };
    set(commit({ ...current, agents: [...current.agents, newAgent] }));
    return id;
  },

  updateAgent: (id, patch) => {
    const current = selectionOf(get());
    set(commit({
      ...current,
      agents: current.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  },

  removeAgent: (id) => {
    const current = selectionOf(get());
    set(commit({
      ...current,
      agents: current.agents.filter((a) => a.id !== id),
      activeAcpAgentId: current.activeAcpAgentId === id ? null : current.activeAcpAgentId,
    }));
  },
}));

