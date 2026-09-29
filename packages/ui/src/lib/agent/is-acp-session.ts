// Shared helper: check whether a session is ACP-backed (marked via the
// `openchamber.acp` metadata key the ACP adapters write on session records).
// Used to gate OpenCode API calls that foreign session ids would break.
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAgentBackendStore } from '@/stores/useAgentBackendStore';
import { isAcpSessionRecord } from './types';

/**
 * Returns true if the session is an ACP session (marked via the
 * `openchamber.acp` metadata key the ACP adapters write).
 * Checks the global sessions store. When ACP is the active backend and the
 * session isn't found (not yet mirrored), assumes ACP to be safe.
 */
export const isAcpSession = (sessionId: string): boolean => {
  const state = useGlobalSessionsStore.getState();
  // Search all directory buckets for the session. Partial store mocks (tests,
  // early bootstrap) may not have the directory index yet; absence is not ACP.
  const buckets = state.sessionsByDirectory?.values() ?? [];
  for (const sessions of buckets) {
    const found = sessions.find((s) => s.id === sessionId);
    if (found) {
      return isAcpSessionRecord(found);
    }
  }
  // Not found in global store + ACP active → treat as ACP (safe default).
  return useAgentBackendStore.getState().activeBackend === 'acp';
};
