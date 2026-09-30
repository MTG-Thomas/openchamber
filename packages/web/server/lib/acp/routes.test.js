import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  registerAcpRoutes,
  _resetAcpRoutesState,
  acpSessionListOverlay,
  acpSessionInterceptor,
  getAcpSessionMessages,
  initAcpOnStartup,
} from './routes.js';

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
const ORIGINAL_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR;
let dataDir;
beforeEach(() => {
  process.env.OPENCHAMBER_ACP_ENABLED = 'true';
  // Config routes write the persisted agent config: keep it out of the real data dir.
  dataDir = mkdtempSync(join(tmpdir(), 'acp-routes-'));
  process.env.OPENCHAMBER_DATA_DIR = dataDir;
});
afterEach(async () => {
  await _resetAcpRoutesState();
  if (ORIGINAL_FLAG === undefined) delete process.env.OPENCHAMBER_ACP_ENABLED;
  else process.env.OPENCHAMBER_ACP_ENABLED = ORIGINAL_FLAG;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = ORIGINAL_DATA_DIR;
  delete process.env.OPENCHAMBER_ACP_COMMAND;
  delete process.env.OPENCHAMBER_ACP_ARGS;
  rmSync(dataDir, { recursive: true, force: true });
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

describe('ACP sessions in the session lists and by-id reads', () => {
  const OPENCODE_SESSION = {
    id: 'oc-1',
    projectID: 'p',
    title: 'An OpenCode session',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    location: { directory: '/work/a' },
  };

  // Mirrors production order: ACP middleware first, then the OpenCode proxy
  // (here a stand-in that answers the session list like OpenCode does).
  const buildListApp = (upstream = (_req, res) => res.json({ data: [OPENCODE_SESSION], cursor: { previous: null, next: null } })) => {
    const app = express();
    app.use('/api', acpSessionListOverlay);
    app.use('/api', acpSessionInterceptor);
    registerAcpRoutes(app, { globalMessageStreamHub: captureHub() });
    app.get('/api/session', upstream);
    return app;
  };

  const initSession = async (app, directory) => {
    const init = await request(app, 'post', '/api/agent/acp/initialize', {
      command: process.execPath,
      args: [mockAgentPath],
      directory,
      cwd: directory,
    });
    expect(init.statusCode).toBe(200);
    return init.body.sessionID;
  };

  it('adds the ACP session, with its directory, to the global and directory lists', async () => {
    const app = buildListApp();
    const sessionID = await initSession(app, process.cwd());

    const global = await request(app, 'get', '/api/session?limit=500');
    expect(global.statusCode).toBe(200);
    expect(global.body.data.map((s) => s.id)).toEqual(['oc-1', sessionID]);
    const acp = global.body.data.find((s) => s.id === sessionID);
    expect(acp.location).toEqual({ directory: process.cwd() });
    expect(acp.metadata).toEqual({ openchamber: { acp: true } });

    const scoped = await request(app, 'get', `/api/session?limit=100&directory=${encodeURIComponent(process.cwd())}`);
    expect(scoped.body.data.map((s) => s.id)).toContain(sessionID);

    const otherDir = await request(app, 'get', '/api/session?directory=%2Felsewhere');
    expect(otherDir.body.data.map((s) => s.id)).toEqual(['oc-1']);

    await request(app, 'post', '/api/agent/acp/shutdown', {});
  }, 15000);

  it('leaves later pages, error answers and other agents alone', async () => {
    const app = buildListApp();
    await initSession(app, process.cwd());

    const nextPage = await request(app, 'get', '/api/session?cursor=abc');
    expect(nextPage.body.data.map((s) => s.id)).toEqual(['oc-1']);

    const failing = buildListApp((_req, res) => res.status(503).json({ error: 'OpenCode service unavailable' }));
    const failed = await request(failing, 'get', '/api/session');
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toEqual({ error: 'OpenCode service unavailable' });

    // After shutdown the agent's sessions are gone: the list is OpenCode's alone.
    await request(app, 'post', '/api/agent/acp/shutdown', {});
    const afterShutdown = await request(app, 'get', '/api/session');
    expect(afterShutdown.body.data.map((s) => s.id)).toEqual(['oc-1']);
  }, 15000);

  it('answers session.get for an ACP session with the 2.x record (location.directory)', async () => {
    const app = buildListApp();
    const sessionID = await initSession(app, process.cwd());

    const res = await request(app, 'get', `/api/session/${sessionID}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(sessionID);
    expect(res.body.data.location.directory).toBe(process.cwd());
    expect(res.body.data.time.created).toBeGreaterThan(0);

    await request(app, 'post', '/api/agent/acp/shutdown', {});
  }, 15000);

  it('returns an error, not an empty history, when the agent cannot replay a session', async () => {
    const app = buildListApp();
    const first = await initSession(app, process.cwd());
    // A second initialize starts a new agent whose session/load does not know
    // the first session (the mock agent has no session/load at all).
    const second = await initSession(app, process.cwd());
    expect(second).not.toBe(first);

    const res = await request(app, 'get', `/api/session/${first}/message?limit=30`);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toContain('ACP session history unavailable');
    expect(res.body.data).toBeUndefined();

    await request(app, 'post', '/api/agent/acp/shutdown', {});
  }, 20000);

  it('rejects history reads when no agent is running instead of answering empty', async () => {
    await expect(getAcpSessionMessages('never-seen-session')).rejects.toThrow(/not running/);
  });

  it('stops the agent and forgets its sessions when the config is cleared', async () => {
    const app = buildListApp();
    const sessionID = await initSession(app, process.cwd());

    const cleared = await request(app, 'put', '/api/agent/acp/config', { command: '' });
    expect(cleared.statusCode).toBe(200);

    const prompt = await request(app, 'post', '/api/agent/acp/session/prompt', { text: 'hi' });
    expect(prompt.statusCode).toBe(409);
    const list = await request(app, 'get', '/api/session');
    expect(list.body.data.map((s) => s.id)).toEqual(['oc-1']);
    expect(list.body.data.map((s) => s.id)).not.toContain(sessionID);
  }, 15000);
});

describe('ACP prompt routing, agent identity, start races and delete', () => {
  const upstream = (_req, res) => res.json({ data: [], cursor: { previous: null, next: null } });

  const build = () => {
    const hub = captureHub();
    const app = express();
    app.use('/api', acpSessionListOverlay);
    app.use('/api', acpSessionInterceptor);
    registerAcpRoutes(app, { globalMessageStreamHub: hub });
    app.get('/api/session', upstream);
    return { app, hub };
  };

  const init = (app, extra = {}) => request(app, 'post', '/api/agent/acp/initialize', {
    command: process.execPath,
    args: [mockAgentPath],
    agentId: 'mock',
    directory: process.cwd(),
    cwd: process.cwd(),
    ...extra,
  });

  const textFor = (hub, sessionID) => hub.events
    .filter((e) => e.type === 'session.text.delta' && e.data.sessionID === sessionID)
    .map((e) => e.data.delta)
    .join('');

  const waitForText = async (hub, sessionID, needle) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !textFor(hub, sessionID).includes(needle)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return textFor(hub, sessionID);
  };

  const listIds = async (app) => (await request(app, 'get', '/api/session')).body.data.map((s) => s.id);

  it('switches the agent to the session a prompt was sent to, then prompts it', async () => {
    const { app, hub } = build();
    const a = (await init(app, { env: { MOCK_AGENT_LOAD: '1' } })).body.sessionID;
    // A second initialize starts a new agent process whose current session is B.
    const b = (await init(app, { env: { MOCK_AGENT_LOAD: '1' } })).body.sessionID;
    expect(b).not.toBe(a);

    const toA = await request(app, 'post', '/api/agent/acp/session/prompt', { sessionID: a, text: 'whoami:' });
    expect(toA.statusCode).toBe(202);
    const replyA = await waitForText(hub, a, 'ran-in:');
    expect(replyA).toContain(`ran-in:${a}`);
    // The agent was moved to A first (session/load), not left on B.
    expect(replyA).toContain(`loads:${a}`);
    expect(textFor(hub, b)).not.toContain('ran-in:');

    // And back: a prompt for B switches the agent to B again.
    await waitForIdle(hub, a);
    const toB = await request(app, 'post', '/api/agent/acp/session/prompt', { sessionID: b, text: 'whoami:' });
    expect(toB.statusCode).toBe(202);
    const replyB = await waitForText(hub, b, 'ran-in:');
    expect(replyB).toContain(`ran-in:${b}`);
    expect(replyB).toContain(`loads:${a},${b}`);
  }, 20000);

  const waitForIdle = async (hub, sessionID) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !hub.events.some((e) => e.type === 'session.execution.succeeded' && e.data.sessionID === sessionID)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The route clears its busy flag a tick after the final event.
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  it('refuses a prompt for another session when the agent cannot switch to it', async () => {
    const { app, hub } = build();
    const a = (await init(app)).body.sessionID; // the mock does not advertise session/load
    const b = (await init(app)).body.sessionID;

    const toA = await request(app, 'post', '/api/agent/acp/session/prompt', { sessionID: a, text: 'whoami:' });
    expect(toA.statusCode).toBe(502);
    expect(toA.body.error).toMatch(/cannot switch/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Nothing ran anywhere: not in A, and not silently in B.
    expect(hub.events.filter((e) => e.type === 'session.text.delta')).toEqual([]);
    expect(hub.events.some((e) => e.type === 'session.execution.started' || e.type === 'session.step.started')).toBe(false);

    // The current session is unaffected and still works.
    const toB = await request(app, 'post', '/api/agent/acp/session/prompt', { sessionID: b, text: 'whoami:' });
    expect(toB.statusCode).toBe(202);
    expect(await waitForText(hub, b, 'ran-in:')).toContain(`ran-in:${b}`);
  }, 20000);

  it('keeps the agent only while its whole launch config is unchanged', async () => {
    const { app } = build();
    await init(app, { env: { MOCK_AGENT_LOAD: '1' } });
    const put = (body) => request(app, 'put', '/api/agent/acp/config', { command: process.execPath, args: [mockAgentPath], agentId: 'mock', ...body });
    const active = async () => (await request(app, 'get', '/api/agent/acp/session/config')).statusCode === 200;

    expect((await put({ env: { MOCK_AGENT_LOAD: '1' } })).statusCode).toBe(200);
    expect(await active()).toBe(true); // same command, args, env, agent id

    await put({ env: { MOCK_AGENT_LOAD: '1' }, args: [mockAgentPath, '--other'] });
    expect(await active()).toBe(false); // same binary, different args

    await init(app, { env: { MOCK_AGENT_LOAD: '1' } });
    await put({ env: { MOCK_AGENT_LOAD: '0' } });
    expect(await active()).toBe(false); // different env

    await init(app, { env: { MOCK_AGENT_LOAD: '1' } });
    await put({ env: { MOCK_AGENT_LOAD: '1' }, agentId: 'another' });
    expect(await active()).toBe(false); // different agent id
  }, 30000);

  it('drops the previous agent\'s sessions only when the launch config differs', async () => {
    const { app } = build();
    const s1 = (await init(app)).body.sessionID;
    const s2 = (await init(app)).body.sessionID; // same launch config: s1 stays known
    expect(await listIds(app)).toEqual(expect.arrayContaining([s1, s2]));

    const s3 = (await init(app, { args: [mockAgentPath, '--other'] })).body.sessionID;
    const ids = await listIds(app);
    expect(ids).toContain(s3);
    expect(ids).not.toContain(s1);
    expect(ids).not.toContain(s2);
  }, 30000);

  it('lets only the newest of two concurrent initializes win', async () => {
    const { app } = build();
    const [first, second] = await Promise.all([init(app), init(app)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const winner = [first, second].find((r) => r.statusCode === 200).body.sessionID;
    const loser = [first, second].find((r) => r.statusCode === 409);
    expect(loser.body.error).toMatch(/superseded/);

    // The winner's agent is the active one; the loser's never replaced it.
    const prompt = await request(app, 'post', '/api/agent/acp/session/prompt', { sessionID: winner, text: 'whoami:' });
    expect(prompt.statusCode).toBe(202);
  }, 20000);

  it('stops an agent that is still starting up when the config is cleared', async () => {
    const { app, hub } = build();
    process.env.OPENCHAMBER_ACP_COMMAND = process.execPath;
    process.env.OPENCHAMBER_ACP_ARGS = mockAgentPath;
    const startup = initAcpOnStartup(hub, () => {});
    const cleared = await request(app, 'put', '/api/agent/acp/config', { command: '' });
    expect(cleared.statusCode).toBe(200);
    await startup; // returns instead of retrying or activating
    const config = await request(app, 'get', '/api/agent/acp/session/config');
    expect(config.statusCode).toBe(409); // nothing became the active source
  }, 20000);

  it('answers initialize with a partial result when session/list never answers', async () => {
    const { app } = build();
    const startedAt = Date.now();
    const res = await init(app, { env: { MOCK_AGENT_LIST_HANG: '1' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.sessionID).toBeTruthy();
    expect(res.body.sessions).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(10000);
  }, 20000);

  it('removes a deleted session from the registry and the lists', async () => {
    const { app } = build();
    const id = (await init(app)).body.sessionID;
    expect(await listIds(app)).toContain(id);

    const del = await request(app, 'delete', `/api/agent/acp/sessions/${id}`);
    expect(del.statusCode).toBe(200);
    expect(await listIds(app)).not.toContain(id);
    // No longer an ACP session: by-id reads fall through to the OpenCode proxy.
    const get = await request(app, 'get', `/api/session/${id}`);
    expect(get.statusCode).toBe(404);
  }, 20000);

  it('reports whether ACP is enabled, also while it is disabled', async () => {
    const { app } = build();
    expect((await request(app, 'get', '/api/agent/acp/status')).body).toEqual({ enabled: true });
    process.env.OPENCHAMBER_ACP_ENABLED = 'false';
    const off = await request(app, 'get', '/api/agent/acp/status');
    expect(off.statusCode).toBe(200);
    expect(off.body).toEqual({ enabled: false });
  });
});
