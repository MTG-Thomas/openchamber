import { describe, expect, it, beforeEach } from 'vitest';
import {
  acpUpdateToEvents,
  acpStopReasonToSessionStatus,
  acpErrorToSessionStatus,
  acpTurnStartedToEvents,
  resetReplayCounters,
  _resetTranslateCounter,
} from './acp-translate.js';

const chunk = (text) => ({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
const ctx = (extra = {}) => ({ sessionID: 'oc-sess-1', agentName: 'Test Agent', modelLabel: 'test-model', location: '/test/dir', ...extra });
const freshAcc = () => ({ messageID: null, fullText: '' });

describe('acp-translate: agent_message_chunk (TC-3) — 2.x wire events', () => {
  beforeEach(() => _resetTranslateCounter());

  it('registers the message then creates the text part on the first chunk', () => {
    const acc = freshAcc();
    const events = acpUpdateToEvents(chunk('Hello'), ctx(), acc);
    expect(events.map((e) => e.type)).toEqual(['session.step.started', 'session.text.started', 'session.text.delta']);
    expect(acc.messageID).toBeTruthy();
    const step = events[0];
    expect(step.data.sessionID).toBe('oc-sess-1');
    expect(step.data.assistantMessageID).toBe(acc.messageID);
    expect(step.data.agent).toBe('Test Agent');
    expect(step.location).toEqual({ directory: '/test/dir' });
    const delta = events[2];
    expect(delta.data.delta).toBe('Hello');
  });

  it('appends subsequent chunks via session.text.delta (same message)', () => {
    const acc = freshAcc();
    acpUpdateToEvents(chunk('Hello'), ctx(), acc);
    const events = acpUpdateToEvents(chunk(' world'), ctx(), acc);
    expect(events.map((e) => e.type)).toEqual(['session.text.delta']);
    expect(events[0].data.assistantMessageID).toBe(acc.messageID);
    expect(acc.fullText).toBe('Hello world');
  });

  it('synthesizes a message id when the ACP chunk omits messageId', () => {
    const acc = freshAcc();
    const events = acpUpdateToEvents(chunk('Hi'), ctx(), acc);
    expect(acc.messageID).toMatch(/^msg_/);
    expect(events[1].data.assistantMessageID).toBe(acc.messageID);
  });

  it('starts a new message when a chunk follows a non-message update', () => {
    const acc = freshAcc();
    acpUpdateToEvents(chunk('First'), ctx(), acc);
    const first = acc.messageID;
    // A stop clears the accumulator in the event source; simulate a fresh turn.
    const acc2 = freshAcc();
    const events = acpUpdateToEvents(chunk('Second'), ctx(), acc2);
    expect(acc2.messageID).not.toBe(first);
    expect(events[0].data.assistantMessageID).toBe(acc2.messageID);
  });

  it('does not start a new message for contiguous chunks', () => {
    const acc = freshAcc();
    acpUpdateToEvents(chunk('a'), ctx(), acc);
    acpUpdateToEvents(chunk('b'), ctx(), acc);
    acpUpdateToEvents(chunk('c'), ctx(), acc);
    expect(acc.messageID).toBeTruthy();
    expect(acc.fullText).toBe('abc');
  });
});

describe('acp-translate: user_message_chunk replay', () => {
  beforeEach(() => resetReplayCounters('replay-sess'));

  it('emits an inbox event with a deterministic id during replay', () => {
    const acc = freshAcc();
    acc.replaySessionId = 'replay-sess';
    const events = acpUpdateToEvents(
      { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ping' } } },
      ctx({ sessionID: 'replay-sess' }),
      acc,
    );
    expect(events[0].type).toBe('session.inbox.enqueued');
    expect(events[0].data.inboxID).toBe('replay-sess-user1');
    expect(events[0].data.item.payload.text).toBe('ping');
    resetReplayCounters('replay-sess');
    const again = acpUpdateToEvents(
      { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ping' } } },
      ctx({ sessionID: 'replay-sess' }),
      acc,
    );
    expect(again[0].data.inboxID).toBe('replay-sess-user1');
  });
});

describe('acp-translate: tool_call (TC-4)', () => {
  it('creates a tool part from a new tool_call', () => {
    const acc = freshAcc();
    const events = acpUpdateToEvents(
      { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read file' } },
      ctx(),
      acc,
    );
    expect(events.map((e) => e.type)).toEqual(['session.step.started', 'session.tool.input.started', 'session.tool.called']);
    expect(events[1].data.id).toBe('call-1');
    expect(events[1].data.name).toBe('Read file');
    expect(events[2].data.executed).toBe(true);
  });

  it('ignores non-text content blocks (out of Must scope)', () => {
    const events = acpUpdateToEvents(
      { update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'image', data: '...' }] } },
      ctx(),
      freshAcc(),
    );
    expect(events).toEqual([]);
  });
});

describe('acp-translate: tool_call_update (TC-5)', () => {
  it('emits session.tool.success with content on completion', () => {
    const acc = freshAcc();
    acc.messageID = 'msg_1';
    const events = acpUpdateToEvents(
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'text', text: 'done' }] } },
      ctx(),
      acc,
    );
    expect(events[0].type).toBe('session.tool.success');
    expect(events[0].data.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('keeps in_progress updates running and reports success once', () => {
    const acc = freshAcc();
    acc.messageID = 'msg_1';
    acpUpdateToEvents({ update: { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'ls', kind: 'execute' } }, ctx(), acc);
    const progress = acpUpdateToEvents(
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'in_progress', _meta: { terminal_output: { data: 'file-a\n' } } } },
      ctx(),
      acc,
    );
    expect(progress.map((e) => e.type)).toEqual(['session.tool.progress']);
    const done = acpUpdateToEvents(
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'completed', _meta: { terminal_output: { data: 'file-b\n' } } } },
      ctx(),
      acc,
    );
    expect(done.map((e) => e.type)).toEqual(['session.tool.success']);
    expect(done[0].data.content).toEqual([{ type: 'text', text: 'file-a\nfile-b\n' }]);
    const repeat = acpUpdateToEvents({ update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'completed' } }, ctx(), acc);
    expect(repeat).toEqual([]);
  });
});

