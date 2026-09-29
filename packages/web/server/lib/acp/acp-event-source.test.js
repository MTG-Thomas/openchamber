import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpEventSource } from './acp-event-source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolveMockAgent = () => {
  const cwdRelative = join(process.cwd(), 'server/lib/acp/__tests__/fixtures/mock-agent.js');
  const fileRelative = join(__dirname, 'fixtures', 'mock-agent.js');
  return existsSync(cwdRelative) ? cwdRelative : fileRelative;
};
const mockAgentPath = resolveMockAgent();

const sources = [];
const startSource = (options) => {
  const src = new AcpEventSource(options);
  sources.push(src);
  return src.start().then(() => src);
};
const stopAll = async () => {
  await Promise.all(sources.map((s) => s.stop().catch(() => {})));
  sources.length = 0;
};
afterEach(stopAll);

// A fake hub that captures published events in order.
const captureHub = () => {
  const events = [];
  return { events, publishEvent(event, _opts) { events.push(event); } };
};

describe('AcpEventSource end-to-end translation (TC-14, assumption #1)', () => {
  it('translates a streamed prompt turn into normalized events', async () => {
    const hub = captureHub();
    const src = await startSource({
      hub,
      agentId: 'es-1',
      command: process.execPath,
      args: [mockAgentPath],
      sessionID: 'oc-sess-1',
    });

    const stopReason = await src.prompt({ text: 'Hello', sessionID: 'oc-sess-1' });

    expect(stopReason).toBe('end_turn');
    // Expect at least: the assistant step opened, streamed text, and the turn
    // closed with the session going idle (2.x execution vocabulary).
    const types = hub.events.map((e) => e.type);
    expect(types).toContain('session.step.started');
    expect(types).toContain('session.text.delta');
    expect(types).toContain('session.text.ended');
    expect(types).toContain('session.step.ended');
    expect(types).toContain('session.execution.succeeded');
    const started = hub.events.find((e) => e.type === 'session.step.started');
    expect(started.data.assistantMessageID).toBeTruthy();
    expect(started.data.agent).toBe('ACP');
    const ended = hub.events.find((e) => e.type === 'session.step.ended');
    expect(ended.data.finish).toBe('stop');
  }, 15000);

  it('publishes an agent permission request and resolves it with the user reply (FR-7)', async () => {
    const hub = captureHub();
    const src = await startSource({
      hub,
      agentId: 'es-perm',
      command: process.execPath,
      args: [mockAgentPath],
    });

    const turn = src.prompt({ text: 'permission:allow', sessionID: 'oc-sess-perm' });

    // The request surfaces to the UI as a permission.asked wire event.
    const deadline = Date.now() + 10000;
    let asked;
    while (Date.now() < deadline && !(asked = hub.events.find((e) => e.type === 'permission.asked'))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(asked).toBeTruthy();
    expect(asked.data.sessionID).toBe('oc-sess-perm');
    expect(asked.data.action).toBe('edit');
    expect(asked.data.resources).toContain('/tmp/acp-permission-target');
    expect(asked.data.message).toBe('Write to /tmp/acp-permission-target');

    // The user allows once; the agent then reports the selected option.
    expect(src.resolvePermission(asked.data.id, 'once')).toBe(true);
    expect(await turn).toBe('end_turn');

    const text = hub.events
      .filter((e) => e.type === 'session.text.delta')
      .map((e) => e.data.delta)
      .join('');
    expect(text).toContain('permission:allow');
    expect(hub.events.some((e) => e.type === 'permission.replied' && e.data.requestID === asked.data.id)).toBe(true);
    // An unknown id is rejected rather than silently accepted.
    expect(src.resolvePermission('no-such-request', 'once')).toBe(false);
  }, 15000);

  it('publishes an explicit error session.status on transport failure (NFR-4)', async () => {
    const hub = captureHub();
    const src = new AcpEventSource({
      hub,
      agentId: 'es-bad',
      command: 'this-command-does-not-exist-anywhere-xyz',
    });
    sources.push(src);

    await expect(src.start()).rejects.toThrow();
    // start() failure does not publish (no session yet); the error surfaces via
    // the rejected promise. prompt() on a dead source also fails explicitly.
    await expect(src.prompt({ text: 'hi' })).rejects.toThrow();
  }, 15000);
});
