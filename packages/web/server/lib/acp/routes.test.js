import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerAcpRoutes, _resetAcpRoutesState } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resolveMockAgent = () => {
  const cwdRelative = join(process.cwd(), 'server/lib/acp/__tests__/fixtures/mock-agent.js');
  const fileRelative = join(__dirname, 'fixtures', 'mock-agent.js');
  return existsSync(cwdRelative) ? cwdRelative : fileRelative;
};
const mockAgentPath = resolveMockAgent();

const captureHub = () => {
  const events = [];
  return { events, publishEvent(event) { events.push(event); } };
};

const buildApp = (hub) => {
  // NOTE: no global express.json() — the real server has none. Each route must
  // mount its own body parser (matches production; catches missing-parser regressions).
  const app = express();
  registerAcpRoutes(app, { globalMessageStreamHub: hub });
  return app;
};

const ORIGINAL_FLAG = process.env.OPENCHAMBER_ACP_ENABLED;
beforeEach(() => { process.env.OPENCHAMBER_ACP_ENABLED = 'true'; });
afterEach(async () => {
  await _resetAcpRoutesState();
  if (ORIGINAL_FLAG === undefined) delete process.env.OPENCHAMBER_ACP_ENABLED;
  else process.env.OPENCHAMBER_ACP_ENABLED = ORIGINAL_FLAG;
});

const request = (app, method, path, body) =>
  app.inject
    ? app.inject({ method, url: path, body })
    : import('supertest').then(({ default: supertest }) =>
        supertest(app)[method](path).send(body).set('Content-Type', 'application/json'));

