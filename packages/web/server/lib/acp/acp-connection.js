// ACP agent connection lifecycle: spawn a stdio agent subprocess, run the ACP
// initialize handshake, and hold the connection open for session/prompt turns
// (task 7's event source drives sessions via the `onReady` hook). Teardown
// kills the subprocess and unregisters it from the agent-process-manager.
//
// Transport model (verified in task 5 spike): the SDK does NOT own spawn. We
// spawn the child, convert its Node stdio to web streams, and feed them to
// `ndJsonStream` + `client({name}).connectWith(stream, op)`.
//
// The connectWith `op` performs initialize, then invokes `onReady(ctx)` (which
// may park for the connection's lifetime), then awaits a teardown signal so the
// connection stays open until stop() is called.

import { spawn } from 'node:child_process';
import { Writable, Readable, PassThrough } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { registerAcpAgent, unregisterAcpAgent } from './agent-process-manager.js';
import { isAcpDebug } from './env.js';

/**
 * @typedef {Object} AcpAgentConnectionOptions
 * @property {string} agentId  Stable id (links to AcpAgentConfig; used for registry).
 * @property {string} command  Executable to spawn.
 * @property {string[]} [args] Args for the executable.
 * @property {Record<string,string>} [env] Extra env for the child.
 * @property {string} [cwd] Working directory for the child / sessions.
 * @property {string} [clientName="openchamber"] Client implementation name.
 * @property {(ctx: import('@agentclientprotocol/sdk').ClientContext, initResult: any) => Promise<void>} [onReady]
 *   Runs after initialize inside the connectWith op; task 7's event source uses
 *   it to drive sessions. Defaults to a no-op (connection just parks).
 * @property {(notification: any) => void} [onNotification]
 *   Raw ACP notification sink for client-side requests (e.g. permission). Optional.
 * @property {(params: import('@agentclientprotocol/sdk').RequestPermissionRequest) => Promise<import('@agentclientprotocol/sdk').RequestPermissionResponse>} [onPermissionRequest]
 *   Handles an agent `session/request_permission` request. When absent the
 *   request is answered `cancelled` (a valid ACP response) rather than the
 *   SDK's method-not-found, which the agent would treat as a protocol error.
 */

/** Turn a child-process spawn failure into an error the UI can show as-is. */
const describeSpawnError = (error, command) => {
  if (error?.code === 'ENOENT') return new Error(`ACP agent command not found: ${command}`, { cause: error });
  if (error?.code === 'EACCES') return new Error(`ACP agent command is not executable: ${command}`, { cause: error });
  return new Error(`Failed to start ACP agent ${command}: ${error?.message ?? error}`, { cause: error });
};

export class AcpAgentConnection {
  /**
   * @param {AcpAgentConnectionOptions} options
   */
  constructor(options) {
    this.options = options;
    this.process = null;
    this._resolveTeardown = null;
    this._teardownPromise = null;
    this._resolveInit = null;
    this._rejectInit = null;
    this._initializedPromise = null;
    this._runPromise = null;
    this.initializeResult = null;
  }

  /**
   * Spawn the agent and run the initialize handshake.
   * Resolves with the InitializeResponse (capabilities) on success.
   * Rejects on spawn or handshake failure (callers must surface as explicit error).
   */
  async start() {
    const { command, args = [], env, cwd, clientName = 'openchamber', onReady } = this.options;

    // Build a clean child env: inherit the parent's, then strip Node/test-runner
    // injections the agent subprocess must NOT inherit (NODE_OPTIONS may point at
    // vitest's loader under test; the agent is a standalone process).
    const childEnv = { ...process.env };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.NODE_V8_COVERAGE;
    delete childEnv.FORCE_COLOR;
    Object.assign(childEnv, env || {});

    const child = spawn(command, args.length > 0 ? args : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cwd || undefined,
      env: childEnv,
      windowsHide: true,
    });
    this.process = child;
    if (Number.isInteger(child.pid)) {
      console.log(`[acp] spawned agent pid=${child.pid} agentId=${this.options.agentId} cwd=${this.options.cwd || '(none)'} command=${command}`);
    }