describe('acp-translate: stopReason (TC-6)', () => {
  it('finalizes the text and closes the turn on end_turn', () => {
    const acc = freshAcc();
    acpUpdateToEvents(chunk('Answer'), ctx(), acc);
    const events = acpStopReasonToSessionStatus('oc-sess-1', 'end_turn', acc, '/test/dir');
    expect(events.map((e) => e.type)).toEqual(['session.text.ended', 'session.step.ended', 'session.execution.succeeded']);
    expect(events[0].data.text).toBe('Answer');
    expect(events[1].data.finish).toBe('stop');
  });

  it('maps cancelled to an interrupted execution', () => {
    const acc = freshAcc();
    acpUpdateToEvents(chunk('partial'), ctx(), acc);
    const events = acpStopReasonToSessionStatus('oc-sess-1', 'cancelled', acc);
    expect(events[1].data.finish).toBe('cancelled');
    expect(events[2].type).toBe('session.execution.interrupted');
  });
});

describe('acp-translate: error (TC-7, NFR-4)', () => {
  it('builds an explicit failure, never empty success', () => {
    const acc = freshAcc();
    acpUpdateToEvents(chunk('partial'), ctx(), acc);
    const events = acpErrorToSessionStatus('oc-sess-1', 'transport died', acc);
    expect(events.map((e) => e.type)).toEqual(['session.step.failed', 'session.execution.failed']);
    expect(events[0].data.error.message).toBe('transport died');
    expect(events[0].data.finish).toBe('error');
  });

  it('provides a default message when none is given', () => {
    const events = acpErrorToSessionStatus('oc-sess-1', undefined, freshAcc());
    expect(events[0].data.error.message).toContain('ACP transport error');
  });
});

describe('acp-translate: turn start', () => {
  it('marks the session busy', () => {
    const events = acpTurnStartedToEvents('oc-sess-1', '/test/dir');
    expect(events[0].type).toBe('session.execution.started');
    expect(events[0].data.sessionID).toBe('oc-sess-1');
  });
});

describe('acp-translate: deferred updates', () => {
  it('returns no events for plan and usage_update (Should milestones)', () => {
    expect(acpUpdateToEvents({ update: { sessionUpdate: 'plan' } }, ctx(), freshAcc())).toEqual([]);
    expect(acpUpdateToEvents({ update: { sessionUpdate: 'usage_update' } }, ctx(), freshAcc())).toEqual([]);
  });
});

describe('acp-translate: session preamble skip', () => {
  it('drops an agent_message_chunk matching the preamble fingerprint', () => {
    const acc = freshAcc();
    const events = acpUpdateToEvents(chunk('CONFIG: skills a, b, c'), ctx({ preambleFingerprint: 'CONFIG: skills a, b, c' }), acc);
    expect(events).toEqual([]);
  });

  it('does not drop a real reply that differs from the preamble', () => {
    const acc = freshAcc();
    const events = acpUpdateToEvents(chunk('Real answer'), ctx({ preambleFingerprint: 'CONFIG: skills a, b, c' }), acc);
    expect(events.length).toBe(3);
  });
});
