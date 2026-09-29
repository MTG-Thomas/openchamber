import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useAgentBackendStore } from '@/stores/useAgentBackendStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsCheckboxRow,
  SETTINGS_FIELDS_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Agent Backend settings page (FR-5). Lets the user choose the active backend
// (OpenCode default, or a configured ACP stdio agent) and manage ACP agent
// configs. Selecting ACP installs an AcpClient as the active agent client.

const BACKEND_OPTIONS = [
  { value: 'opencode', labelKey: 'settings.agentBackend.backend.opencode' },
  { value: 'acp', labelKey: 'settings.agentBackend.backend.acp' },
] as const;

export function AgentBackendPage() {
  const { t } = useI18n();
  const activeBackend = useAgentBackendStore((s) => s.activeBackend);
  const activeAcpAgentId = useAgentBackendStore((s) => s.activeAcpAgentId);
  const agents = useAgentBackendStore((s) => s.agents);
  const setBackend = useAgentBackendStore((s) => s.setBackend);
  const selectAcpAgent = useAgentBackendStore((s) => s.selectAcpAgent);
  const addAgent = useAgentBackendStore((s) => s.addAgent);
  const updateAgent = useAgentBackendStore((s) => s.updateAgent);
  const removeAgent = useAgentBackendStore((s) => s.removeAgent);

  return (
    <SettingsPageLayout title={t('settings.page.agentBackend.title')} showSaveStatus={false}>
      <SettingsSection
        title={t('settings.agentBackend.section.backend')}
        info={t('settings.agentBackend.section.backend.description')}
        divider={false}
        settingsItem="agent-backend"
      >
        <SettingsRadioGroup aria-label={t('settings.agentBackend.section.backend')}>
          {BACKEND_OPTIONS.map((option) => (
            <SettingsRadioOption
              key={option.value}
              selected={activeBackend === option.value}
              onSelect={() => setBackend(option.value)}
              label={t(option.labelKey)}
              ariaLabel={t(option.labelKey)}
            />
          ))}
        </SettingsRadioGroup>
      </SettingsSection>

      <SettingsSection
        title={t('settings.agentBackend.section.agents')}
        info={t('settings.agentBackend.section.agents.description')}
        headerAction={(
          <Button size="sm" variant="outline" onClick={() => addAgent({ name: 'ACP agent', command: '', enabled: true })}>
            {t('settings.agentBackend.action.add')}
          </Button>
        )}
        settingsItem="agent-backend.agents"
      >
        {agents.length === 0 ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.agentBackend.empty')}
          </p>
        ) : (
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {agents.map((agent) => {
              const isActive = activeBackend === 'acp' && activeAcpAgentId === agent.id;
              return (
                <div key={agent.id} className="space-y-3" data-settings-item={`agent-backend.agent.${agent.id}`}>
                  <div className="flex items-center justify-between gap-2">
                    <SettingsRadioOption
                      selected={isActive}
                      onSelect={() => {
                        selectAcpAgent(agent.id);
                        if (activeBackend !== 'acp') setBackend('acp');
                      }}
                      label={agent.name.trim().length > 0 ? agent.name : t('settings.agentBackend.backend.acp')}
                      ariaLabel={agent.name}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => removeAgent(agent.id)}
                      aria-label={t('settings.agentBackend.action.remove')}
                    >
                      ×
                    </Button>
                  </div>
                  <div className="space-y-3 pl-6">
                    <label className="sr-only" htmlFor={`agent-name-${agent.id}`}>
                      {t('settings.agentBackend.field.name')}
                    </label>
                    <Input
                      id={`agent-name-${agent.id}`}
                      value={agent.name}
                      onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                      placeholder={t('settings.agentBackend.field.name')}
                      aria-label={t('settings.agentBackend.field.name')}
                    />
                    <label className="sr-only" htmlFor={`agent-command-${agent.id}`}>
                      {t('settings.agentBackend.field.command')}
                    </label>
                    <Input
                      id={`agent-command-${agent.id}`}
                      value={agent.command}
                      onChange={(e) => updateAgent(agent.id, { command: e.target.value })}
                      placeholder={t('settings.agentBackend.field.command.placeholder')}
                      aria-label={t('settings.agentBackend.field.command')}
                    />
                    <SettingsCheckboxRow
                      checked={agent.enabled}
                      onChange={(checked) => updateAgent(agent.id, { enabled: checked })}
                      label={t('settings.agentBackend.field.enabled')}
                      ariaLabel={t('settings.agentBackend.field.enabled')}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
}