    // Capture stderr to surface spawn/handshake failures (never logged raw in
    // production unless a debug flag is set; tests read it via the exit error).
    let stderrBuf = '';
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk;
        // Agents report model/auth failures on stderr; surface them under the
        // debug flag or a stalled turn has no explanation anywhere.
        if (isAcpDebug()) console.log('[acp:err] ' + String(chunk).slice(0, 1000));
      });
    }
    this._lastStderr = () => stderrBuf;

    // A failed spawn (e.g. ENOENT) surfaces as a child 'error' event. Some
    // runtimes (Bun) also abort the stdio streams first, which would reject the
    // handshake with a bare "operation was aborted" and hide the real cause, so
    // the spawn failure is recorded and preferred when the handshake fails.
    let spawnFailure = null;
    const spawnFailed = new Promise((resolve) => {
      child.once('error', (error) => {
        spawnFailure = describeSpawnError(error, command);
        resolve(spawnFailure);
      });
    });
    const spawnError = new Promise((resolve, reject) => {
      void spawnFailed.then(reject);
      child.once('exit', (code, signal) => {
        if (this._resolveInit) {
          // Exited before initialize completed → handshake failed.
          const detail = stderrBuf.trim().slice(0, 500);
          console.warn(`[acp] handshake failed: agent pid=${child.pid} exited code=${code} signal=${signal}`);
          reject(new Error(`ACP agent exited before initialize (code=${code} signal=${signal})${detail ? `: ${detail}` : ''}`));
        }
      });
    });

    // Register for orphan-safe reaping once we have a pid.
    if (Number.isInteger(child.pid)) {
      registerAcpAgent({ pid: child.pid, agentId: this.options.agentId, command });
    }

    const input = isAcpDebug() ? Writable.toWeb(this._tapOutbound(child.stdin)) : Writable.toWeb(child.stdin);
    // OPENCHAMBER_ACP_DEBUG taps the agent's inbound JSON-RPC so an agent that
    // stalls mid-turn can be told apart from a client that never answered it.
    const output = isAcpDebug() ? Readable.toWeb(this._tapInbound(child.stdout)) : Readable.toWeb(child.stdout);
    const stream = acp.ndJsonStream(input, output);

    this._teardownPromise = new Promise((resolve) => { this._resolveTeardown = resolve; });
    this._initializedPromise = new Promise((resolve, reject) => {
      this._resolveInit = resolve;
      this._rejectInit = reject;
    });

    const app = acp.client({ name: clientName });
    if (typeof this.options.onNotification === 'function') {
      app.onNotification(acp.methods.client.session.update, (ctx) => {
        try { this.options.onNotification(ctx.params); } catch {}
      });
    }
    // Answer agent permission requests. Without a registered handler the SDK
    // replies method-not-found, which the agent reads as a protocol error and
    // cancels its tool call; with no callback configured here the answer is an
    // explicit `cancelled` outcome instead.
    app.onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      if (typeof this.options.onPermissionRequest !== 'function') {
        return { outcome: { outcome: 'cancelled' } };
      }
      return this.options.onPermissionRequest(ctx.params);
    });

    this._runPromise = app
      .connectWith(stream, async (ctx) => {
        const initResult = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        this.initializeResult = initResult;
        console.log(`[acp] initialized protocolVersion=${initResult?.protocolVersion} raw=${JSON.stringify(initResult).slice(0, 600)}`);
        this._resolveInit(initResult);
        // The handshake is settled: a later child exit is a normal teardown,
        // not a failed handshake, and must not try to reject again.
        this._resolveInit = null;
        this._rejectInit = null;
        try {
          if (typeof onReady === 'function') await onReady(ctx, initResult);
        } finally {
          // Park until teardown so the connection stays open for sessions.
          await this._teardownPromise;
        }
      })
      .catch((error) => {
        // Propagate handshake/connect errors to anyone awaiting initialize.
        if (this._rejectInit) this._rejectInit(error);
        return error;
      });

    // Race initialize against an early spawn failure and a hard timeout: an
    // agent that spawns but never answers initialize must fail loudly (and be
    // killed) rather than hang the request and wedge teardown behind it.
    const handshakeTimeoutMs = 20000;
    let handshakeTimer;
    const handshakeTimeout = new Promise((_, reject) => {
      handshakeTimer = setTimeout(() => {
        reject(new Error(
          `ACP agent did not complete the initialize handshake within ${handshakeTimeoutMs / 1000}s `
          + `(command: ${command}). Verify the command is an ACP agent, not the agent's own CLI.`,
        ));
      }, handshakeTimeoutMs);
    });
    try {
      await Promise.race([this._initializedPromise, spawnError, handshakeTimeout]);
    } catch (error) {
      // No pid means the spawn itself failed; its 'error' event may land after
      // the stream abort that rejected the race, so wait for it (it is sync-near).
      if (!spawnFailure && !Number.isInteger(child.pid)) {
        await Promise.race([spawnFailed, new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
      const cause = spawnFailure ?? error;
      // Mark the init as settled so the pending request rejects with this
      // reason instead of waiting forever, then tear the child down.
      if (this._rejectInit) this._rejectInit(cause);
      await this.stop().catch(() => {});
      throw cause;
    } finally {
      clearTimeout(handshakeTimer);
    }
    return this._initializedPromise;
  }

  /**
   * Pass the child's stdout through unchanged while logging every line when
   * verbose ACP logging is on. The tap sits between the child and the SDK's
   * reader so it never competes for stream data.
   */
  _tapInbound(source) {
    const tap = new PassThrough();
    source.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) console.log('[acp:in] ' + line.slice(0, 1200));
      }
      tap.write(chunk);
    });
    source.on('end', () => tap.end());
    source.on('error', (error) => tap.destroy(error));
    return tap;
  }

  /**
   * Pass the client's outbound JSON-RPC to the child's stdin while logging it
   * when verbose ACP logging is on. Shows exactly which requests the agent
   * received, in order, when a turn stalls.
   */
  _tapOutbound(target) {
    const tap = new PassThrough();
    tap.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) console.log('[acp:out] ' + line.slice(0, 600));
      }
      target.write(chunk);
    });
    return tap;
  }

  /** Stop the agent: signal teardown, wait for the run loop, kill the child. */
  async stop() {
    if (this._resolveTeardown) this._resolveTeardown();
    // The run promise only settles once the handshake completed and teardown
    // was signalled. If the handshake never completed it can stay pending
    // forever, and awaiting it here would wedge teardown — every later
    // /initialize would queue behind the stuck one and the UI's send would
    // hang with no error. Bound the wait; the child is killed regardless.
    try {
      await Promise.race([
        this._runPromise,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // connectWith may reject on teardown; best-effort.
    }
    const child = this.process;
    if (child && Number.isInteger(child.pid)) {
      try {
        if (process.platform === 'win32') {
          const { spawnSync } = await import('node:child_process');
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } catch {}
      unregisterAcpAgent(child.pid);
    }
    this.process = null;
  }
}
