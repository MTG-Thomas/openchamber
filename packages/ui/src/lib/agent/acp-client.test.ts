import { describe, expect, mock, test } from 'bun:test';
import { isAcpSessionRecord } from './types';

// Mock runtimeFetch via a response queue so AcpClient tests never hit the
// network and avoid bun:test mock-control methods that tsc doesn't type.
type FetchResult = Response | Error;
const queue: FetchResult[] = [];
const defaultResponse = (): Response =>
  new Response('{"sessionID":"s-1"}', { status: 200, headers: { 'Content-Type': 'application/json' } });

const runtimeFetchMock = mock((): Promise<Response> => {
  const next = queue.shift();
  if (next instanceof Error) return Promise.reject(next);
  if (next instanceof Response) return Promise.resolve(next);
  return Promise.resolve(defaultResponse());
});

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (...args: unknown[]) => runtimeFetchMock(...(args as [])),
}));

const { AcpClient } = await import('./acp-client');

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const enqueue = (...results: FetchResult[]) => {
  queue.push(...results);
};

// tsc-safe rejection assertion (bun:test's expect().rejects is not in the types).
const expectRejects = async (promise: Promise<unknown>, pattern: RegExp) => {
  let threw = false;
  try {
    await promise;
  } catch (error) {
    threw = true;
    expect(pattern.test((error as Error).message)).toBe(true);
  }
  expect(threw).toBe(true);
};

describe('AcpClient', () => {
  test('createSession builds a Session from the initialize response', async () => {
    enqueue(jsonResponse({ sessionID: 'acp-sess-9', backend: 'acp' }));

    const client = new AcpClient({ command: 'claude-code' });
    const session = await client.createSession({ title: 'My ACP' }, '/repo');

    expect(session.id).toBe('acp-sess-9');
    expect(session.directory).toBe('/repo');
    expect(session.title).toBe('My ACP');
    expect(isAcpSessionRecord(session)).toBe(true);
    expect(session.time.created).toBeGreaterThan(0);
  });

  test('createSession throws on a non-success response (never empty success) — TC-9/NFR-4', async () => {
    enqueue(jsonResponse({ error: 'spawn failed' }, 502));

    const client = new AcpClient({ command: 'bad' });
    await expectRejects(client.createSession(), /spawn failed/);
  });

  test('createSession throws when the response has no session id', async () => {
    enqueue(jsonResponse({}));

    const client = new AcpClient({ command: 'x' });
    await expectRejects(client.createSession(), /session id/i);
  });

  test('sendMessage throws on a non-success response — TC-9', async () => {
    enqueue(jsonResponse({ error: 'no active session' }, 409));

    const client = new AcpClient({ command: 'x' });
    await expectRejects(
      client.sendMessage({ id: 's-1', text: 'hi' }),
      /no active session/,
    );
  });

  test('sendMessage resolves with the client message id on success', async () => {
    enqueue(jsonResponse({ stopReason: 'end_turn', sessionID: 's-1' }));

    const client = new AcpClient({ command: 'x' });
    const id = await client.sendMessage({ id: 's-1', text: 'hi', messageId: 'msg-7' });
    expect(id).toBe('msg-7');
  });

  test('abortSession is best-effort and never throws', async () => {
    enqueue(jsonResponse({ ok: true }, 202));
    const client = new AcpClient({ command: 'x' });
    expect(await client.abortSession('s-1')).toBe(true);

    enqueue(jsonResponse({ error: 'boom' }, 500));
    expect(await client.abortSession('s-1')).toBe(false);

    enqueue(new Error('network'));
    expect(await client.abortSession('s-1')).toBe(false);
  });

  test('backend is "acp" and capabilities advertises cancel', () => {
    const client = new AcpClient({ command: 'x' });
    expect(client.backend).toBe('acp');
    expect(client.capabilities().canCancel).toBe(true);
  });

  test('listModels parses the agent model select (flat and grouped)', async () => {
    enqueue(jsonResponse({
      configOptions: [
        { type: 'select', id: 'thought_level', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
        {
          type: 'select',
          id: 'model',
          category: 'model',
          currentValue: 'model-b',
          options: [
            { value: 'model-a', name: 'Model A' },
            { group: 'more', name: 'More', options: [{ value: 'model-b', name: 'Model B' }] },
          ],
        },
      ],
    }));
    const client = new AcpClient({ command: 'x' });
    const config = await client.listModels('s-1');
    expect(config?.configId).toBe('model');
    expect(config?.currentValue).toBe('model-b');
    expect(config?.options.map((option) => option.value)).toEqual(['model-a', 'model-b']);
  });

  test('listModels returns null when the agent reports no model select', async () => {
    const client = new AcpClient({ command: 'x' });
    enqueue(jsonResponse({ error: 'no active session' }, 409));
    expect(await client.listModels('s-1')).toBeNull();

    enqueue(jsonResponse({
      configOptions: [
        { type: 'select', id: 'thought_level', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
      ],
    }));
    expect(await client.listModels('s-1')).toBeNull();
  });

  test('setModel returns the updated selection and throws on failure', async () => {
    const client = new AcpClient({ command: 'x' });
    enqueue(jsonResponse({
      configOptions: [
        { type: 'select', id: 'model', category: 'model', currentValue: 'model-b', options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
      ],
    }));
    const updated = await client.setModel('s-1', 'model', 'model-b');
    expect(updated?.currentValue).toBe('model-b');

    enqueue(jsonResponse({ error: 'unsupported' }, 502));
    await expectRejects(client.setModel('s-1', 'model', 'model-a'), /unsupported/);
  });

  test('replyToPermission treats success and already-resolved as replied', async () => {
    const client = new AcpClient({ command: 'x' });
    enqueue(jsonResponse({ ok: true }));
    expect(await client.replyToPermission('s-1', 'perm-1', 'once')).toBe(true);
    enqueue(jsonResponse({ error: 'unknown' }, 404));
    expect(await client.replyToPermission('s-1', 'perm-1', 'once')).toBe(true);
    enqueue(jsonResponse({ error: 'no active session' }, 409));
    expect(await client.replyToPermission('s-1', 'perm-1', 'once')).toBe(false);
  });
});
