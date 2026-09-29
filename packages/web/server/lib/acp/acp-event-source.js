// ACP event source: drives an ACP session over a managed connection and
// translates session/update notifications into OpenChamber's normalized event
// protocol, publishing them through the global hub so the existing UI sync
// layer renders the turn live without changes (assumption #1, validated by
// acp-translate tests).
//
// Lifecycle:
//   start()  -> spawns the agent, handshakes, builds a session, parks.
//   prompt() -> runs one prompt turn; translates each nextUpdate() and publishes.
//   stop()   -> tears down the connection.
//
// On any transport/handshake failure it publishes an explicit error
// session.status (never an empty success — NFR-4).

import { AcpAgentConnection } from './acp-connection.js';
import * as acp from '@agentclientprotocol/sdk';
import { isAcpDebug } from './env.js';
import { recordUserMessage, recordAssistantMessage } from './session-transcript.js';
import {
  acpUpdateToEvents,
  acpStopReasonToSessionStatus,
  acpErrorToSessionStatus,
  acpTurnStartedToEvents,
  acpPermissionToRequest,
  acpPermissionAskedToEvent,
  acpPermissionRepliedToEvent,
  acpPermissionReplyToResponse,
  assistantContentFromAcc,
  resetReplayCounters,
} from './acp-translate.js';

// Best-effort extraction of a model label for the message footer. ACP agents
// report model info inconsistently (session modes, meta, initialize caps), so
// search a few common locations.
const extractModelLabel = (session) => {
  if (!session) return null;
  // ACP agents report their model as a session config option (pi:
  // configOptions[id=model].currentValue), which is the model actually in use.
  const configOptions = session.configOptions ?? session.newSessionResponse?.configOptions;
  const modelOption = Array.isArray(configOptions)
    ? configOptions.find((option) => option && (option.category === 'model' || option.id === 'model'))
    : null;
  const candidates = [
    modelOption?.currentValue,
    session.model,
    session.modes?.model,
    session.meta?.model,
    session.meta?.defaultModel,
    session.newSessionResponse?.modes?.model,
    session.newSessionResponse?.meta?.model,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
    if (c && typeof c === 'object') {
      const id = c.id || c.modelID || c.name;
      if (typeof id === 'string' && id.length > 0) return id;
    }
  }
  return null;
};

// Session configuration options the agent reported at session/new (models,
// thinking level, ...). The client can change them via session/set_config_option.
const collectConfigOptions = (session) => {
  const options = session?.configOptions ?? session?.newSessionResponse?.configOptions;
  return Array.isArray(options) ? options : [];
};

// Some agents (e.g. pi-acp) emit a verbose session preamble (their config/skills
// listing) as the first agent_message_chunk AND report it in session meta
// (piAcp.startupInfo). Capture a fingerprint so the translator can drop that
// duplicate preamble instead of rendering it as the assistant reply.
const FINGERPRINT_LEN = 80;
const extractPreambleFingerprint = (session) => {
  const meta = session?.meta || session?.newSessionResponse?.meta;
  if (!meta || typeof meta !== 'object') return null;
  for (const value of Object.values(meta)) {
    if (value && typeof value === 'object') {
      const startup = value.startupInfo;
      if (typeof startup === 'string' && startup.trim().length > 0) {
        return startup.slice(0, FINGERPRINT_LEN);
      }
    }
  }
  return null;
};

/**
 * @typedef {Object} AcpEventSourceOptions
 * @property {object} hub                       Global message-stream hub (publishEvent).
 * @property {string} [directory]               Directory scope for published events.
 * @property {string} agentId                   Stable agent id (for the process registry).
 * @property {string} command                   Agent executable.
 * @property {string[]} [args]                  Agent args.
 * @property {Record<string,string>} [env]      Agent env.
 * @property {string} [cwd]                     Session cwd.
 * @property {string} [clientName="openchamber"]
 */

