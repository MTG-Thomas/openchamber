// In-memory per-session transcript of ACP turns.
//
// The ACP history path (session/load replays) only reflects what the agent
// persisted — a brand-new session replays nothing, and a live turn is not
// visible to `session/load` at all. Without a record of live turns, the UI's
// message refetch after a send reads an empty page and wipes the messages the
// event stream just delivered (the "did not start a reply" false negative).
//
// This module records each turn's user message and assistant reply as 2.x
// SessionMessageInfo wire records, so `getAcpSessionMessages` can merge them
// with replayed history. Records keep insertion order per message and the map
// is bounded per session to keep long-running servers honest.

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const MAX_SESSIONS = 50;
const transcripts = new Map(); // sessionId -> Map(messageID -> record)

const transcriptFor = (sessionId) => {
  if (!transcripts.has(sessionId)) {
    if (transcripts.size >= MAX_SESSIONS) {
      // Drop the oldest session's transcript (insertion order).
      const oldest = transcripts.keys().next().value;
      transcripts.delete(oldest);
    }
    transcripts.set(sessionId, new Map());
  }
  return transcripts.get(sessionId);
};

/** Merge a record into the transcript by id, preserving first-seen order. */
export const recordMessage = (sessionId, record) => {
  if (!sessionId || !isRecord(record) || !record.id) return;
  transcriptFor(sessionId).set(record.id, record);
};

/** Record the user turn from an inbox echo (or a synthesized id). */
export const recordUserMessage = (sessionId, messageID, text, created = Date.now()) => {
  if (!messageID) return;
  recordMessage(sessionId, {
    type: 'user',
    id: messageID,
    text: typeof text === 'string' ? text : '',
    time: { created },
  });
};

/** Record (or update) the assistant reply for the current turn. */
export const recordAssistantMessage = (sessionId, { messageID, agent, model, text, finish = 'stop', created = Date.now(), content }) => {
  if (!messageID) return;
  const transcript = transcriptFor(sessionId);
  const existing = transcript.get(messageID);
  const items = Array.isArray(content)
    ? content
    : [{ type: 'text', text: typeof text === 'string' ? text : '' }];
  transcript.set(messageID, {
    ...(isRecord(existing) ? existing : {}),
    type: 'assistant',
    id: messageID,
    agent: agent ?? existing?.agent ?? 'ACP',
    model: model ?? existing?.model ?? { providerID: 'acp', id: 'acp' },
    content: items,
    finish,
    time: {
      created: existing?.time?.created ?? created,
      completed: created,
    },
  });
};

/** All recorded messages for a session, oldest first. */
export const getTranscript = (sessionId) => {
  const transcript = transcripts.get(sessionId);
  if (!transcript) return [];
  return Array.from(transcript.values()).sort((a, b) => {
    const ta = a?.time?.created ?? 0;
    const tb = b?.time?.created ?? 0;
    return ta - tb;
  });
};

/** Test helper. */
export const clearTranscripts = () => transcripts.clear();
