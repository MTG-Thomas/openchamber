// Agent backend configuration types (specification data model 4.2).
// Persisted by useAgentBackendStore; OpenCode is the default backend.

import type { AgentBackendType } from './types';

export type { AgentBackendType };

/** A configured ACP stdio agent. */
export type AcpAgentConfig = {
  /** Stable id (used as the server-side process-registry agentId). */
  id: string;
  /** Display name. */
  name: string;
  /** Stdio agent command (executable). */
  command: string;
  /** Args for the executable. */
  args?: string[];
  /** Extra env for the agent subprocess. */
  env?: Record<string, string>;
  /** Whether this agent is selectable. */
  enabled: boolean;
};

/** Persisted agent-selection state. */
export type AgentSelectionState = {
  activeBackend: AgentBackendType;
  activeAcpAgentId: string | null;
  agents: AcpAgentConfig[];
};
