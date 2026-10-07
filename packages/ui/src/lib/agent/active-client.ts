import { isAcpSessionRecord, acpSessionOwnerSchema } from './types';
import type { Session } from '../opencode/model';
// Draft selection and existing-session ownership are independent.

import type { AgentClient } from "./types";
import { opencodeClient } from "../opencode/client";

let activeClient: AgentClient = opencodeClient;
const sessionClients = new Map<string, AgentClient>();
export const replaceSessionAgentClients = (clients: Iterable<[string, AgentClient]>): void => {
  sessionClients.clear();
  for (const [id, client] of clients) sessionClients.set(id, client);
};

/**
 * Returns the backend selected for new session drafts; OpenCode is the default.
 */
export const getActiveAgentClient = (): AgentClient => activeClient;

/**
 * Override the active client (used by task 10's selection wiring). Accepts
 * null to reset to the OpenCode default.
 */
export const setActiveAgentClient = (client: AgentClient | null): void => {
  activeClient = client ?? opencodeClient;
};

/** Existing sessions always route by their owner, independent of draft selection. */
export const getSessionAgentClient = (session: Session | undefined): AgentClient => {
  if (!isAcpSessionRecord(session)) return opencodeClient;
  const owner = acpSessionOwnerSchema.safeParse(session?.metadata?.openchamber);
  if (!owner.success) throw new Error('ACP session has no backend owner');
  const client = sessionClients.get(owner.data.agentId);
  if (!client) throw new Error('Configure the ACP agent that owns this session before continuing');
  return client;
};
