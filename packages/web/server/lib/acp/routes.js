// ACP HTTP routes. Wires the AcpEventSource to Express endpoints behind the
// OPENCHAMBER_ACP_ENABLED feature flag. All endpoints are partial-failure-safe:
// transport/handshake failures return a non-success status with an explicit
// error payload, never an empty success that could masquerade as authoritative
// state (NFR-4).
//
// Per decision FEAT-2010-DEC-1, one ACP agent connection is active at a time
// (single-client); initialize replaces any active source.

import { createHash } from 'node:crypto';
import express from 'express';
import { isAcpEnabled, getStartupAcpConfig } from './env.js';
import { AcpEventSource } from './acp-event-source.js';
import { acpTelemetry } from './telemetry.js';
import { writeAcpAgentConfig, clearAcpAgentConfig } from './acp-config.js';
import { getTranscript, deleteTranscript } from './session-transcript.js';
import {
  setRegistryOwner,
  setRegistryAgentId,
  hasAcpSession,
  acpSessionCount,
  acpSessionDirectories,
  upsertAcpSession,
  removeAcpSession,
  getAcpSessionDirectory,
  recordAgentSessions,
  getAcpSessionInfo,
  listAcpSessionInfos,
  _resetAcpSessionRegistry,
} from './session-registry.js';

let activeSource = null;
let activeConfig = null;
let openCodeSessionExists = null;
// Foreground stores still use native IDs. Refuse an ambiguous ID rather than
// serving the other backend's transcript or applying a control to it.
const assertUnambiguousSession = async (sessionId, res) => {
  if (!openCodeSessionExists) return true;
  try {
    if (!await openCodeSessionExists(sessionId)) return true;
    json(res, 409, { error: 'Session ID belongs to both OpenCode and ACP; backend aliasing is required' });
  } catch {
    json(res, 503, { error: 'Cannot verify session backend ownership' });
  }
  return false;
};
// The model the user last chose via the config route. Each /initialize starts a
// fresh session on the agent's default model, so this is re-applied after every
// start: picking a model before a session exists (new-session composer) must
// carry into the session that gets created.
let stickyModel = null;

// How long an agent `session/list` answer for one directory is reused. Session
// list requests are polled by the UI; the agent is asked at most this often.
const SESSION_REFRESH_TTL_MS = 10_000;
// A slow agent must never hold a session list (and with it the sidebar) hostage.
const SESSION_REFRESH_TIMEOUT_MS = 3_000;
const sessionRefreshedAt = new Map(); // directory -> ms

/**
 * Identity of an agent: the launch configuration that decides what process
 * runs and which sessions it owns (command, args, env, agent id). The working
 * directory is not part of it: it is per session, and one agent serves
 * sessions in many projects. Hashed so env values are never kept as a string.
 */
const agentIdentity = ({ command, args, env, agentId }) => {
  const envEntries = env && typeof env === 'object'
    ? Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    : [];
  return createHash('sha256')
    .update(JSON.stringify([command, Array.isArray(args) ? args : [], envEntries, typeof agentId === 'string' ? agentId : '']))
    .digest('hex');
};

/**
 * Bind the session registry to the configured agent. Switching to a different
 * agent (or none) drops the previous agent's sessions: their ids mean nothing
 * to the new agent.
 */
const adoptAgent = (identity) => {
  setRegistryOwner(identity);
  sessionRefreshedAt.clear();
};

// Sources whose start() has not resolved yet. They are not the active source
// until it does, so teardown must be able to find and cancel them.
const pendingStarts = new Set();
let startupLoop = null;

class AcpStartSuperseded extends Error {
  constructor() {
    super('ACP agent start was superseded by a newer request or a configuration change');
  }
}

