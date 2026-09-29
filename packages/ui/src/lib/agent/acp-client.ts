// AcpClient: UI-side AgentClient implementation for the ACP backend. Calls the
// server's /api/agent/acp/* endpoints over the authenticated runtime transport
// (runtimeFetch). The server owns the subprocess and the JSON-RPC connection;
// this adapter only issues HTTP requests and maps responses onto the
// AgentClient contract.
//
// Failure semantics (NFR-4): transport/handshake failures throw — they never
// resolve to an empty success that could masquerade as authoritative state.
// The ACP path does not reuse the OpenCode HTTP provider-circuit.

import type { Session } from "../opencode/model";
import { ACP_SESSION_METADATA, ZERO_TOKEN_USAGE } from "./types";
import { runtimeFetch } from "@/lib/runtime-fetch";
import type {
  AgentClient,
  AgentBackendType,
  AgentCapabilities,
  AgentModelConfig,
  AgentModelOption,
  CreateSessionParams,
  SendMessageParams,
} from "./types";

export type AcpAgentRuntimeConfig = {
  /** Agent executable to spawn on the server. */
  command: string;
  /** Args for the executable. */
  args?: string[];
  /** Extra env for the agent subprocess. */
  env?: Record<string, string>;
  /** Stable agent id (links to the server-side process registry). */
  agentId?: string;
  /** Display name (shown in the assistant message footer). */
  name?: string;
};

const JSON_HEADERS = { Accept: "application/json", "Content-Type": "application/json" } as const;

/** Session entry in an ACP initialize/session-list response. */
export type AcpSessionRef = {
  sessionId: string;
  title?: string;
};

/** Trusted shape of an ACP /initialize response. */
type InitializePayload = {
  sessionID: string;
  sessions: AcpSessionRef[];
};

/** Trusted shape of an ACP session/load response. */
type LoadPayload = {
  events: Array<{ type: string; properties: Record<string, unknown> }>;
};

const readJsonBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

