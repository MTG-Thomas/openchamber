// ACP (Agent Client Protocol) server-side environment configuration.
//
// Centralizes the ACP feature flag and any ACP env knobs so later modules
// (agent-process-manager, acp-event-source, routes) have a single import
// point. OpenCode remains the default backend; ACP is opt-in.

import { isEnterpriseMode } from '../enterprise-mode.js';
import { readAcpAgentConfig } from './acp-config.js';

const isEnvFlagEnabled = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
};

/**
 * Whether ACP backend support is enabled. Defaults to off so the OpenCode
 * backend remains the default and fully functional (FR-2, NFR-1).
 */
export const isAcpEnabled = () =>
  !isEnterpriseMode() && isEnvFlagEnabled(process.env.OPENCHAMBER_ACP_ENABLED);

/**
 * Whether verbose ACP logging is enabled (raw notifications, full responses).
 * Set OPENCHAMBER_ACP_DEBUG=1 to enable. Off by default to avoid log noise.
 */
export const isAcpDebug = () =>
  isEnvFlagEnabled(process.env.OPENCHAMBER_ACP_DEBUG);

/**
 * Directory holding per-pid JSON records for spawned ACP agent subprocesses.
 * Mirrors the OpenCode managed-process registry layout (one file per pid to
 * avoid cross-runtime write contention).
 */
export const resolveAcpRegistryDir = () => {
  const override = process.env.OPENCHAMBER_ACP_AGENT_REGISTRY;
  if (override && override.trim()) return override.trim();
  return null;
};

/**
 * Startup ACP agent configuration. Reads from the persisted config file
 * (~/.config/openchamber/acp-agent-config.json, written on /initialize) so the
 * server can re-initialize the agent on restart without env vars. Env vars
 * (OPENCHAMBER_ACP_COMMAND etc.) act as an explicit override if set.
 * Returns null if no command is configured.
 */
export const getStartupAcpConfig = () => {
  // Env var override (power users).
  const envCommand = process.env.OPENCHAMBER_ACP_COMMAND;
  if (typeof envCommand === 'string' && envCommand.trim().length > 0) {
    const argsRaw = process.env.OPENCHAMBER_ACP_ARGS;
    return {
      command: envCommand.trim(),
      args: typeof argsRaw === 'string' && argsRaw.trim().length > 0
        ? argsRaw.split(',').map((a) => a.trim()).filter(Boolean)
        : undefined,
      agentName: (typeof process.env.OPENCHAMBER_ACP_AGENT_NAME === 'string' && process.env.OPENCHAMBER_ACP_AGENT_NAME.trim()) || undefined,
      agentId: 'acp-env',
      cwd: (typeof process.env.OPENCHAMBER_ACP_CWD === 'string' && process.env.OPENCHAMBER_ACP_CWD.trim()) || undefined,
    };
  }

  // Persisted config from the last /initialize (the normal path).
  const persisted = readAcpAgentConfig();
  if (persisted) {
    return {
      command: persisted.command,
      args: persisted.args,
      agentName: persisted.agentName,
      agentId: persisted.agentId || 'acp-startup',
      cwd: persisted.cwd,
    };
  }

  return null;
};
