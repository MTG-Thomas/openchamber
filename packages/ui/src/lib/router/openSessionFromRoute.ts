import { acpSessionOwnerSchema } from '@/lib/agent/types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { SessionRef } from '@/lib/runtime-identity';
import { requestMessageFocus } from './messageFocus';

/**
 * Opens a session link and, for a message link, asks the session's timeline
 * to show that message: on entry, or right away if the session is open.
 */
export async function openSessionLink(sessionId: string, messageId: string | null, owner?: SessionRef): Promise<void> {
  if (owner && owner.sessionId !== sessionId) return;
  if (owner && owner.runtimeId !== getRuntimeKey()) {
    const { loadConfiguredRuntimes, unifiedRuntimesEnabled } = await import('../runtimes/configured');
    if (!unifiedRuntimesEnabled) return;
    const { runtimeRegistry } = await import('../runtimes/registry');
    await loadConfiguredRuntimes();
    await runtimeRegistry.refresh(owner.runtimeId);
    await runtimeRegistry.activate(owner);
  }
  if (owner) {
    await ensureGlobalSessionsLoaded();
    if (owner.runtimeId !== getRuntimeKey()) return;
    const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
    if (!session) return;
    const acp = acpSessionOwnerSchema.safeParse(session.metadata?.openchamber);
    const backendId = acp.success ? `acp:${acp.data.agentId}` : 'opencode';
    if (backendId !== owner.backendId) return;
  }
  if (messageId) requestMessageFocus(sessionId, messageId);
  return openSessionFromRoute(sessionId);
}

/**
 * Select a session named by `/?session=`. Cold loads often do not know the
 * owning directory yet, so a first selection may guess the active project.
 * After the global session list is available, re-select with that directory
 * unless the user already moved to a different session.
 */
export async function openSessionFromRoute(sessionId: string): Promise<void> {
  const id = sessionId.trim();
  if (!id) return;

  const initial = useSessionUIStore.getState();
  if (initial.currentSessionId !== id) {
    initial.setCurrentSession(id, initial.getDirectoryForSession(id));
  }

  const snapshot = await ensureGlobalSessionsLoaded().catch(() => null);
  if (!snapshot) return;

  const latest = useSessionUIStore.getState();
  if (latest.currentSessionId !== id) return;

  const session = [...snapshot.activeSessions, ...snapshot.archivedSessions]
    .find((entry) => entry.id === id);
  if (!session) return;

  const directory = resolveGlobalSessionDirectory(session);
  if (!directory || directory === latest.currentSessionDirectory) return;

  latest.setCurrentSession(id, directory);
}
