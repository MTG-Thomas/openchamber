import { describe, expect, it, beforeEach } from 'vitest';
import { recordUserMessage, recordAssistantMessage, getTranscript, clearTranscripts } from './session-transcript.js';

describe('session transcript', () => {
  beforeEach(() => clearTranscripts());

  it('records the user turn and the assistant reply in order', () => {
    recordUserMessage('s1', 'msg_u1', 'hello world', 1000);
    recordAssistantMessage('s1', { messageID: 'msg_a1', agent: 'Pi agent', model: { providerID: 'acp', id: 'pi' }, text: 'Hello world!', created: 2000 });

    const messages = getTranscript('s1');
    expect(messages.map((m) => m.id)).toEqual(['msg_u1', 'msg_a1']);
    expect(messages[0]).toMatchObject({ type: 'user', text: 'hello world' });
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      agent: 'Pi agent',
      finish: 'stop',
      time: { created: 2000, completed: 2000 },
    });
    expect(messages[1].content[0].text).toBe('Hello world!');
  });

  it('updates the assistant record on a repeat (stop after partial)', () => {
    recordAssistantMessage('s1', { messageID: 'msg_a1', text: 'partial', created: 1000 });
    recordAssistantMessage('s1', { messageID: 'msg_a1', text: 'partial + final', created: 2000, finish: 'cancelled' });

    const messages = getTranscript('s1');
    expect(messages).toHaveLength(1);
    expect(messages[0].content[0].text).toBe('partial + final');
    expect(messages[0].finish).toBe('cancelled');
    expect(messages[0].time.created).toBe(1000);
  });

  it('ignores records without a session or id', () => {
    recordUserMessage('', 'msg_x', 'hi');
    recordUserMessage('s1', '', 'hi');
    expect(getTranscript('s1')).toEqual([]);
  });

  it('serves live turns even after teardown (empty source)', () => {
    recordUserMessage('s2', 'msg_u', 'hi', 1000);
    // No active source involved: getTranscript is what the route serves.
    expect(getTranscript('s2')).toHaveLength(1);
  });
});
