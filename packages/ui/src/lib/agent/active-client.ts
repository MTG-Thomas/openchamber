// Active agent-client selector.
//
// Returns the currently active AgentClient. OpenCode is the default backend;
// ACP selection is wired in task 10 (single-client-at-a-time per decision
// FEAT-2010-DEC-1). Until then this always returns the OpenCode adapter.

import type { AgentClient } from "./types";
import { opencodeClient } from "../opencode/client";

let activeClient: AgentClient = opencodeClient;

/**
 * Returns the active agent client used for session-create and prompt seams.
 * Default: the OpenCode adapter. Task 10 overrides this when an ACP agent is
 * selected.
 */
export const getActiveAgentClient = (): AgentClient => activeClient;

/**
 * Override the active client (used by task 10's selection wiring). Accepts
 * null to reset to the OpenCode default.
 */
export const setActiveAgentClient = (client: AgentClient | null): void => {
  activeClient = client ?? opencodeClient;
};
