import type { ModelRef, Metadata, Session, TokenUsageInfo } from "../opencode/model";
import type { ContextPartMetadata } from "@/lib/messages/contextParts";
import type { SkillMentions } from "../opencode/client";

/**
 * Agent backend types. OpenCode is the default; ACP is opt-in behind a feature
 * flag. Per decision FEAT-2010-DEC-1, one backend is active at a time.
 */
export type AgentBackendType = "opencode" | "acp";

/**
 * Marks a session as ACP-backed. Lives on the session record's metadata under
 * the established `openchamber` namespace so `isAcpSession` can gate OpenCode
 * calls that a foreign session id would break.
 */
export const ACP_SESSION_METADATA: Metadata = {
  openchamber: { acp: true },
} as Metadata;

export const isAcpSessionRecord = (session: { metadata?: Metadata } | undefined): boolean => {
  // SAFETY: metadata values are JsonValue; the ACP marker's shape is owned by
  // this module (ACP_SESSION_METADATA) and re-narrowed here.
  const namespace = session?.metadata?.openchamber as { acp?: unknown } | undefined;
  return namespace?.acp === true;
};

/** Zero usage, matching the shape projected assistant messages carry. */
export const ZERO_TOKEN_USAGE: TokenUsageInfo = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/**
 * Parameters for creating a session. Mirrors the OpenCode 2.x createSession
 * shape so the OpenCode adapter is a thin pass-through; the ACP adapter maps
 * the fields it needs (title/metadata) onto ACP session/new.
 */
export type CreateSessionParams = {
  id?: string;
  title?: string;
  agent?: string;
  model?: ModelRef;
  metadata?: Metadata;
};

/**
 * A file attachment in a prompt. Backend-neutral; the OpenCode adapter
 * normalizes MIME types, the ACP adapter maps to an ACP resource block.
 */
export type AgentFileInput = {
  id?: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
};

/**
 * An @-mention of a sub-agent within a prompt (OpenCode concept; ignored by
 * the ACP adapter in the Must scope).
 */
export type AgentMentionInput = {
  name: string;
  source?: { value: string; start: number; end: number };
};

/**
 * Parameters for sending a prompt (a user message) to a session. Mirrors the
 * OpenCode 2.x sendMessage shape so the OpenCode adapter is a thin
 * pass-through. Returns the client-generated message id; the streamed reply
 * arrives over the existing event stream for both backends.
 */
export type SendMessageParams = {
  /** Runtime key captured at queue time (OpenCode runtime guard; ignored by ACP). */
  runtimeKey?: string;
  id: string;
  /** Provider the prompt will run on, for the provider circuit breaker (OpenCode only). */
  providerID?: string;
  /** Model to switch the session to before sending (OpenCode only). */
  model?: ModelRef;
  /** Agent to switch the session to before sending (OpenCode only). */
  agent?: string;
  text: string;
  files?: Array<AgentFileInput>;
  /** Context items sent ahead of the prompt as synthetic messages. */
  context?: Array<{ text: string; metadata?: ContextPartMetadata; description?: string }>;
  messageId?: string;
  agentMentions?: Array<AgentMentionInput>;
  metadata?: Metadata;
  delivery?: "steer";
  directory?: string | null;
  /** Skills named inline; attached to the prompt so OpenCode loads them with it (OpenCode only). */
  skills?: SkillMentions;
};

/**
 * Capabilities reported by a backend. Minimal for the Must scope; slash
 * commands and other capabilities arrive in the Should milestone.
 */
export type AgentCapabilities = {
  /** Whether this backend can cancel an in-flight turn. */
  canCancel: boolean;
  /** Backend-reported slash command names, if any (Should milestone). */
  commands?: string[];
};

/** One selectable value for an agent-reported model option. */
export type AgentModelOption = {
  value: string;
  name: string;
  description?: string;
};

/** The agent's model select: its config id, current value, and options. */
export type AgentModelConfig = {
  configId: string;
  currentValue: string;
  options: AgentModelOption[];
};

/**
 * The agent-transport abstraction. Implementations:
 *   - OpenCodeAdapter (thin wrapper over the @opencode/client wrapper)
 *   - AcpClient (JSON-RPC over stdio via the server's /api/agent/acp/* endpoints)
 *
 * The interface is deliberately backend-neutral (NFR-2): it must not encode
 * single-client-only assumptions that would block a future multi-client
 * registry. Method shapes mirror the existing OpenCode surface so the OpenCode
 * adapter is a true thin pass-through.
 */
export interface AgentClient {
  /** Backend identifier. */
  readonly backend: AgentBackendType;
  /** Create a session bound to this backend. */
  createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session>;
  /** Send a prompt; returns the client-generated message id. */
  sendMessage(params: SendMessageParams): Promise<string>;
  /** Cancel the in-flight turn for a session (best-effort). */
  abortSession(id: string): Promise<boolean>;
  /** Reply to an agent permission request. Required by backends that surface them (ACP). */
  replyToPermission?(sessionId: string, requestId: string, reply: 'once' | 'always' | 'reject'): Promise<boolean>;
  /** Agent-reported selectable models, when the backend exposes them (ACP). */
  listModels?(sessionId: string): Promise<AgentModelConfig | null>;
  /** Switch the agent's model and return the updated selection. */
  setModel?(sessionId: string, configId: string, value: string): Promise<AgentModelConfig | null>;
  /** List sessions known to the backend (for the sidebar). */
  listSessions?(cwd?: string): Promise<Array<{ id: string; title?: string; [key: string]: unknown }>>;
  /** Load (resume) an existing session; history streams via events. */
  loadSession?(sessionId: string, directory?: string): Promise<Array<{ type: string; properties: Record<string, unknown> }>>;
  /** Delete a session. */
  deleteSession?(id: string, directory?: string | null): Promise<boolean>;
  /** Reported capabilities. */
  capabilities(): AgentCapabilities;
}
