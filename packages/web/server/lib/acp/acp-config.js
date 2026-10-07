// Persisted ACP agent configuration.
//
// The agent config (command, args, name) comes from the UI settings (Agent
// Backend section). The server persists it to disk on /initialize so it can
// re-initialize the agent on restart without env vars or waiting for the UI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Same data-dir resolution as the rest of the server: OPENCHAMBER_DATA_DIR when
// set, otherwise ~/.config/openchamber. Resolved per call so the environment is
// read when the config is used, not when this module loads.
const resolveConfigDir = () => (process.env.OPENCHAMBER_DATA_DIR
  ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
  : path.join(os.homedir(), '.config', 'openchamber'));
const resolveConfigFile = () => path.join(resolveConfigDir(), 'acp-agent-config.json');

/**
 * Read the persisted ACP agent config. Returns null if not configured yet.
 */
export const readAcpAgentConfig = () => {
  try {
    const raw = fs.readFileSync(resolveConfigFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.command === 'string' && parsed.command.trim().length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Persist the ACP agent config so the server can re-initialize on restart.
 */
export const writeAcpAgentConfig = (config) => {
  if (!config || typeof config.command !== 'string') return;
  try {
    const file = resolveConfigFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort — a failed write must never break the session flow.
  }
};

/**
 * Clear the persisted config (e.g. when ACP is disabled or the agent removed).
 */
export const clearAcpAgentConfig = () => {
  try {
    fs.rmSync(resolveConfigFile(), { force: true });
  } catch {
    // ignore
  }
};