/** source.start(), cancellable by teardownActive(); rejects with AcpStartSuperseded when cancelled. */
const startTracked = async (source) => {
  const token = { source, cancelled: false };
  pendingStarts.add(token);
  try {
    const session = await source.start();
    if (token.cancelled) {
      await source.stop().catch(() => {});
      throw new AcpStartSuperseded();
    }
    return session;
  } catch (error) {
    throw token.cancelled ? new AcpStartSuperseded() : error;
  } finally {
    pendingStarts.delete(token);
  }
};

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
    // Without a connection the agent's history cannot be read, and an empty
    // list would pass for an authoritative empty session (and be cached by the
    // UI as such). Fail so the caller reports it.
    throw new Error('ACP agent is not running; session history is unavailable');
  }

  const loader = (async () => {
    try {
      const events = await activeSource.loadSession(sessionId, { directory: getAcpSessionDirectory(sessionId) });
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

const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Ask the active agent for its sessions in `directory` (session/list) and fold
 * them into the registry. Skipped while the agent is mid-turn or mid-load (the
 * connection serves one session context at a time) and throttled per directory.
 * A failure leaves the registry as it was: stale entries beat a vanished sidebar.
 */
const refreshAgentSessions = async (directory, { force = false } = {}) => {
  const source = activeSource;
  if (!source || !directory || source.isBusy()) return;
  if (!force && Date.now() - (sessionRefreshedAt.get(directory) ?? 0) < SESSION_REFRESH_TTL_MS) return;
  sessionRefreshedAt.set(directory, Date.now());
  try {
    const sessions = await withTimeout(source.listSessions(directory), SESSION_REFRESH_TIMEOUT_MS, 'ACP session/list');
    recordAgentSessions(sessions, directory);
  } catch (error) {
    sessionRefreshedAt.delete(directory);
    console.warn(`[acp] session/list refresh failed for ${directory}: ${error?.message ?? error}`);
  }
};

/**
 * Add the known ACP sessions to an OpenCode `session.list` answer
 * (`{ data: SessionInfo[], cursor }`). `directory` scopes the list the same way
 * OpenCode scopes its own.
 */
const overlayAcpSessionList = async (body, { directory, search } = {}) => {
  const directories = directory
    ? [directory]
    : [...new Set([...acpSessionDirectories(), activeSource?.options?.cwd].filter((d) => typeof d === 'string' && d))];
  await Promise.all(directories.map((d) => refreshAgentSessions(d)));
  const known = new Set(body.data.map((session) => session?.id));
  const added = listAcpSessionInfos({ directory, search }).filter((session) => !known.has(session.id));
  return added.length === 0 ? body : { ...body, data: [...body.data, ...added] };
};

const decodedDirectoryHeader = (req) => {
  const raw = req.get?.('x-opencode-directory');
  if (typeof raw !== 'string' || !raw) return undefined;
  if (req.get('x-opencode-directory-encoding') !== 'uri') return raw;
  try { return decodeURIComponent(raw); } catch { return raw; }
};

/**
 * Express middleware (mounted on `/api`, ahead of the OpenCode proxy): every
 * session list the UI reads replaces what the sidebar holds, and OpenCode's
 * list cannot contain ACP sessions, so the first page of each list is served
 * with the known ACP sessions added. Lists OpenCode answers with an error, or
 * that ACP sessions cannot belong to (children, other projects, later pages),
 * pass through unchanged.
 */
export const acpSessionListOverlay = (req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/session') return next();
  if (!activeSource && acpSessionCount() === 0) return next();
  const query = req.query ?? {};
  const parentID = typeof query.parentID === 'string' && query.parentID !== 'null' ? query.parentID : '';
  if (query.cursor || parentID || query.project || query.subpath) return next();

  const directory = (typeof query.directory === 'string' && query.directory) || decodedDirectoryHeader(req);
  const search = typeof query.search === 'string' ? query.search : undefined;
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode !== 200 || !Array.isArray(body?.data)) return sendJson(body);
    overlayAcpSessionList(body, { directory, search }).then(sendJson, (error) => {
      console.warn(`[acp] session list overlay failed: ${error?.message ?? error}`);
      sendJson(body);
    });
    return res;
  };
  return next();
};

/**
 * Express middleware (mounted on `/api`, ahead of the OpenCode proxy): answer
 * session-by-id requests for KNOWN ACP sessions, which OpenCode would reject
 * for a foreign id. Message requests return the agent's history in the
 * OpenCode format; a history that cannot be read is an error, never an empty
 * list. Everything else about other sessions falls through untouched.
 */
export const acpSessionInterceptor = async (req, res, next) => {
  const match = req.path?.match(/^\/session\/([^/]+)/);
  if (!match) return next();
  let sessionId = match[1];
  try { sessionId = decodeURIComponent(sessionId); } catch { /* keep raw id */ }
  if (!hasAcpSession(sessionId)) return next();
  if (!await assertUnambiguousSession(sessionId, res)) return res;

  if (req.method !== 'GET') return res.status(405).json({ error: 'This OpenCode operation is unavailable for ACP sessions' });

  if (/^\/session\/[^/]+\/message$/.test(req.path)) {
    try {
      const messages = await getAcpSessionMessages(sessionId);
      return res.status(200).json({ data: messages, cursor: {} });
    } catch (error) {
      console.warn(`[acp] /session/${sessionId}/message failed: ${error?.message ?? error}`);
      return res.status(502).json({ error: `ACP session history unavailable: ${error?.message ?? 'unknown error'}` });
    }
  }

  if (!/^\/session\/[^/]+$/.test(req.path)) return res.status(404).json({ error: 'Unsupported ACP session read' });

  // session.get — the session's OpenCode 2.x record (directory included).
  return res.status(200).json({ data: getAcpSessionInfo(sessionId) });
};

const ensureEnabled = (res) => {
  if (isAcpEnabled()) return true;
  json(res, 404, { error: 'ACP support is disabled (OPENCHAMBER_ACP_ENABLED)' });
  return false;
};

const teardownActive = async () => {
  // A source still starting (startup init, or an earlier /initialize) would
  // otherwise become active after this teardown and overwrite its result.
  if (startupLoop) startupLoop.cancelled = true;
  const pending = [...pendingStarts];
  for (const token of pending) token.cancelled = true;
  const stopping = pending.map((token) => token.source.stop().catch(() => {}));
  if (activeSource) {
    stopping.push(activeSource.stop().catch(() => {}));
    activeSource = null;
    activeConfig = null;
  }
  await Promise.all(stopping);
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
  const loop = { cancelled: false };
  startupLoop = loop;

  // Retry indefinitely — the agent may need multiple warm-up attempts.
  while (!loop.cancelled && attempt < 3) {
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
      resolveSessionDirectory: getAcpSessionDirectory,
    });

    try {
      await startTracked(source);
      const identity = agentIdentity(config);
      activeSource = source;
      activeConfig = { command: config.command, agentId: config.agentId, identity };
      adoptAgent(identity);
      setRegistryAgentId(config.agentId ?? 'acp-agent');
      console.log(`[acp] startup init complete: sessionId=${source.sessionID}`);
      // The agent's existing sessions for the project directory; the session
      // created above stays unlisted until the user sends its first prompt.
      await refreshAgentSessions(config.cwd || process.cwd(), { force: true });
      console.log(`[acp] startup session/list done; known ACP sessions: ${acpSessionCount()}`);
      await applyStickyModel(source);
      if (startupLoop === loop) startupLoop = null;
      return; // success
    } catch (error) {
      await source.stop().catch(() => {});
      if (loop.cancelled || error instanceof AcpStartSuperseded) {
        console.log('[acp] startup init cancelled by a newer request or configuration change');
        return;
      }
      console.error(`[acp] startup init attempt ${attempt} failed: ${error?.message ?? error}`);
      console.log(`[acp] retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

export function registerAcpRoutes(app, options = {}) {
  if (!app) return;
  const hub = options.globalMessageStreamHub;
  openCodeSessionExists = options.openCodeSessionExists ?? null;
  // Ownership is checked at the runtime boundary, including cancel/permissions.
  app.use('/api/agent/acp/session', express.json({ limit: '1mb' }), async (req, res, next) => {
    const agentId = req.body?.agentId ?? req.query?.agentId;
    if (agentId && agentId !== activeConfig?.agentId) return json(res, 409, { error: 'ACP backend owner changed; reconnect the owning agent' });
    const sessionId = req.body?.sessionID ?? req.body?.sessionId ?? req.query?.sessionID;
    if (sessionId && !hasAcpSession(sessionId)) return json(res, 404, { error: 'Unknown ACP session owner' });
    // Explicit controls already name the ACP agent/session and the route
    // checks the active turn/request. An OpenCode outage must not block Stop
    // or a pending permission on an independently running ACP turn.
    const explicitControl = agentId && sessionId && ['/cancel', '/permission'].includes(req.path);
    if (sessionId && !explicitControl && !await assertUnambiguousSession(sessionId, res)) return res;
    return next();
  });
  const setSessionStatus = options.setSessionStatus;

  // Persist the ACP agent config when the user changes it in settings.
  // The server reads this at startup to initialize the agent.
  app.put('/api/agent/acp/config', express.json({ limit: '1mb' }), async (req, res) => {
    if (!ensureEnabled(res)) return;
    const body = req.body ?? {};
    if (typeof body.command !== 'string' || body.command.trim().length === 0) {
      // Empty command = clear the config (ACP agent removed or disabled). The
      // agent stops with it, so its sessions leave the session lists.
      clearAcpAgentConfig();
      await teardownActive();
      adoptAgent(null);
      return json(res, 200, { ok: true });
    }
    const command = body.command.trim();
    const identity = agentIdentity({ command, args: body.args, env: body.env, agentId: body.agentId });
    if (activeSource?.isBusy() && activeConfig?.identity !== identity) return json(res, 409, { error: 'Finish or cancel the running ACP turn before changing agents' });
    if (activeConfig?.identity !== identity) {
      // A different launch configuration: the running agent (or one still
      // starting) no longer matches the settings.
      await teardownActive();
    }
    // Sessions of a previously configured, different agent leave the lists.
    adoptAgent(identity);
    writeAcpAgentConfig({
      command: body.command,
      args: Array.isArray(body.args) ? body.args : undefined,
      agentName: typeof body.agentName === 'string' ? body.agentName : undefined,
      agentId: typeof body.agentId === 'string' ? body.agentId : 'acp-startup',
      cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
    });
    return json(res, 200, { ok: true });
  });

  // Whether this server has ACP enabled. Answered even when it is not, so the
  // UI can tell "disabled" from "unreachable" and avoid a stored ACP selection.
  app.get('/api/agent/acp/status', (_req, res) => {
    const enabled = isAcpEnabled();
    const config = enabled ? getStartupAcpConfig() : null;
    const agent = config ? { id: config.agentId || 'acp-agent', name: config.agentName || 'ACP',
      command: config.command, args: config.args, enabled: true } : null;
    return json(res, 200, { enabled, ...(agent ? { agent } : {}) });
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

    if (activeSource?.isBusy()) return json(res, 409, { error: 'Finish or cancel the running ACP turn before creating another session' });

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
      resolveSessionDirectory: getAcpSessionDirectory,
    });

    try {
      const startedAt = Date.now();
      acpTelemetry.initializeStart(body.agentId);
      const session = await startTracked(source);
      const identity = agentIdentity({ command, args: body.args, env: body.env, agentId: body.agentId });
      activeSource = source;
      activeConfig = { command, agentId: body.agentId, identity };
      adoptAgent(identity);
      setRegistryAgentId(body.agentId ?? 'acp-agent');
      const directory = source.options.directory || source.options.cwd || process.cwd();
      upsertAcpSession({ id: session.sessionId, directory });
      if (!await assertUnambiguousSession(session.sessionId, res)) return res;
      acpTelemetry.initializeResult(body.agentId, 'success', Date.now() - startedAt);
      acpTelemetry.sessionCreated(body.agentId);
      // The agent's earlier sessions in this directory join the registry, so
      // the session lists the UI reads include them.
      let existingSessions = [];
      try {
        // Bounded: a slow session/list is a partial result, never a failed initialize.
        existingSessions = await withTimeout(source.listSessions(directory), SESSION_REFRESH_TIMEOUT_MS, 'ACP session/list');
        recordAgentSessions(existingSessions, directory);
        sessionRefreshedAt.set(directory, Date.now());
        console.log(`[acp] session/list returned ${existingSessions.length} session(s); known ACP sessions: ${acpSessionCount()}`);
      } catch (e) {
        console.warn(`[acp] session/list failed: ${e?.message ?? e}`);
      }
      // A model chosen before this session existed (new-session composer) must
      // land on the session that was just created.
      await applyStickyModel(source);
      return json(res, 200, {
        sessionID: session.sessionId,
        capabilities: source._connection?.initializeResult?.agentCapabilities ?? {},
        backend: 'acp',
        sessions: existingSessions,
        configOptions: source.listConfigOptions?.() ?? [],
      });
    } catch (error) {
      await source.stop().catch(() => {});
      if (error instanceof AcpStartSuperseded) return json(res, 409, { error: error.message });
      acpTelemetry.initializeResult(body.agentId, 'error', 0, error?.code);
      acpTelemetry.transportError('initialize', error?.code);
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
    const source = activeSource;
    if (source.isPrompting()) {
      return json(res, 409, { error: 'An ACP turn is already running for this session' });
    }
    const sessionID = typeof body.sessionID === 'string' ? body.sessionID : source.sessionID;
    const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : undefined;

    // A prompt runs in the session it was sent to. When the agent is on another
    // session it is switched first; if it cannot be, the prompt is refused
    // here, where the client can show the reason, instead of running elsewhere.
    try {
      await source.switchTo(sessionID);
    } catch (error) {
      return json(res, 502, { error: error?.message ?? 'Could not switch the ACP agent to that session' });
    }
    if (source !== activeSource) {
      return json(res, 409, { error: 'The ACP agent was replaced while the prompt was being prepared' });
    }
    if (source.isPrompting()) {
      return json(res, 409, { error: 'An ACP turn is already running for this session' });
    }

    // Accept the turn and answer immediately. An ACP turn can run for minutes
    // (slow providers, tool use); holding this HTTP request open makes clients
    // time out or abort mid-turn and then report the send as failed even though
    // the agent is still working. Progress, completion, and failures reach the
    // client over the event stream instead, exactly like an OpenCode turn.
    const startedAt = Date.now();
    acpTelemetry.promptSubmitted(activeConfig?.agentId);
    void source
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
      if (req.body?.sessionID && activeSource._activeTag && req.body.sessionID !== activeSource._activeTag) {
        return json(res, 409, { error: 'The running turn belongs to another ACP session' });
      }
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
    if (body.sessionID && body.sessionID !== activeSource._activeTag) return json(res, 409, { error: 'Permission belongs to another ACP session' });
    if (!activeSource.resolvePermission(requestID, reply)) {
      return json(res, 404, { error: 'No pending permission request with that id' });
    }
    return json(res, 200, { ok: true });
  });

  // Agent-reported session configuration (models, thinking, ...). The composer
  // model picker lists the options and switches the model through this route.
  app.get('/api/agent/acp/session/config', async (req, res) => {
    if (!ensureEnabled(res)) return;
    if (!activeSource) {
      return json(res, 409, { error: 'No active ACP session' });
    }
    const target = req.query.sessionID;
    if (target && target !== activeSource._current) {
      if (activeSource.isBusy()) return json(res, 409, { error: 'ACP agent is busy in another session' });
      try { await activeSource.switchTo(target); } catch (error) { return json(res, 502, { error: error.message }); }
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
      if (activeSource.isBusy()) return json(res, 409, { error: 'ACP agent is busy' });
      if (body.sessionID) await activeSource.switchTo(body.sessionID);
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
    adoptAgent(null);
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
    if (!activeSource) return json(res, 409, { error: 'ACP agent is not connected' });
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
      // Gone from the agent: gone from the lists, and its cached history too.
      removeAcpSession(sessionId);
      sessionMessageCache.delete(sessionId);
      deleteTranscript(sessionId);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 502, { error: error?.message ?? 'ACP session/delete failed' });
    }
  });
}

/** Test helper: reset module-level state between route tests. */
export const _resetAcpRoutesState = async () => {
  openCodeSessionExists = null;
  stickyModel = null;
  await teardownActive();
  sessionRefreshedAt.clear();
  _resetAcpSessionRegistry();
};

export const stopAcpRuntime = async () => { await teardownActive(); };
