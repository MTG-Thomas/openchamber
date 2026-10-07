import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
// ACP session model selection for the composer picker.
//
// The active ACP agent reports its selectable models per session; this store
// caches them by session id and applies a selection through the agent client.
// Runtime-only (never persisted): the agent-reported catalog is refetched on
// demand and must not outlive the process that owns the ACP connection.
//
// The picker is an enhancement, not authoritative state: when the catalog is
// unavailable (no ACP session yet, transport failure) the composer falls back
// to the agent badge and the per-reply footer still names the model in use.

import { create } from 'zustand';
import { getActiveAgentClient, getSessionAgentClient } from '@/lib/agent/active-client';
import type { AgentModelConfig } from '@/lib/agent/types';

// Matches AcpModelSelector's draft cache key; it is never an agent session ID.
const NEW_SESSION_KEY = 'acp-new-session';

type AcpModelStore = {
  /** Agent-reported model select per session id. */
  bySession: Record<string, AgentModelConfig>;
  loading: Record<string, boolean>;
  /** Fetch the session's model options; a no-op for non-ACP backends. */
  load: (sessionId: string) => Promise<void>;
  /** Switch the session's model to `value` (an option value id). */
  select: (sessionId: string, value: string) => Promise<void>;
};

export const useAcpModelStore = create<AcpModelStore>((set, get) => ({
  bySession: {},
  loading: {},

  load: async (sessionId) => {
    const runtimeId = getRuntimeKey();
    if (!sessionId) return;
    set((state) => ({ loading: { ...state.loading, [sessionId]: true } }));
    try {
      const draft = sessionId === NEW_SESSION_KEY;
      const client = draft ? getActiveAgentClient()
        : getSessionAgentClient(useGlobalSessionsStore.getState().entityById.get(sessionId));
      if (client.backend !== 'acp' || !client.listModels) {
        set((state) => ({ loading: { ...state.loading, [sessionId]: false } }));
        return;
      }
      const config = await client.listModels(draft ? '' : sessionId);
      if (runtimeId !== getRuntimeKey()) return;
      set((state) => ({
        // `null` is a valid "this agent reports no model select", not a failure:
        // keep any existing entry out and let the badge render.
        bySession: config ? { ...state.bySession, [sessionId]: config } : state.bySession,
        loading: { ...state.loading, [sessionId]: false },
      }));
    } catch (error) {
      if (runtimeId !== getRuntimeKey()) return;
      console.warn('[acp] failed to load session models', error);
      set((state) => ({ loading: { ...state.loading, [sessionId]: false } }));
    }
  },

  select: async (sessionId, value) => {
    const current = get().bySession[sessionId];
    const runtimeId = getRuntimeKey();
    if (!sessionId || !current) return;
    // Optimistic: the picker reflects the choice immediately; the agent's
    // response reconciles it, and a failure rolls back to the prior value.
    set((state) => ({
      bySession: { ...state.bySession, [sessionId]: { ...current, currentValue: value } },
    }));
    try {
      const draft = sessionId === NEW_SESSION_KEY;
      const client = draft ? getActiveAgentClient()
        : getSessionAgentClient(useGlobalSessionsStore.getState().entityById.get(sessionId));
      if (client.backend !== 'acp' || !client.setModel) throw new Error('ACP model owner is unavailable');
      const updated = await client.setModel(draft ? '' : sessionId, current.configId, value);
      if (runtimeId !== getRuntimeKey()) return;
      if (updated) {
        set((state) => ({ bySession: { ...state.bySession, [sessionId]: updated } }));
      }
    } catch (error) {
      if (runtimeId !== getRuntimeKey()) return;
      console.warn('[acp] failed to switch session model', error);
      set((state) => ({ bySession: { ...state.bySession, [sessionId]: current } }));
    }
  },
}));

subscribeRuntimeEndpointChanged((detail) => {
  if (detail.runtimeKey !== detail.previousRuntimeKey) useAcpModelStore.setState({ bySession: {}, loading: {} });
});
