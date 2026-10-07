import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { runtimeRegistry } from '@/lib/runtimes/registry';
import { loadConfiguredRuntimes, unifiedRuntimesEnabled } from '@/lib/runtimes/configured';
import { sessionRefKey, projectRefKey, type SessionRef } from '@/lib/runtime-identity';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';

// Shared tree for the desktop sidebar and iOS sessions drawer. The foreground
// store remains unchanged; background rows belong only to the runtime index.
export function UnifiedRuntimeSidebar({ onSelected }: { onSelected?: (id: string) => void }) {
  const { t } = useI18n();
  const runtimes = React.useSyncExternalStore(runtimeRegistry.subscribe, runtimeRegistry.getSnapshot, runtimeRegistry.getSnapshot);
  React.useEffect(() => {
    if (!unifiedRuntimesEnabled) return;
    void loadConfiguredRuntimes().catch((error) => toast.error(error instanceof Error ? error.message : t('mobile.sessions.empty')));
    const visibilityChanged = () => {
      runtimeRegistry.setSuspended(document.hidden);
      if (!document.hidden) void loadConfiguredRuntimes().catch(() => {});
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => document.removeEventListener('visibilitychange', visibilityChanged);
  }, [t]);
  const activate = async (ref: SessionRef) => {
    try {
      await runtimeRegistry.activate(ref);
      await openSessionLink(ref.sessionId, null, ref);
      onSelected?.(ref.sessionId);
    } catch (error) { toast.error(error instanceof Error ? error.message : t('mobile.sessions.empty')); }
  };
  if (!unifiedRuntimesEnabled) return null;
  return <div className="shrink-0 max-h-[40vh] overflow-y-auto space-y-1 px-3 py-2">
    {runtimes.map((runtime) => {
      const projects = new Map<string, typeof runtime.sessions[number][]>();
      for (const session of runtime.sessions) {
        const key = session.ref.projectId ?? session.directory;
        const group = projects.get(key) ?? [];
        group.push(session); projects.set(key, group);
      }
      return <details key={runtime.id} open>
        <summary className="cursor-pointer py-2 typography-ui-label">{runtime.label}</summary>
        {runtime.status === 'connecting' && <p className="typography-meta text-muted-foreground">{t('mobile.connect.connecting')}</p>}
        {runtime.error && <div className="typography-meta text-[var(--status-error-text)]" role="status">
          <p>{runtime.error}</p>
          <Button variant="ghost" size="sm" onClick={() => runtimeRegistry.reconnect(runtime.id)}>{t('sessions.sidebar.group.empty.retry')}</Button>
        </div>}
        {Array.from(projects, ([projectId, sessions]) => <details key={projectRefKey({ runtimeId: runtime.id, projectId })} open className="pl-3">
          <summary className="cursor-pointer truncate py-1 typography-meta" title={sessions[0].directory}>{sessions[0].directory || projectId}</summary>
          {sessions.map((session) => <Button key={sessionRefKey(session.ref)} variant="ghost" size="sm"
            className="w-full justify-start gap-2" onClick={() => void activate(session.ref)}>
            <span className="truncate">{session.title}</span>
            <span className="ml-auto typography-meta text-muted-foreground">{session.ref.backendId === 'opencode' ? 'OpenCode' : 'ACP'}</span>
          </Button>)}
        </details>)}
        {runtime.status === 'ready' && runtime.sessions.length === 0 && <p className="typography-meta text-muted-foreground">{t('mobile.sessions.empty.noSessionsTitle')}</p>}
      </details>;
    })}
  </div>;
}
