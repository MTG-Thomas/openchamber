import { z } from 'zod';
import { test, expect } from 'bun:test';
import { createServer } from 'node:http';
import { createRuntimeDriver } from './connection';
import { RuntimeRegistry } from './registry';

test('independent HTTP hosts keep identical native IDs and retain healthy rows on failure', async () => {
  const servers = ['one', 'two'].map((name) => createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${name}`) { response.writeHead(401).end(); return; }
    if (request.url?.startsWith('/api/event')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': connected\n\n'); return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'same', projectID: 'same-project', title: name,
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 }, location: { directory: '/repo' }, metadata: {} }], cursor: {} }));
  }));
  const registry = new RuntimeRegistry();
  const activated: string[] = [];
  try {
    for (const [index, server] of servers.entries()) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = z.object({ port: z.number() }).parse(server.address());
      const id = ['one', 'two'][index];
      registry.register(id, id, createRuntimeDriver({ id, baseUrl: `http://127.0.0.1:${address.port}`, clientToken: id,
        activate: async () => { activated.push(id); } }));
      await registry.refresh(id);
    }
    expect(registry.getSnapshot().map((host) => host.sessions[0]?.ref)).toEqual([
      { runtimeId: 'one', backendId: 'opencode', sessionId: 'same', projectId: 'same-project' },
      { runtimeId: 'two', backendId: 'opencode', sessionId: 'same', projectId: 'same-project' },
    ]);
    await registry.activate(registry.getSnapshot()[1].sessions[0].ref);
    expect(activated).toEqual(['two']);
    servers[0].closeAllConnections(); servers[0].close();
    await Promise.all([registry.refresh('one'), registry.refresh('two')]);
    expect(registry.getSnapshot().map((host) => [host.status, host.sessions.length])).toEqual([['error', 1], ['ready', 1]]);
  } finally {
    registry.remove('one'); registry.remove('two');
    for (const server of servers) { server.closeAllConnections(); server.close(); }
  }
});