export class AcpEventSource {
  /**
   * @param {AcpEventSourceOptions} options
   */
  constructor(options) {
    this.options = options;
    this.sessionID = null;
    this._session = null;
    this._ctx = null;
    this._resolveSessionDone = null;
    this._connection = null;
    this._acc = { messageID: null, fullText: "" };
    this._promptAbort = null;
    this._prompting = false;
    // Pending agent→client permission requests, keyed by the request id sent
    // to the UI. Each entry holds the resolver the route calls on reply.
    this._pendingPermissions = new Map();
    // The OpenChamber session id of the running turn, so a permission request
    // raised mid-turn is tagged to the session the user is looking at.
    this._activeTag = null;
    // Agent-reported session configuration (models, thinking, ...). The composer
    // model picker reads this and switches the model via setConfigOption.
    this._configOptions = [];
    this._modelConfigId = null;
    // Footer labels: agent name (from config) and model (captured from the
    // session/initialize response if the agent reports one).
    this._agentLabel = typeof options.agentName === 'string' && options.agentName.length > 0 ? options.agentName : 'ACP';
    this._modelLabel = null;
  }

  /**
   * Report the session's activity status to the OpenChamber session-status
   * runtime, which is what the UI's status snapshot reads. Without this an
   * ACP turn looks idle while it runs, and the UI shows a false "did not
   * start a reply" notice.
   */
  _setStatus(sessionID, status) {
    try {
      this.options.updateStatus?.(sessionID, status);
    } catch {
      // Status is best-effort; never break the turn for it.
    }
  }

  /**
   * True while a prompt turn is running. The ACP connection runs one session
   * and one turn at a time, so callers use this to reject a second prompt
   * instead of starting a concurrent turn on the same connection.
   */
  isPrompting() {
    return this._prompting;
  }

  /** Session configuration options the agent reported (models, thinking, ...). */
  listConfigOptions() {
    return this._configOptions ?? [];
  }

  /** The config option id that carries the model, or null when the agent reports none. */
  modelConfigId() {
    return this._modelConfigId;
  }