describe('ACP routes partial-failure safety (TC-17)', () => {
  it('returns 400 when initialize is missing the command field', async () => {
    const app = buildApp(captureHub());
    const res = await request(app, 'post', '/api/agent/acp/initialize', {});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 502 with an explicit error (never empty success) on a bad agent command', async () => {
    const app = buildApp(captureHub());
    const res = await request(app, 'post', '/api/agent/acp/initialize', {
      command: 'this-command-does-not-exist-anywhere-xyz',
    });
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBeTruthy();
    expect(res.body).not.toEqual({});
  });

  it('returns 409 when prompting with no active session', async () => {
    const app = buildApp(captureHub());
    const res = await request(app, 'post', '/api/agent/acp/session/prompt', { text: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBeTruthy();
  });

  it('initializes and prompts end-to-end through the routes', async () => {
    const hub = captureHub();
    const app = buildApp(hub);
    const init = await request(app, 'post', '/api/agent/acp/initialize', {
      command: process.execPath,
      args: [mockAgentPath],
    });
    expect(init.statusCode).toBe(200);
    expect(init.body.sessionID).toBeTruthy();

    const prompt = await request(app, 'post', '/api/agent/acp/session/prompt', {
      sessionID: init.body.sessionID,
      text: 'Hello',
    });
    // The route accepts the turn and answers immediately; a long turn must never
    // hold the request open (clients would time out and misreport the send).
    expect(prompt.statusCode).toBe(202);
    expect(prompt.body.accepted).toBe(true);

    // Completion arrives asynchronously over the event stream (2.x wire events).
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !hub.events.some((e) => e.type === 'session.execution.succeeded')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(hub.events.some((e) => e.type === 'session.text.delta')).toBe(true);
    expect(hub.events.some((e) => e.type === 'session.execution.succeeded')).toBe(true);

    const shutdown = await request(app, 'post', '/api/agent/acp/shutdown', {});
    expect(shutdown.statusCode).toBe(200);
  }, 15000);

  it('round-trips an agent permission request through the route (FR-7)', async () => {
    const hub = captureHub();
    const app = buildApp(hub);
    const init = await request(app, 'post', '/api/agent/acp/initialize', {
      command: process.execPath,
      args: [mockAgentPath],
    });
    expect(init.statusCode).toBe(200);

    const prompt = await request(app, 'post', '/api/agent/acp/session/prompt', {
      sessionID: init.body.sessionID,
      text: 'permission:allow',
    });
    expect(prompt.statusCode).toBe(202);

    // Wait for the agent's permission request to reach the hub.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !hub.events.some((e) => e.type === 'permission.asked')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const asked = hub.events.find((e) => e.type === 'permission.asked');
    expect(asked).toBeTruthy();

    // Malformed replies are rejected; an unknown id is not silently accepted.
    const missingId = await request(app, 'post', '/api/agent/acp/session/permission', { reply: 'once' });
    expect(missingId.statusCode).toBe(400);
    const badReply = await request(app, 'post', '/api/agent/acp/session/permission', { requestID: asked.data.id, reply: 'maybe' });
    expect(badReply.statusCode).toBe(400);
    const unknown = await request(app, 'post', '/api/agent/acp/session/permission', { requestID: 'no-such-request', reply: 'once' });
    expect(unknown.statusCode).toBe(404);

    const accepted = await request(app, 'post', '/api/agent/acp/session/permission', { requestID: asked.data.id, reply: 'once' });
    expect(accepted.statusCode).toBe(200);

    // The turn completes and the agent reported the selected option.
    const turnDeadline = Date.now() + 10000;
    while (Date.now() < turnDeadline && !hub.events.some((e) => e.type === 'session.execution.succeeded')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const text = hub.events
      .filter((e) => e.type === 'session.text.delta')
      .map((e) => e.data.delta)
      .join('');
    expect(text).toContain('permission:allow');
    expect(hub.events.some((e) => e.type === 'permission.replied' && e.data.requestID === asked.data.id)).toBe(true);

    await request(app, 'post', '/api/agent/acp/shutdown', {});
  }, 15000);

  it('lists and switches the agent model through the config route', async () => {
    const app = buildApp(captureHub());
    const init = await request(app, 'post', '/api/agent/acp/initialize', {
      command: process.execPath,
      args: [mockAgentPath],
    });
    expect(init.statusCode).toBe(200);
    // initialize surfaces the agent's config options immediately.
    expect(init.body.configOptions.find((o) => o.category === 'model')?.currentValue).toBe('model-a');

    const list = await request(app, 'get', '/api/agent/acp/session/config');
    expect(list.statusCode).toBe(200);
    const model = list.body.configOptions.find((o) => o.category === 'model');
    expect(model.options.map((o) => o.value)).toEqual(['model-a', 'model-b']);
    expect(list.body.modelConfigId).toBe('model');

    const missing = await request(app, 'post', '/api/agent/acp/session/config', { configId: 'model' });
    expect(missing.statusCode).toBe(400);

    const set = await request(app, 'post', '/api/agent/acp/session/config', { configId: 'model', value: 'model-b' });
    expect(set.statusCode).toBe(200);
    expect(set.body.configOptions.find((o) => o.category === 'model')?.currentValue).toBe('model-b');

    await request(app, 'post', '/api/agent/acp/shutdown', {});
  }, 15000);

  it('carries a chosen model into sessions created afterwards', async () => {
    const hub = captureHub();
    const app = buildApp(hub);
    // Pick a model before a session exists (the initialize creates one).
    const first = await request(app, 'post', '/api/agent/acp/initialize', {
      command: process.execPath,
      args: [mockAgentPath],
    });
    expect(first.statusCode).toBe(200);
    const pick = await request(app, 'post', '/api/agent/acp/session/config', { configId: 'model', value: 'model-b' });
    expect(pick.statusCode).toBe(200);

    // A later initialize starts a NEW session on the agent's default model;
    // the chosen model must be re-applied to it.
    const second = await request(app, 'post', '/api/agent/acp/initialize', {
      command: process.execPath,
      args: [mockAgentPath],
    });
    expect(second.statusCode).toBe(200);
    expect(second.body.sessionID).not.toBe(first.body.sessionID);
    expect(second.body.configOptions.find((o) => o.category === 'model')?.currentValue).toBe('model-b');

    const after = await request(app, 'get', '/api/agent/acp/session/config');
    expect(after.body.configOptions.find((o) => o.category === 'model')?.currentValue).toBe('model-b');

    await request(app, 'post', '/api/agent/acp/shutdown', {});
  }, 15000);
});