/** Read an OpenChamber error payload ({ error: string }) from a non-success response. */
const parseErrorBody = async (response: Response): Promise<string | null> => {
  const body = await readJsonBody(response);
  if (!body || typeof body !== "object" || !("error" in body)) return null;
  // SAFETY: body is a non-null object with an `error` own/inherited key (checked above).
  const error = (body as { error: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
};

const asSessionRef = (value: unknown): AcpSessionRef | null => {
  if (!value || typeof value !== "object") return null;
  // SAFETY: value passed the object check above; fields are re-validated below.
  const record = value as { sessionId?: unknown; title?: unknown };
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return null;
  return {
    sessionId: record.sessionId,
    ...(typeof record.title === "string" && record.title.length > 0 ? { title: record.title } : {}),
  };
};

/** Parse an /initialize response body; null when the payload is not the trusted shape. */
const parseInitializeBody = (body: unknown): InitializePayload | null => {
  if (!body || typeof body !== "object") return null;
  // SAFETY: body passed the object check above; fields are validated before use.
  const record = body as { sessionID?: unknown; sessions?: unknown };
  if (typeof record.sessionID !== "string" || record.sessionID.length === 0) return null;
  const sessions = Array.isArray(record.sessions)
    ? record.sessions.map(asSessionRef).filter((s): s is AcpSessionRef => s !== null)
    : [];
  return { sessionID: record.sessionID, sessions };
};

/** Parse a /sessions response body ({ sessions: [...] }); null when not the trusted shape. */
const parseSessionListBody = (body: unknown): AcpSessionRef[] | null => {
  if (!body || typeof body !== "object") return null;
  // SAFETY: body passed the object check above; sessions is validated below.
  const sessions = (body as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return null;
  return sessions.map(asSessionRef).filter((s): s is AcpSessionRef => s !== null);
};

/** Parse a session/load response body ({ events: [...] }); null when not the trusted shape. */
const parseLoadBody = (body: unknown): LoadPayload | null => {
  if (!body || typeof body !== "object") return null;
  // SAFETY: body passed the object check above; events is validated below.
  const record = body as { events?: unknown };
  if (!Array.isArray(record.events)) return null;
  const events: LoadPayload["events"] = [];
  for (const event of record.events) {
    if (!event || typeof event !== "object") continue;
    // SAFETY: event passed the object check above; fields are validated below.
    const entry = event as { type?: unknown; properties?: unknown };
    if (typeof entry.type !== "string" || !entry.properties || typeof entry.properties !== "object") continue;
    // SAFETY: properties is a non-null object (checked above); the event
    // contract carries arbitrary JSON values by definition.
    events.push({
      type: entry.type,
      properties: entry.properties as LoadPayload["events"][number]["properties"],
    });
  }
  return { events };
};

const asModelOption = (value: unknown): AgentModelOption | null => {
  if (!value || typeof value !== "object") return null;
  // SAFETY: value passed the object check; fields are validated below.
  const record = value as { value?: unknown; name?: unknown; description?: unknown };
  if (typeof record.value !== "string" || record.value.length === 0) return null;
  return {
    value: record.value,
    name: typeof record.name === "string" && record.name.length > 0 ? record.name : record.value,
    ...(typeof record.description === "string" && record.description.length > 0
      ? { description: record.description }
      : {}),
  };
};

// Agent config option values are a flat list or a list of groups; flatten both.
const collectModelOptions = (options: unknown): AgentModelOption[] => {
  if (!Array.isArray(options)) return [];
  const collected: AgentModelOption[] = [];
  for (const entry of options) {
    if (!entry || typeof entry !== "object") continue;
    // SAFETY: entry passed the object check; grouped options are validated below.
    const nested = (entry as { options?: unknown }).options;
    if (Array.isArray(nested)) {
      for (const child of nested) {
        const option = asModelOption(child);
        if (option) collected.push(option);
      }
    } else {
      const option = asModelOption(entry);
      if (option) collected.push(option);
    }
  }
  return collected;
};

/**
 * Extract the agent's model select from a session config-options payload.
 * Returns null when the agent reports no selectable model; that is valid empty,
 * not a failure (transport failures throw before this is called).
 */
const parseModelConfig = (body: unknown): AgentModelConfig | null => {
  if (!body || typeof body !== "object") return null;
  // SAFETY: body passed the object check; configOptions is validated below.
  const configOptions = (body as { configOptions?: unknown }).configOptions;
  if (!Array.isArray(configOptions)) return null;
  const model = configOptions.find((option) => {
    if (!option || typeof option !== "object") return false;
    // SAFETY: option passed the object check; fields are read, not trusted.
    const record = option as { category?: unknown; id?: unknown };
    return record.category === "model" || record.id === "model";
  });
  if (!model || typeof model !== "object") return null;
  // SAFETY: model passed the object check above.
  const select = model as { id?: unknown; type?: unknown; currentValue?: unknown; options?: unknown };
  if (typeof select.id !== "string" || select.id.length === 0) return null;
  if (select.type !== "select") return null;
  const options = collectModelOptions(select.options);
  if (options.length === 0) return null;
  const currentValue = typeof select.currentValue === "string" ? select.currentValue : options[0].value;
  return { configId: select.id, currentValue, options };
};

/**
 * Build a Session-shaped object from an ACP initialize response so the existing
 * UI session model (sidebar, stores) can represent an ACP session without
 * changes. Only the domain-required fields are populated. `id` is the
 * server-returned sessionID; the `openchamber.acp` metadata marker lets
 * `isAcpSession` gate OpenCode calls for this session.
 */
const buildAcpSession = (sessionID: string, directory: string | null, title: string | undefined): Session => {
  const now = Date.now();
  return {
    id: sessionID,
    projectID: "",
    directory: directory ?? "",
    title: title && title.trim().length > 0 ? title : "ACP session",
    cost: 0,
    tokens: ZERO_TOKEN_USAGE,
    time: { created: now, updated: now },
    metadata: ACP_SESSION_METADATA,
  };
};

export class AcpClient implements AgentClient {
  readonly backend: AgentBackendType = "acp";
  private readonly config: AcpAgentRuntimeConfig;
  /** Sessions returned by the last /initialize (for sidebar population). */
  private _initSessions: AcpSessionRef[] = [];

  constructor(config: AcpAgentRuntimeConfig) {
    this.config = config;
  }

  get initSessions(): Array<{ id: string; title?: string }> {
    return this._initSessions.map((s) => ({ id: s.sessionId, ...(s.title !== undefined ? { title: s.title } : {}) }));
  }

  async createSession(params?: CreateSessionParams, directory?: string | null): Promise<Session> {
    const body = {
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      agentId: this.config.agentId,
      name: this.config.name,
      cwd: directory ?? undefined,
      directory: directory ?? undefined,
    };

    const response = await runtimeFetch("/api/agent/acp/initialize", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const serverMessage = await parseErrorBody(response);
      throw new Error(serverMessage ?? `ACP initialize failed (${response.status})`);
    }

    const data = parseInitializeBody(await readJsonBody(response));
    if (!data) {
      // Distinguish failure from empty success (NFR-4).
      throw new Error("ACP initialize returned no session id");
    }

    // Store the sessions returned by /initialize for the sidebar.
    this._initSessions = data.sessions;

    return buildAcpSession(data.sessionID, directory ?? null, params?.title);
  }

  async sendMessage(params: SendMessageParams): Promise<string> {
    if (!params.id) {
      throw new Error("AcpClient.sendMessage requires a session id (params.id)");
    }

    const response = await runtimeFetch("/api/agent/acp/session/prompt", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionID: params.id, text: params.text, userMessageId: params.messageId }),
    });

    if (!response.ok) {
      const serverMessage = await parseErrorBody(response);
      throw new Error(serverMessage ?? `ACP prompt failed (${response.status})`);
    }

    // The streamed reply arrives over the existing event stream (server-side
    // translation into the normalized event protocol). Resolve with the
    // client-generated message id, matching the OpenCode adapter contract.
    return params.messageId ?? params.id;
  }

  async abortSession(id: string): Promise<boolean> {
    try {
      const response = await runtimeFetch("/api/agent/acp/session/cancel", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionID: id }),
      });
      return response.ok;
    } catch {
      // Cancel is best-effort; never let it mask the in-flight error state.
      return false;
    }
  }

  async replyToPermission(
    sessionId: string,
    requestId: string,
    reply: 'once' | 'always' | 'reject',
  ): Promise<boolean> {
    try {
      const response = await runtimeFetch("/api/agent/acp/session/permission", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionID: sessionId, requestID: requestId, reply }),
      });
      // 404 means the request is already resolved (answered, cancelled, or the
      // turn ended). The pending prompt is gone, so the user's goal is met.
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }

  async listModels(sessionId: string): Promise<AgentModelConfig | null> {
    const query = sessionId ? `?sessionID=${encodeURIComponent(sessionId)}` : "";
    const response = await runtimeFetch(`/api/agent/acp/session/config${query}`, {
      method: "GET",
      headers: JSON_HEADERS,
    });
    // 409 = no ACP session yet (composer mounted before initialize): treat as
    // "no models yet" so the picker falls back to the agent badge, not an error.
    if (response.status === 409) return null;
    if (!response.ok) {
      const serverMessage = await parseErrorBody(response);
      throw new Error(serverMessage ?? `ACP model list failed (${response.status})`);
    }
    return parseModelConfig(await readJsonBody(response));
  }

  async setModel(sessionId: string, configId: string, value: string): Promise<AgentModelConfig | null> {
    const response = await runtimeFetch("/api/agent/acp/session/config", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionID: sessionId, configId, value }),
    });
    if (!response.ok) {
      const serverMessage = await parseErrorBody(response);
      throw new Error(serverMessage ?? `ACP model switch failed (${response.status})`);
    }
    return parseModelConfig(await readJsonBody(response));
  }

  capabilities(): AgentCapabilities {
    return { canCancel: true };
  }

  async listSessions(cwd?: string): Promise<Array<{ id: string; title?: string }>> {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
    const response = await runtimeFetch(`/api/agent/acp/sessions${query}`, {
      method: 'GET',
      headers: JSON_HEADERS,
    });
    if (!response.ok) {
      // Failure is not empty success (NFR-4): callers keep prior state.
      const serverMessage = await parseErrorBody(response);
      throw new Error(serverMessage ?? `ACP session/list failed (${response.status})`);
    }
    const data = parseSessionListBody(await readJsonBody(response));
    if (!data) return [];
    return data.map((s) => ({ id: s.sessionId, ...(s.title !== undefined ? { title: s.title } : {}) }));
  }

  async deleteSession(id: string): Promise<boolean> {
    try {
      const response = await runtimeFetch(`/api/agent/acp/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: JSON_HEADERS,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async loadSession(sessionId: string, directory?: string): Promise<Array<{ type: string; properties: Record<string, unknown> }>> {
    const response = await runtimeFetch('/api/agent/acp/session/load', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ sessionId, directory }),
    });
    if (!response.ok) {
      const serverMessage = await parseErrorBody(response);
      throw new Error(serverMessage ?? `ACP session/load failed (${response.status})`);
    }
    const data = parseLoadBody(await readJsonBody(response));
    return data?.events ?? [];
  }
}
