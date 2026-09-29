import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpAgentConnection } from './acp-connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the mock agent robustly: vitest may relocate the test file's
// import.meta.url, so anchor on process.cwd() (the package root) which is
// stable, falling back to the file-relative path.
const resolveMockAgent = () => {
  const cwdRelative = join(process.cwd(), 'server/lib/acp/__tests__/fixtures/mock-agent.js');
  const fileRelative = join(__dirname, 'fixtures', 'mock-agent.js');
  return existsSync(cwdRelative) ? cwdRelative : fileRelative;
};
const mockAgentPath = resolveMockAgent();

const connections = [];
const startConnection = (options) => {
  const conn = new AcpAgentConnection(options);
  connections.push(conn);
  return conn.start();
};
const stopAll = async () => {
  await Promise.all(connections.map((c) => c.stop().catch(() => {})));
  connections.length = 0;
};
afterEach(stopAll);

describe('AcpAgentConnection initialize handshake', () => {
  it('spawns a stdio agent and completes the initialize handshake (TC-12)', async () => {
    const conn = new AcpAgentConnection({
      agentId: 'mock-1',
      command: process.execPath,
      args: [mockAgentPath],
    });
    connections.push(conn);
    let initResult;
    try {
      initResult = await conn.start();
    } catch (e) {
      throw new Error(`${e.message}\n[child stderr] ${conn._lastStderr?.() ?? ''}`);
    }

    expect(initResult).toBeTruthy();
    // ACP protocolVersion is numeric (e.g. 1).
    expect(typeof initResult.protocolVersion === 'number' || typeof initResult.protocolVersion === 'string').toBe(true);
    expect(initResult.protocolVersion).toBeTruthy();
  }, 15000);

  it('rejects explicitly on an invalid agent command (TC-13)', async () => {
    await expect(
      startConnection({
        agentId: 'bad-1',
        command: 'this-command-does-not-exist-anywhere-xyz',
      })
    ).rejects.toThrow();

    // The failed connection must have been cleaned up (no lingering teardown).
    // stopAll in afterEach handles teardown; this asserts the start rejected.
  }, 15000);

  it('runs onReady after initialize and parks until stop (lifecycle)', async () => {
    let readySeen = false;
    let initSeen = null;
    const conn = new AcpAgentConnection({
      agentId: 'mock-2',
      command: process.execPath,
      args: [mockAgentPath],
      onReady: async (_ctx, initResult) => {
        initSeen = initResult;
        readySeen = true;
      },
    });
    connections.push(conn);

    const initResult = await conn.start();
    expect(initResult.protocolVersion).toBeTruthy();

    // Give onReady a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(readySeen).toBe(true);
    expect(initSeen).toBeTruthy();

    await conn.stop();
  }, 15000);
});
