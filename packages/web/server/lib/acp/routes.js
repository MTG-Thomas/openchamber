// ACP HTTP routes. Wires the AcpEventSource to Express endpoints behind the
// OPENCHAMBER_ACP_ENABLED feature flag. All endpoints are partial-failure-safe:
// transport/handshake failures return a non-success status with an explicit
// error payload, never an empty success that could masquerade as authoritative
// state (NFR-4).
//
// Per decision FEAT-2010-DEC-1, one ACP agent connection is active at a time
// (single-client); initialize replaces any active source.

import express from 'express';
import { isAcpEnabled, getStartupAcpConfig } from './env.js';
import { AcpEventSource } from './acp-event-source.js';
import { acpTelemetry } from './telemetry.js';
import { writeAcpAgentConfig, clearAcpAgentConfig } from './acp-config.js';
import { getTranscript } from './session-transcript.js';

let activeSource = null;
let activeConfig = null;
// The model the user last chose via the config route. Each /initialize starts a
// fresh session on the agent's default model, so this is re-applied after every
// start: picking a model before a session exists (new-session composer) must
// carry into the session that gets created.
let stickyModel = null;

/** Set of known ACP session IDs (populated from session/list + creates). */
export const knownAcpSessionIds = new Set();

// Cache of session messages to avoid re-replaying on every request.
const sessionMessageCache = new Map();
const SESSION_CACHE_TTL_MS = 60_000;
// In-flight loaders: prevent concurrent session/load calls for the same
// session (the ACP connection handles one session context at a time).
const sessionMessageLoaders = new Map();

/**
 * Fetch a session's message history from the ACP agent and return it in the
 * OpenCode SDK format ([{ info: Message, parts: Part[] }]) so the existing UI
 * pipeline renders it unchanged. Caches for 60s and deduplicates concurrent
 * requests for the same session.
 */
export async function getAcpSessionMessages(sessionId) {
  // Return cached if fresh.
  const cached = sessionMessageCache.get(sessionId);
  if (cached && Date.now() - cached.timestamp < SESSION_CACHE_TTL_MS) {
    return cached.messages;
  }

  // If a load is already in progress for this session, await it instead of
  // starting a conflicting concurrent session/load on the ACP connection.
  const existing = sessionMessageLoaders.get(sessionId);
  if (existing) {
    return existing;
  }

  // Live turns recorded in this process are authoritative for their sessions:
  // each /initialize creates a brand-new agent session, so a non-empty
  // transcript IS the history, and a session/load replay would only duplicate
  // those turns under different synthesized ids.
  //
  // The active session is special even with an empty transcript: issuing
  // session/load for the session the agent is currently running makes pi swap
  // its session state out from under the in-flight turn (it stalls or reports
  // "Active session disposed"). Serve what the transcript has and never load
  // the live session onto itself.
  const isActiveSession = Boolean(activeSource && activeSource.sessionID === sessionId);
  const live = getTranscript(sessionId);
  if (isActiveSession || live.length > 0) {
    sessionMessageCache.set(sessionId, { messages: live, timestamp: Date.now() });
    return live;
  }

  if (!activeSource) {
    // No active connection: an empty transcript is a genuinely empty session.
    return [];
  }

  const loader = (async () => {
    try {
      const events = await activeSource.loadSession(sessionId, {});
      const messages = eventsToOpenCodeMessages(events);
      sessionMessageCache.set(sessionId, { messages, timestamp: Date.now() });
      return messages;
    } finally {
      sessionMessageLoaders.delete(sessionId);
    }
  })();

  sessionMessageLoaders.set(sessionId, loader);
  return loader;
}