  /**
   * Set a session configuration option (the model, thinking level, ...) and
   * return the agent's updated option set. `value` is the option `value` id
   * from listConfigOptions(). Keeps the footer model label in sync with a
   * model switch so later replies name the model actually in use.
   */
  async setConfigOption(configId, value) {
    if (!this._ctx || !this._session) {
      throw new Error('ACP event source has no active session');
    }
    if (typeof configId !== 'string' || configId.length === 0) {
      throw new Error('setConfigOption requires a configId');
    }
    const response = await this._ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.sessionID,
      configId,
      value,
    });
    this._configOptions = Array.isArray(response?.configOptions)
      ? response.configOptions
      : this._configOptions;
    if (configId === this._modelConfigId) {
      this._modelLabel = extractModelLabel({ configOptions: this._configOptions });
    }
    return this._configOptions;
  }

  /**
   * Handle an agent `session/request_permission` request: publish it as a
   * `permission.asked` wire event so the existing permission card renders, then
   * resolve once the user replies through the ACP permission route. A request
   * the client cannot present is answered `cancelled`, never an SDK error.
   */
  async _handlePermissionRequest(params) {
    try {
      const tag = this._activeTag ?? this.sessionID ?? 'acp-session';
      const requestID = `acp-perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const request = acpPermissionToRequest(params, { sessionID: tag, requestID });
      const reply = await new Promise((resolve) => {
        this._pendingPermissions.set(requestID, resolve);
        this._publish(acpPermissionAskedToEvent(request));
      });
      this._pendingPermissions.delete(requestID);
      // Reconcile the card whether the user answered or the turn cancelled it.
      this._publish(acpPermissionRepliedToEvent(tag, requestID));
      return acpPermissionReplyToResponse(params?.options, reply);
    } catch (error) {
      console.warn(`[acp] permission request failed: ${error?.message ?? error}`);
      return { outcome: { outcome: 'cancelled' } };
    }
  }

  /**
   * Resolve a pending permission request with a UI reply (`once`, `always`,
   * `reject`). Returns false when the id is unknown: already answered,
   * cancelled, or never issued by this session.
   */
  resolvePermission(requestID, reply) {
    const resolve = this._pendingPermissions.get(requestID);
    if (typeof resolve !== 'function') return false;
    this._pendingPermissions.delete(requestID);
    resolve(reply);
    return true;
  }

  /** Cancel every pending permission request so the agent is never left waiting. */
  _cancelPendingPermissions() {
    if (this._pendingPermissions.size === 0) return;
    const pending = [...this._pendingPermissions.values()];
    this._pendingPermissions.clear();
    for (const resolve of pending) resolve('cancelled');
  }

  /** Spawn + handshake + build a session. Resolves when the session is ready. */
  async start() {
    const { agentId, command, args, env, cwd, clientName } = this.options;

    this._connection = new AcpAgentConnection({
      agentId,
      command,
      args,
      env,
      cwd,
      clientName,
      onNotification: (params) => this._handleReplayNotification(params),
      onPermissionRequest: (params) => this._handlePermissionRequest(params),
      onReady: async (ctx) => {
        this._ctx = ctx;
        const builder = ctx.buildSession(cwd || process.cwd());
        await builder.withSession(async (session) => {
          this._session = session;
          this.sessionID = session.sessionId;
          // Try to capture a model label for the message footer from the session
          // modes/meta (agents report it in different places; best-effort).
          this._modelLabel = extractModelLabel(session);
          this._preambleFingerprint = extractPreambleFingerprint(session);
          this._configOptions = collectConfigOptions(session);
          this._modelConfigId = this._configOptions
            .find((option) => option?.category === 'model' || option?.id === 'model')?.id ?? null;
          console.log(`[acp] session new sessionId=${session.sessionId} model=${this._modelLabel ?? '(none)'} preamble=${this._preambleFingerprint ? 'yes' : 'no'} modes=${JSON.stringify(session.modes ?? null).slice(0, 200)}`);
          // Park for the connection's lifetime; prompts are driven via prompt().
          await new Promise((resolve) => { this._resolveSessionDone = resolve; });
        });
      },
    });

    await this._connection.start();
    // The onReady callback builds the session asynchronously; wait until the
    // session id is known (or fail explicitly).
    const session = await this._waitForSession();
    return session;
  }

  _waitForSession(timeoutMs = 30000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this._session) return resolve(this._session);
        if (Date.now() - start > timeoutMs) {
          return reject(new Error('ACP session was not established before timeout'));
        }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  /**
   * Run one prompt turn. Each streamed update is translated and published to
   * the hub. Resolves with the ACP stopReason on turn completion; publishes an
   * error session.status and rethrows on transport failure.
   *
   * @param {object} params
   * @param {string} params.text       The user prompt text.
   * @param {string} [params.sessionID] OpenChamber session id to tag published events.
   * @param {string} [params.userMessageId] The user message id to set as the assistant reply's parentID.
   */
  async prompt({ text, sessionID, userMessageId } = {}) {
    const tag = sessionID ?? this.sessionID ?? 'acp-session';
    if (!this._session) {
      throw new Error('ACP event source has no active session');
    }
    // Permission requests raised during this turn are tagged to this session.
    this._activeTag = tag;

    // Reset the per-turn accumulator so a new assistant message is started.
    this._acc = { messageID: null, fullText: '' };
    this._promptAbort = new AbortController();
    this._prompting = true;
    const ctx = () => ({
      sessionID: tag,
      agentName: this._agentLabel,
      modelLabel: this._modelLabel,
      preambleFingerprint: this._preambleFingerprint,
      location: this.options.directory,
    });

    // Turn start: the session goes busy. The user message is echoed as an
    // inbox event carrying the client's optimistic id, so the optimistic
    // record reconciles in place (same semantics as an OpenCode turn). The
    // transcript records it so history reads (`message.list` through the
    // safety net) include the live turn.
    this._setStatus(tag, 'busy');
    for (const event of acpTurnStartedToEvents(tag, this.options.directory)) {
      this._publish(event);
    }
    const turnUserId = userMessageId ?? `msg_${tag}-user${Date.now().toString(36)}`;
    recordUserMessage(tag, turnUserId, text);
    this._publish({
      id: `acp-wire-user-${Date.now().toString(36)}`,
      type: 'session.inbox.enqueued',
      data: {
        sessionID: tag,
        inboxID: turnUserId,
        item: { type: 'user', payload: { text } },
      },
      created: Date.now(),
      ...(this.options.directory ? { location: { directory: this.options.directory } } : {}),
    });

    try {
      this._session.prompt(text);
      for (;;) {
        if (this._promptAbort.signal.aborted) {
          for (const event of acpStopReasonToSessionStatus(tag, 'cancelled', this._acc, this.options.directory)) {
            this._publish(event);
          }
          this._setStatus(tag, 'idle');
          return 'cancelled';
        }
        const message = await this._session.nextUpdate();
        if (message?.kind === 'stop') {
          const stopReason = message.response?.stopReason ?? 'end_turn';
          console.log('[acp] stop stopReason=' + stopReason + ' session=' + tag + (isAcpDebug() ? ' raw=' + JSON.stringify(message.response) : ''));
          for (const event of acpStopReasonToSessionStatus(tag, stopReason, this._acc, this.options.directory)) {
            this._publish(event);
          }
          if (this._acc.messageID) {
            recordAssistantMessage(tag, {
              messageID: this._acc.messageID,
              agent: this._agentLabel,
              model: { providerID: 'acp', id: this._modelLabel || 'acp' },
              text: this._acc.fullText,
              content: assistantContentFromAcc(this._acc),
              finish: stopReason === 'cancelled' ? 'cancelled' : 'stop',
            });
          }
          this._setStatus(tag, 'idle');
          return stopReason;
        }
        const notification = message?.notification;
        if (notification) {
          const updateKind = notification?.update?.sessionUpdate;
          const events = acpUpdateToEvents(notification, ctx(), this._acc);
          const dirLabel = this.options.directory || '(none)';
          console.log('[acp] update sessionUpdate=' + updateKind + ' translated=' + events.length + ' session=' + tag + ' dir=' + dirLabel);
          if (isAcpDebug()) {
            console.log('[acp]   raw_notification=' + JSON.stringify(notification));
          }
          for (const event of events) {
            this._publish(event);
          }
        }
      }
    } catch (error) {
      if (this._promptAbort?.signal.aborted) {
        for (const event of acpStopReasonToSessionStatus(tag, 'cancelled', this._acc, this.options.directory)) {
          this._publish(event);
        }
        if (this._acc.messageID) {
          recordAssistantMessage(tag, {
            messageID: this._acc.messageID,
            agent: this._agentLabel,
            model: { providerID: 'acp', id: this._modelLabel || 'acp' },
            text: this._acc.fullText,
            content: assistantContentFromAcc(this._acc),
            finish: 'cancelled',
          });
        }
        this._setStatus(tag, 'idle');
        return 'cancelled';
      }
      console.warn(`[acp] transport error during prompt (session=${tag}): ${error?.message ?? error}`);
      for (const event of acpErrorToSessionStatus(tag, error?.message ?? String(error), this._acc, this.options.directory)) {
        this._publish(event);
      }
      this._setStatus(tag, 'idle');
      throw error;
    } finally {
      // A turn that ends with a permission still open must cancel it, so the
      // card disappears and the agent's request is answered instead of hanging.
      this._cancelPendingPermissions();
      this._activeTag = null;
      this._promptAbort = null;
      this._prompting = false;
    }
  }

  /** Best-effort cooperative cancel of the in-flight prompt turn. */
  cancel() {
    this._promptAbort?.abort();
  }

  /** List sessions known to the agent (session/list). Returns raw ACP sessions. */
  async listSessions(cwd) {
    if (!this._ctx) throw new Error('ACP connection not ready');
    const response = await this._ctx.request(acp.methods.agent.session.list, {
      cwd: cwd || this.options.cwd || process.cwd(),
    });
    return response?.sessions ?? [];
  }

  /** Delete a session (session/delete). */
  async deleteSession(sessionId) {
    if (!this._ctx) throw new Error('ACP connection not ready');
    await this._ctx.request(acp.methods.agent.session.delete, { sessionId });
  }

  /**
   * Load (resume) an existing session. Uses ctx.request(session/load) with a
   * timeout so it can never hang the server. The replayed history arrives as
   * session/update notifications on the connection; for now we rely on a
   * follow-up approach to capture them (the onNotification approach was removed
   * because it risked intercepting notifications the ActiveSession needs for
   * the prompt flow).
   */
  async loadSession(sessionId, { userMessageId, directory } = {}) {
    if (!this._ctx) throw new Error('ACP connection not ready');
    if (this._prompting) {
      // The ACP connection runs ONE session at a time. A session/load arriving
      // mid-turn (the UI's message loader replaying another sidebar session)
      // swaps the agent's live session and strands the running prompt, so it
      // is refused until the turn ends. History for non-active sessions is
      // simply unavailable during a turn.
      console.log('[acp] session/load deferred while a prompt is running: ' + sessionId);
      return [];
    }
    if (sessionId === this.sessionID) {
      // Loading the session this connection is already running would make the
      // agent swap its live session out from under the current turn. Callers
      // (the message-history route) serve the transcript for the active
      // session instead.
      return [];
    }
    console.log('[acp] session/load sessionId=' + sessionId + ' dir=' + (directory || '(none)'));
    this._loadingSessionId = sessionId;
    this._acc = { messageID: null, fullText: "" };
    this._loadDirectory = directory ?? this.options.directory;
    this._replayEvents = [];
    resetReplayCounters(sessionId);
    try {
      await Promise.race([
        this._ctx.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: this.options.cwd || process.cwd(),
          mcpServers: [],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('session/load timed out')), 15000)),
      ]);
    } catch (error) {
      console.warn('[acp] session/load failed: ' + (error?.message ?? error));
    } finally {
      console.log('[acp] session/load done; replayed notifications: ' + (this._replayCount ?? 0) + '; events: ' + this._replayEvents.length);
      this._replayCount = 0;
      this._replayEvents.push(...acpStopReasonToSessionStatus(sessionId, 'end_turn', this._acc, this.options.directory));
      this._loadingSessionId = null;
    }
    return this._replayEvents;
  }

  /**
   * Handle session/update notifications during session/load. Collects events
   * into _replayEvents (returned by loadSession as an HTTP response body)
   * instead of publishing through the hub. This prevents cross-tab duplication
   * — only the requesting tab receives the events.
   */
  _handleReplayNotification(params) {
    if (!this._loadingSessionId) return;
    this._replayCount = (this._replayCount ?? 0) + 1;
    if (isAcpDebug()) {
      console.log('[acp] replay notification kind=' + params?.update?.sessionUpdate + ' session=' + this._loadingSessionId);
      console.log('[acp]   raw_notification=' + JSON.stringify(params));
    }
    const events = acpUpdateToEvents(params, {
      sessionID: this._loadingSessionId,
      replaySessionId: this._loadingSessionId,
      agentName: this._agentLabel,
      modelLabel: this._modelLabel,
      preambleFingerprint: this._preambleFingerprint,
    }, this._acc);
    for (const event of events) {
      this._replayEvents.push(event);
    }
  }

  _publish(event, directoryOverride) {
    try {
      const dir = directoryOverride ?? this.options.directory;
      this.options.hub?.publishEvent?.(event, { directory: dir });
    } catch {
      // Publishing must never break the prompt loop; best-effort fan-out.
    }
  }

  /** Stop the underlying connection and end the session park. */
  async stop() {
    // Unblock any agent waiting on a permission reply before the transport dies.
    this._cancelPendingPermissions();
    if (this._resolveSessionDone) this._resolveSessionDone();
    if (this._connection) await this._connection.stop();
    this._session = null;
    this._ctx = null;
    this._connection = null;
    this._configOptions = [];
    this._modelConfigId = null;
  }
}
