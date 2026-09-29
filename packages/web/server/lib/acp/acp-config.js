// Persisted ACP agent configuration.
//
// The agent config (command, args, name) comes from the UI settings (Agent
// Backend section). The server persists it to disk on /initialize so it can
// re-initialize the agent on restart without env vars or waiting for the UI.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'openchamber');
const CONFIG_FILE = path.join(CONFIG_DIR, 'acp-agent-config.json');

/**
 * Read the persisted ACP agent config. Returns null if not configured yet.
 */
export const readAcpAgentConfig = () => {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
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
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch {
    // Best-effort — a failed write must never break the session flow.
  }
};

/**
 * Clear the persisted config (e.g. when ACP is disabled or the agent removed).
 */
export const clearAcpAgentConfig = () => {
  try {
    fs.rmSync(CONFIG_FILE, { force: true });
  } catch {
    // ignore
  }
};