// Convert translated 2.x wire events into the SessionMessageInfo records the
// `message.list` contract serves ({ data: [...records], cursor }). Each record
// is exactly what the UI's `projectMessages` expects for its type.
const eventsToOpenCodeMessages = (events) => {
  const records = new Map(); // messageID -> wire record

  for (const event of events) {
    const data = event?.data ?? {};
    const created = Number.isFinite(event?.created) ? event.created : Date.now();
    if (event?.type === 'session.inbox.enqueued' && data.item?.type === 'user') {
      records.set(data.inboxID, {
        type: 'user',
        id: data.inboxID,
        text: data.item.payload?.text ?? '',
        time: { created },
      });
      continue;
    }
    if (event?.type === 'session.step.started' && data.assistantMessageID) {
      records.set(data.assistantMessageID, {
        type: 'assistant',
        id: data.assistantMessageID,
        agent: data.agent ?? 'ACP',
        model: data.model ?? { providerID: 'acp', id: 'acp' },
        content: [],
        time: { created },
      });
      continue;
    }
    const messageID = data.assistantMessageID;
    if (!messageID || !records.has(messageID)) continue;
    const record = records.get(messageID);
    if (event.type === 'session.text.ended') {
      record.content = [{ type: 'text', text: data.text ?? '' }];
    } else if (event.type === 'session.text.delta') {
      const current = record.content.find((item) => item.type === 'text');
      if (current) current.text += data.delta ?? '';
      else record.content.push({ type: 'text', text: data.delta ?? '' });
    } else if (event.type === 'session.step.ended') {
      record.time = { ...record.time, completed: created };
      record.finish = data.finish ?? 'stop';
    }
  }

  // Sort by time.created, return as array.
  return Array.from(records.values()).sort((a, b) => {
    const ta = a?.time?.created ?? 0;
    const tb = b?.time?.created ?? 0;
    return ta - tb;
  });
};

const json = (res, status, body) =>
  res.status(status).json(body);

const ensureEnabled = (res) => {
  if (isAcpEnabled()) return true;
  json(res, 404, { error: 'ACP support is disabled (OPENCHAMBER_ACP_ENABLED)' });
  return false;
};

const teardownActive = async () => {
  if (activeSource) {
    await activeSource.stop().catch(() => {});
    activeSource = null;
    activeConfig = null;
  }
};

/**
 * Apply the last user-chosen model to a freshly started session. Best-effort:
 * an agent without model support must not fail session creation. Awaited by
 * callers so a config read after start already reflects the choice.
 */
const applyStickyModel = async (source) => {
  if (!stickyModel || !source) return;
  try {
    await source.setConfigOption(stickyModel.configId, stickyModel.value);
  } catch (error) {
    console.warn(`[acp] failed to apply chosen model: ${error?.message ?? error}`);
  }
};

/**
 * @param {import('express').Express} app
 * @param {{ globalMessageStreamHub?: { publishEvent: (payload: unknown, opts?: { directory?: string }) => void } }} options
 */
/**
 * Initialize the ACP agent at server startup if OPENCHAMBER_ACP_COMMAND is set.
 * Spawns the agent, completes the handshake, and creates an initial session so
 * session/list and prompt are immediately available without waiting for the
 * first /initialize from the UI.
 */
