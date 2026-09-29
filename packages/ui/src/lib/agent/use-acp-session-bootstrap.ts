import { useEffect } from 'react';
import type { Session } from '../opencode/model';
import { ACP_SESSION_METADATA, ZERO_TOKEN_USAGE } from './types';
import { useAgentBackendStore } from '@/stores/useAgentBackendStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { mirrorSessionIntoLiveStores } from '@/sync/session-actions';
import { getActiveAgentClient } from './active-client';

// On mount (and when the backend switches to ACP), fetch the agent's existing
// sessions so the sidebar populates. The server's activeSource persists across
// page refreshes (the agent process keeps running), so this works even after a
// reload — as long as /initialize was called at least once in the server's
// lifetime. Sessions that don't exist yet (first load, no connection) return
// an empty list (harmless).
export function useAcpSessionBootstrap() {
  const activeBackend = useAgentBackendStore((s) => s.activeBackend);

  useEffect(() => {
    if (activeBackend !== 'acp') return;
    const client = getActiveAgentClient();
    if (!client.listSessions) return;

    let cancelled = false;
    const run = async () => {
      try {
        const sessions = await client.listSessions!();
        if (cancelled) return;
        const now = Date.now();
        for (const s of sessions) {
          const acpSession: Session = {
            id: s.id,
            projectID: '',
            directory: '',
            title: s.title ?? 'ACP session',
            cost: 0,
            tokens: ZERO_TOKEN_USAGE,
            time: { created: now, updated: now },
            metadata: ACP_SESSION_METADATA,
          };
          useGlobalSessionsStore.getState().upsertSession(acpSession);
          mirrorSessionIntoLiveStores(acpSession);
        }
      } catch {
        // No active connection yet — harmless (empty sidebar until first session).
      }
    };
    void run();

    return () => { cancelled = true; };
  }, [activeBackend]);
}
