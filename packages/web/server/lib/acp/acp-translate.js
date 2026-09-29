// Pure translation of ACP session/update notifications into OpenCode 2.x wire
// events. The ACP event source publishes these through the global hub, and the
// browser translates them with the same `translateWireEvent` it uses for
// upstream OpenCode events (packages/ui/src/lib/opencode/events.ts) — so the
// existing sync layer, reducers, and renderers are reused as-is.
//
// Wire contract (see the pipeline's wireEventSchema): every payload carries
// `{ id, type, data, created, location? }`. `id` is required by the client's
// schema check; `created` stamps the record times.
//
// These functions are pure and side-effect-free so they can be unit-tested
// without a subprocess. The orchestrator (acp-event-source.js) feeds ACP
// notifications in and publishes the resulting payloads via the global hub.
//
// Message identity mirrors OpenCode 2.x: the user message id comes from the
// client (`msg_…`), the assistant message id is synthesized here, and part ids
// follow the client's `partIds` scheme (`${messageID}:text:${ordinal}`), so a
// repeated replay or a reconnect dedupes naturally in the stores.

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Synthesize ids using the SAME scheme as the UI's ascendingId
// (packages/ui/src/lib/opencode/ids.ts): timestamp*0x1000 + counter, top
// 6 bytes as hex. This guarantees monotonically increasing ids that sort in
// chronological order, so the assistant message sorts AFTER the user message.
let idCounter = 0;
let lastIdTimestamp = 0;
const hexId = (prefix) => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const sortable = BigInt(timestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = new Uint8Array(6);
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  const hex = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}${Math.random().toString(36).slice(2, 8)}`;
};

// Deterministic ID generator for replays. Produces the same IDs every time
// for the same session, so the UI reducer deduplicates across tabs.
const replayCounters = new Map();
const deterministicId = (replaySessionId, role) => {
  const key = replaySessionId + ':' + role;
  const next = (replayCounters.get(key) ?? 0) + 1;
  replayCounters.set(key, next);
  return `${replaySessionId}-${role}${next}`;
};
export const resetReplayCounters = (replaySessionId) => {
  if (!replaySessionId) return;
  for (const key of replayCounters.keys()) {
    if (key.startsWith(replaySessionId + ':')) replayCounters.delete(key);
  }
};

/**
 * @typedef {Object} TranslateContext
 * @property {string} sessionID      The OpenChamber session id for this ACP session.
 * @property {string} [agentName]    Display name for the assistant footer.
 * @property {string} [modelLabel]   Model label for the assistant footer.
 * @property {string} [preambleFingerprint] Drop a duplicated agent preamble
 *   that some agents emit as the first chunk AND report in session meta.
 */

let wireSequence = 0;
const wireEvent = (type, data, location, acc) => ({
  id: `acp-wire-${String(++wireSequence).padStart(6, '0')}`,
  type,
  data,
  created: Date.now(),
  ...(location ? { location: { directory: location } } : {}),
});

const assistantModel = (ctx) => ({
  providerID: 'acp',
  id: ctx.modelLabel || 'acp',
});

export const _resetTranslateCounter = () => {
  idCounter = 0;
  wireSequence = 0;
};

/** Ensure the turn's assistant message exists (step.started). */
const ensureAssistantMessage = (ctx, acc, out) => {
  if (acc.messageID) return;
  acc.messageID = acc.replaySessionId
    ? deterministicId(acc.replaySessionId, 'assistant')
    : hexId('msg');
  out.push(wireEvent('session.step.started', {
    sessionID: ctx.sessionID,
    assistantMessageID: acc.messageID,
    agent: ctx.agentName || 'ACP',
    model: assistantModel(ctx),
  }, ctx.location, acc));
  acc.fullText = '';
};

/** Open the turn's text part once, on the first text chunk (a turn may be tool-only). */
const ensureTextPart = (ctx, acc, out) => {
  if (acc.textPartStarted) return;
  acc.textPartStarted = true;
  acc.fullText = acc.fullText ?? '';
  acc.items = acc.items ?? [];
  acc.textItem = { type: 'text', text: '' };
  acc.items.push(acc.textItem);
  out.push(wireEvent('session.text.started', {
    sessionID: ctx.sessionID,
    assistantMessageID: acc.messageID,
    ordinal: 0,
  }, ctx.location, acc));
};

/**
 * Build the assistant message's ordered content for the transcript, so history
 * reads show the text and the tool calls exactly as the live turn streamed.
 * Shape matches OpenCode's wire assistant content (`projectAssistantContent`).
 */
export const assistantContentFromAcc = (acc) => {
  if (!acc) return [];
  const items = [];
  if (acc.textItem && typeof acc.textItem.text === 'string' && acc.textItem.text.length > 0) {
    items.push({ type: 'text', text: acc.textItem.text });
  }
  for (const tool of acc.toolCalls?.values?.() ?? []) {
    items.push({
      type: 'tool',
      id: tool.id,
      name: tool.name,
      executed: true,
      state: {
        status: tool.status === 'error' ? 'error' : tool.status === 'completed' ? 'completed' : 'running',
        input: tool.input ?? {},
        ...(tool.output ? { content: [{ type: 'text', text: tool.output }] } : {}),
        ...(tool.metadata ? { metadata: tool.metadata } : {}),
        ...(tool.error ? { error: { type: 'acp_tool_error', message: tool.error } } : {}),
      },
      time: { created: tool.created, ...(tool.ran ? { ran: tool.ran } : {}), ...(tool.completed ? { completed: tool.completed } : {}) },
    });
  }
  return items;
};

/** Some agents (pi-acp) emit a verbose preamble; drop the duplicated copy. */
const isPreamble = (ctx, text) =>
  Boolean(ctx.preambleFingerprint) && typeof text === 'string' && text.trim().startsWith(ctx.preambleFingerprint.trim());

/**
 * Translate one ACP `session/update` params object into zero or more 2.x wire
 * payloads. `acc` carries per-turn state (assistant message id, text).
 */
export const acpUpdateToEvents = (params, ctx = {}, acc = { messageID: null, fullText: '' }) => {
  const update = params?.update;
  if (!isRecord(update)) return [];
  const kind = update.sessionUpdate;
  const out = [];
  const sessionID = ctx.sessionID;

  if (kind === 'user_message_chunk') {
    const text = wireText(update.content);
    if (!text) return [];
    out.push(wireEvent('session.inbox.enqueued', {
      sessionID,
      inboxID: acc.replaySessionId
        ? deterministicId(acc.replaySessionId, 'user')
        : hexId('msg'),
      item: { type: 'user', payload: { text } },
    }, ctx.location, acc));
    return out;
  }

  if (kind === 'agent_message_chunk') {
    const text = wireText(update.content);
    if (!text || isPreamble(ctx, text)) return [];
    ensureAssistantMessage(ctx, acc, out);
    ensureTextPart(ctx, acc, out);
    acc.fullText += text;
    if (acc.textItem) acc.textItem.text = acc.fullText;
    out.push(wireEvent('session.text.delta', {
      sessionID,
      assistantMessageID: acc.messageID,
      ordinal: 0,
      delta: text,
    }, ctx.location, acc));
    return out;
  }

  if (kind === 'tool_call') {
    const toolCallId = update.toolCallId || hexId('tool');
    acc.toolIds = acc.toolIds || new Set();
    acc.toolIds.add(toolCallId);
    ensureAssistantMessage(ctx, acc, out);
    out.push(wireEvent('session.tool.input.started', {
      sessionID,
      assistantMessageID: acc.messageID,
      id: toolCallId,
      name: update.title || update.kind || 'tool',
    }, ctx.location, acc));
    out.push(wireEvent('session.tool.called', {
      sessionID,
      assistantMessageID: acc.messageID,
      id: toolCallId,
      input: toolInput(update),
      executed: true,
    }, ctx.location, acc));
    acc.toolCalls = acc.toolCalls || new Map();
    const toolEntry = {
      id: toolCallId,
      name: update.title || update.kind || 'tool',
      input: toolInput(update),
      status: 'running',
      output: toolContentText(update),
      metadata: isRecord(update._meta) ? update._meta : undefined,
      created: Date.now(),
      ran: Date.now(),
    };
    acc.toolCalls.set(toolCallId, toolEntry);
    acc.items = acc.items ?? [];
    acc.items.push({ type: 'tool', ref: toolEntry });
    return out;
  }

  if (kind === 'tool_call_update') {
    const toolCallId = update.toolCallId;
    if (!toolCallId) return [];
    acc.toolCalls = acc.toolCalls || new Map();
    const existing = acc.toolCalls.get(toolCallId) ?? {
      id: toolCallId,
      name: update.title || toolCallId,
      input: toolInput(update),
      status: 'running',
      output: '',
      created: Date.now(),
      ran: Date.now(),
    };
    // pi streams command output through `_meta.terminal_output.data`; append it
    // so the completed tool carries the whole result.
    const streamed = toolContentText(update);
    if (streamed) existing.output = (existing.output ?? '') + streamed;
    if (isRecord(update.rawInput)) existing.input = update.rawInput;
    if (update.title && !existing.name) existing.name = update.title;

    const status = String(update.status ?? '').toLowerCase();
    if (status === 'failed') {
      if (existing.status !== 'error') {
        existing.status = 'error';
        existing.completed = Date.now();
        existing.error = toolFailureMessage(update);
        acc.toolCalls.set(toolCallId, existing);
        out.push(wireEvent('session.tool.failed', {
          sessionID,
          assistantMessageID: acc.messageID ?? '',
          id: toolCallId,
          error: { type: 'acp_tool_error', message: existing.error },
          content: existing.output ? [{ type: 'text', text: existing.output }] : undefined,
          metadata: existing.metadata,
          executed: true,
        }, ctx.location, acc));
      }
      return out;
    }
    if (status === 'completed') {
      if (existing.status !== 'completed') {
        existing.status = 'completed';
        existing.completed = Date.now();
        acc.toolCalls.set(toolCallId, existing);
        out.push(wireEvent('session.tool.success', {
          sessionID,
          assistantMessageID: acc.messageID ?? '',
          id: toolCallId,
          content: existing.output ? [{ type: 'text', text: existing.output }] : undefined,
          metadata: existing.metadata,
          executed: true,
        }, ctx.location, acc));
      }
      return out;
    }
    // pending / in_progress: keep the running entry; a progress frame keeps the
    // card alive without pretending the call finished.
    existing.status = 'running';
    acc.toolCalls.set(toolCallId, existing);
    out.push(wireEvent('session.tool.progress', {
      sessionID,
      assistantMessageID: acc.messageID ?? '',
      id: toolCallId,
      metadata: existing.metadata,
    }, ctx.location, acc));
    return out;
  }

  // plan / usage_update / available_commands_update are Should-milestone work.
  return out;
};

/** Extract readable text from an ACP content block (or block array). */
const wireText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(wireText).join('');
  if (!isRecord(content)) return '';
  if (typeof content.text === 'string') return content.text;
  if (isRecord(content.content)) return wireText(content.content);
  return '';
};

/**
 * Text a tool update carries: its content blocks plus pi's streamed command
 * output (`_meta.terminal_output.data`) and terminal exit detail.
 */
const toolContentText = (update) => {
  const parts = [];
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      const text = wireText(block);
      if (text) parts.push(text);
    }
  }
  const terminal = update._meta?.terminal_output?.data;
  if (typeof terminal === 'string') parts.push(terminal);
  return parts.join('');
};

/** Tool input: ACP sends `rawInput`; execute tools name the command in `title`. */
const toolInput = (update) => {
  if (isRecord(update.rawInput)) return update.rawInput;
  if (isRecord(update.input)) return update.input;
  if (update.kind === 'execute' && typeof update.title === 'string') return { command: update.title };
  return {};
};

/** Failure detail: the update's error, else its terminal exit code. */
const toolFailureMessage = (update) => {
  if (isRecord(update.error)) return wireText(update.error) || update.error.message || 'tool failed';
  if (typeof update.error === 'string' && update.error) return update.error;
  const exit = update._meta?.terminal_exit;
  if (isRecord(exit) && (exit.exit_code ?? 0) !== 0) return `command exited with code ${exit.exit_code}`;
  return 'tool failed';
};

/**
 * Translate a stopReason into the closing wire events: the text part is
 * finalized, the assistant message is marked completed, and the session goes
 * idle with an outcome the UI understands.
 */
export const acpStopReasonToSessionStatus = (sessionID, stopReason, acc = {}, location) => {
  const out = [];
  const cancelled = stopReason === 'cancelled';
  if (acc.messageID) {
    if (acc.textPartStarted) {
      out.push(wireEvent('session.text.ended', {
        sessionID,
        assistantMessageID: acc.messageID,
        ordinal: 0,
        text: acc.fullText ?? '',
      }, location, acc));
    }
    out.push(wireEvent('session.step.ended', {
      sessionID,
      assistantMessageID: acc.messageID,
      finish: cancelled ? 'cancelled' : 'stop',
    }, location, acc));
  }
  out.push(wireEvent(
    cancelled ? 'session.execution.interrupted' : 'session.execution.succeeded',
    { sessionID },
    location,
    acc,
  ));
  return out;
};

/** Build the explicit failure wire events (never an empty success — NFR-4). */
export const acpErrorToSessionStatus = (sessionID, message, acc = {}, location) => {
  const error = { type: 'acp_transport_error', message: message || 'ACP transport error' };
  const out = [];
  if (acc.messageID) {
    out.push(wireEvent('session.step.failed', {
      sessionID,
      assistantMessageID: acc.messageID,
      finish: 'error',
      error,
    }, location, acc));
  }
  out.push(wireEvent('session.execution.failed', { sessionID, error }, location, acc));
  return out;
};

/** Turn-start wire events: the session goes busy before the prompt is sent. */
export const acpTurnStartedToEvents = (sessionID, location) => [
  wireEvent('session.execution.started', { sessionID }, location, {}),
];

// ---------------------------------------------------------------------------
// Permission requests (FR-7)
//
// An agent asks the client to approve a tool call via
// `session/request_permission`. The client answers with the option the user
// chose. OpenChamber reuses the existing OpenCode permission card, so the ACP
// request is mapped onto the OpenCode 2.x `PermissionRequest` shape and the
// user's reply is mapped back onto the agent's option kinds.
// ---------------------------------------------------------------------------

// ACP ToolKind → the OpenCode permission `action` the existing card renders.
const ACP_TOOL_KIND_ACTION = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'shell',
  think: 'think',
  fetch: 'webfetch',
  switch_mode: 'switch_mode',
};

const asString = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined);

/** Resource targets the permission card lists for an ACP tool call (best-effort). */
const acpPermissionResources = (toolCall) => {
  const resources = [];
  const locations = Array.isArray(toolCall?.locations) ? toolCall.locations : [];
  for (const location of locations) {
    const path = asString(location?.path);
    if (path) resources.push(path);
  }
  const raw = isRecord(toolCall?.rawInput) ? toolCall.rawInput : null;
  const command = asString(raw?.command);
  if (command) resources.push(command);
  for (const key of ['path', 'file', 'filePath', 'target']) {
    const value = asString(raw?.[key]);
    if (value) resources.push(value);
  }
  for (const key of ['paths', 'files']) {
    const list = Array.isArray(raw?.[key]) ? raw[key] : [];
    for (const entry of list) {
      const value = asString(entry);
      if (value) resources.push(value);
    }
  }
  return [...new Set(resources)];
};

/**
 * Map an ACP `session/request_permission` request onto the OpenCode 2.x
 * `PermissionRequest` shape the permission card and reducer already consume.
 */
export const acpPermissionToRequest = (params, { sessionID, requestID }) => {
  const toolCall = params?.toolCall ?? {};
  const request = {
    id: requestID,
    sessionID,
    action: ACP_TOOL_KIND_ACTION[asString(toolCall.kind)] ?? 'other',
    resources: acpPermissionResources(toolCall),
  };
  const command = asString(isRecord(toolCall.rawInput) ? toolCall.rawInput.command : undefined);
  if (command) request.metadata = { command };
  const title = asString(toolCall.title);
  if (title) request.message = title;
  return request;
};

/** `permission.asked` wire event (`data` is the mapped PermissionRequest). */
export const acpPermissionAskedToEvent = (request, location) =>
  wireEvent('permission.asked', request, location, {});

/** `permission.replied` wire event, matched to the request by id. */
export const acpPermissionRepliedToEvent = (sessionID, requestID, location) =>
  wireEvent('permission.replied', { sessionID, requestID }, location, {});

// Preference order per UI reply; the first kind the agent offered wins.
const REPLY_OPTION_PREFERENCE = {
  once: ['allow_once', 'allow_always'],
  always: ['allow_always', 'allow_once'],
  reject: ['reject_once', 'reject_always'],
};

/**
 * Pick the agent option id for a UI reply. Returns null when the agent offered
 * no compatible option, which callers translate to `cancelled`.
 */
const acpPermissionReplyToOptionId = (options, reply) => {
  const list = Array.isArray(options) ? options : [];
  for (const kind of REPLY_OPTION_PREFERENCE[reply] ?? []) {
    const match = list.find((option) => option?.kind === kind && asString(option.optionId));
    if (match) return match.optionId;
  }
  return null;
};

/** Build the ACP `RequestPermissionResponse` for a UI reply (or a cancel). */
export const acpPermissionReplyToResponse = (options, reply) => {
  const optionId = reply === 'cancelled' ? null : acpPermissionReplyToOptionId(options, reply);
  return optionId
    ? { outcome: { outcome: 'selected', optionId } }
    : { outcome: { outcome: 'cancelled' } };
};