export async function initAcpOnStartup(hub, setSessionStatus) {
  if (!isAcpEnabled()) return;
  const config = getStartupAcpConfig();
  if (!config) return;

  const RETRY_DELAY_MS = 3000;
  let attempt = 0;

  // Retry indefinitely — the agent may need multiple warm-up attempts.
  for (;;) {
    attempt += 1;
    console.log(`[acp] startup init (attempt ${attempt}): command=${config.command}`);
    const source = new AcpEventSource({
      hub,
      updateStatus: setSessionStatus,
      directory: config.cwd,
      agentId: config.agentId,
      agentName: config.agentName,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
    });

    try {
      await source.start();
      activeSource = source;
      activeConfig = { command: config.command, agentId: config.agentId };
      knownAcpSessionIds.add(source.sessionID);
      console.log(`[acp] startup init complete: sessionId=${source.sessionID}`);
      try {
        const sessions = await source.listSessions(config.cwd);
        for (const s of sessions) {
          if (s.sessionId) knownAcpSessionIds.add(s.sessionId);
        }
        console.log(`[acp] startup session/list returned ${sessions.length} session(s); known ACP IDs: ${knownAcpSessionIds.size}`);
      } catch (e) {
        console.warn(`[acp] startup session/list failed: ${e?.message ?? e}`);
      }
      await applyStickyModel(source);
      return; // success
    } catch (error) {
      console.error(`[acp] startup init attempt ${attempt} failed: ${error?.message ?? error}`);
      await source.stop().catch(() => {});
      console.log(`[acp] retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

export function registerAcpRoutes(app, options = {}) {
  if (!app) return;
  const hub = options.globalMessageStreamHub;
  const setSessionStatus = options.setSessionStatus;

  // Persist the ACP agent config when the user changes it in settings.
  // The server reads this at startup to initialize the agent.
  app.put('/api/agent/acp/config', express.json({ limit: '1mb' }), async (req, res) => {
    if (!ensureEnabled(res)) return;
    const body = req.body ?? {};
    if (typeof body.command !== 'string' || body.command.trim().length === 0) {
      // Empty command = clear the config (ACP agent removed or disabled).
      clearAcpAgentConfig();
      return json(res, 200, { ok: true });
    }
    writeAcpAgentConfig({
      command: body.command,
      args: Array.isArray(body.args) ? body.args : undefined,
      agentName: typeof body.agentName === 'string' ? body.agentName : undefined,
      agentId: typeof body.agentId === 'string' ? body.agentId : 'acp-startup',
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
    });
    return json(res, 200, { ok: true });
  });

  app.post('/api/agent/acp/initialize', express.json({ limit: "1mb" }), async (req, res) => {
    if (!ensureEnabled(res)) return;

    const body = req.body ?? {};
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!command) {
      // Validate BEFORE touching the active source: a malformed request must
      // never tear down a working agent connection.
      return json(res, 400, { error: 'Missing required field: command' });
    }

    // Replace any active source (single-client-at-a-time). Always create a
    // fresh connection + session: reusing the existing session would
    // concatenate the new message with the old conversation history.
    await teardownActive();

    const source = new AcpEventSource({
      hub,
      updateStatus: setSessionStatus,
      directory: typeof body.directory === 'string' ? body.directory : undefined,
      agentId: typeof body.agentId === 'string' ? body.agentId : 'acp-agent',
      agentName: (typeof body.name === 'string' && body.name.length > 0 ? body.name : null) || (typeof body.agentId === 'string' ? body.agentId : 'ACP'),
      command,
      args: Array.isArray(body.args) ? body.args : undefined,
      env: body.env && typeof body.env === 'object' ? body.env : undefined,
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
    });

    try {
      const startedAt = Date.now();
      acpTelemetry.initializeStart(body.agentId);
      const session = await source.start();
      activeSource = source;
      activeConfig = { command, agentId: body.agentId };
      knownAcpSessionIds.add(session.sessionId);
      acpTelemetry.initializeResult(body.agentId, 'success', Date.now() - startedAt);
      acpTelemetry.sessionCreated(body.agentId);
      // Fetch existing sessions so the sidebar can populate immediately.
      let existingSessions = [];
      try {
        existingSessions = await source.listSessions(body.cwd);
        for (const s of existingSessions) {
          if (s.sessionId) knownAcpSessionIds.add(s.sessionId);
        }
        console.log(`[acp] session/list returned ${existingSessions.length} session(s); known ACP IDs: ${knownAcpSessionIds.size}`);
      } catch (e) {
        console.warn(`[acp] session/list failed: ${e?.message ?? e}`);
      }
      // A model chosen before this session existed (new-session composer) must
      // land on the session that was just created.
      await applyStickyModel(source);
      return json(res, 200, {
        sessionID: session.sessionId,
        capabilities: source.options,
        backend: 'acp',
        sessions: existingSessions,
        configOptions: source.listConfigOptions?.() ?? [],
      });
    } catch (error) {
      acpTelemetry.initializeResult(body.agentId, 'error', 0, error?.code);
      acpTelemetry.transportError('initialize', error?.code);
      await source.stop().catch(() => {});
      return json(res, 502, { error: error?.message ?? 'ACP initialize failed' });
    }
  });

  app.post('/api/agent/acp/session/prompt', express.json({ limit: "1mb" }), async (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) {
      return json(res, 409, { error: 'No active ACP session (call /initialize first)' });
    }
    const body = req.body ?? {};
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text) {
      return json(res, 400, { error: 'Missing required field: text' });
    }
    if (activeSource.isPrompting()) {
      return json(res, 409, { error: 'An ACP turn is already running for this session' });
    }
    const sessionID = typeof body.sessionID === 'string' ? body.sessionID : activeSource.sessionID;
    const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : undefined;

    // Accept the turn and answer immediately. An ACP turn can run for minutes
    // (slow providers, tool use); holding this HTTP request open makes clients
    // time out or abort mid-turn and then report the send as failed even though
    // the agent is still working. Progress, completion, and failures reach the
    // client over the event stream instead, exactly like an OpenCode turn.
    const startedAt = Date.now();
    acpTelemetry.promptSubmitted(activeConfig?.agentId);
    void activeSource
      .prompt({ text, sessionID, userMessageId })
      .then((stopReason) => {
        acpTelemetry.turnCompleted(activeConfig?.agentId, stopReason, Date.now() - startedAt);
      })
      .catch((error) => {
        // prompt() already published a failed execution status; just record it.
        acpTelemetry.transportError('prompt', error?.code);
      });

    return json(res, 202, { accepted: true, sessionID, userMessageId: userMessageId ?? null });
  });

  app.post('/api/agent/acp/session/cancel', express.json({ limit: "1mb" }), async (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) {
      return json(res, 409, { error: 'No active ACP session' });
    }
    try {
      activeSource.cancel?.();
      return json(res, 202, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error?.message ?? 'ACP cancel failed' });
    }
  });

  // Reply to an agent `session/request_permission` (FR-7). The pending request
  // was published to the UI as `permission.asked`; this resolves it and the
  // event source answers the agent with the matching option.
  app.post('/api/agent/acp/session/permission', express.json({ limit: "1mb" }), (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) {
      return json(res, 409, { error: 'No active ACP session' });
    }
    const body = req.body ?? {};
    const requestID = typeof body.requestID === 'string' ? body.requestID : '';
    if (!requestID) {
      return json(res, 400, { error: 'Missing required field: requestID' });
    }
    const reply = body.reply;
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
      return json(res, 400, { error: 'Invalid reply (expected once, always, or reject)' });
    }
    if (!activeSource.resolvePermission(requestID, reply)) {
      return json(res, 404, { error: 'No pending permission request with that id' });
    }
    return json(res, 200, { ok: true });
  });

  // Agent-reported session configuration (models, thinking, ...). The composer
  // model picker lists the options and switches the model through this route.
  app.get('/api/agent/acp/session/config', (_req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) {
      return json(res, 409, { error: 'No active ACP session' });
    }
    return json(res, 200, {
      configOptions: activeSource.listConfigOptions?.() ?? [],
      modelConfigId: activeSource.modelConfigId?.() ?? null,
    });
  });

  app.post('/api/agent/acp/session/config', express.json({ limit: "1mb" }), async (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) {
      return json(res, 409, { error: 'No active ACP session' });
    }
    const body = req.body ?? {};
    const configId = typeof body.configId === 'string' ? body.configId : '';
    if (!configId) {
      return json(res, 400, { error: 'Missing required field: configId' });
    }
    if (typeof body.value !== 'string' || body.value.length === 0) {
      return json(res, 400, { error: 'Missing required field: value' });
    }
    try {
      const configOptions = await activeSource.setConfigOption(configId, body.value);
      // Remember the choice so every session this agent creates starts on it.
      stickyModel = { configId, value: body.value };
      return json(res, 200, { configOptions });
    } catch (error) {
      acpTelemetry.transportError('config', error?.code);
      return json(res, 502, { error: error?.message ?? 'ACP set config option failed' });
    }
  });

  app.post('/api/agent/acp/shutdown', express.json({ limit: "1mb" }), async (_req, res) => {
    if (!ensureEnabled(res)) return;
    await teardownActive();
    return json(res, 200, { ok: true });
  });

  app.post('/api/agent/acp/session/load', express.json({ limit: "1mb" }), async (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) return json(res, 409, { error: 'No active ACP session' });
    const body = req.body ?? {};
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) return json(res, 400, { error: 'Missing sessionId' });
    try {
      const events = await activeSource.loadSession(sessionId, { userMessageId: body.userMessageId, directory: body.directory });
      return json(res, 200, { ok: true, events });
    } catch (error) {
      return json(res, 502, { error: error?.message ?? 'ACP session/load failed' });
    }
  });

  // Session lifecycle: list / delete existing agent sessions (FR-9).
  app.get('/api/agent/acp/sessions', async (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) return json(res, 200, { sessions: [] });
    try {
      const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
      const sessions = await activeSource.listSessions(cwd);
      return json(res, 200, { sessions });
    } catch (error) {
      return json(res, 502, { error: error?.message ?? 'ACP session/list failed' });
    }
  });

  app.delete('/api/agent/acp/sessions/:sessionId', async (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) return json(res, 409, { error: 'No active ACP session' });
    const sessionId = req.params?.sessionId;
    if (!sessionId) return json(res, 400, { error: 'Missing sessionId' });
    try {
      await activeSource.deleteSession(sessionId);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 502, { error: error?.message ?? 'ACP session/delete failed' });
    }
  });
}

/** Test helper: reset module-level state between route tests. */
export const _resetAcpRoutesState = async () => {
  stickyModel = null;
  await teardownActive();
};
