import React from 'react';
import { useAgentBackendStore } from '@/stores/useAgentBackendStore';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

/**
 * Composer indicator for the ACP backend.
 *
 * The composer's model/agent pickers are OpenCode concepts: an ACP turn runs on
 * the agent's own model (reported per session and shown in each reply's
 * footer), so showing an OpenCode model there would claim a model that is not
 * in use. This badge names the selected agent instead.
 */
export const AcpBackendBadge: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useI18n();
  const agentName = useAgentBackendStore((s) => {
    const agent = s.agents.find((candidate) => candidate.id === s.activeAcpAgentId);
    return agent?.name?.trim() || null;
  });

  return (
    <div
      className={cn('flex min-w-0 items-center gap-1.5 typography-meta text-muted-foreground', className)}
      title={t('settings.agentBackend.backend.acp')}
    >
      <Icon name="terminal-box" className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{agentName ?? t('settings.agentBackend.backend.acp')}</span>
      <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase tracking-wide">
        {t('settings.agentBackend.backend.acp')}
      </span>
    </div>
  );
};
