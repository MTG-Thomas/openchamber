// Managed ACP agent subprocess registry + orphan reaper — VS Code parity copy.
//
// Mirrors packages/web/server/lib/acp/agent-process-manager.js so that a
// process spawned by any runtime (web, desktop, VS Code) can be reaped by any
// other. Reads/writes the SAME on-disk registry directory
// (~/.config/openchamber/managed-acp-agents/<pid>.json) using the SAME
// per-pid-file algorithm and command-based identity check (ACP stdio agents
// expose no port).
//
// See the web module for the full rationale and safety model. In short: we
// only ever kill pids THIS product recorded, re-verified as matching the
// recorded agent command, and only when their spawner is provably gone.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type AcpProcessEntry = {
  pid: number;
  agentId: string | null;
  command: string | null;
  ownerPid: number;
  transport: 'stdio';
  spawnedAt: string;
};

const resolveRegistryDir = (): string => {
  const override = process.env.OPENCHAMBER_ACP_AGENT_REGISTRY;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.config', 'openchamber', 'managed-acp-agents');
};

const readAllEntries = (): Array<{ entry: AcpProcessEntry; filePath: string }> => {
  const dir = resolveRegistryDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Array<{ entry: AcpProcessEntry; filePath: string }> = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (entry && Number.isInteger(entry.pid)) {
        // SAFETY: entry passed the pid check above; remaining fields are
        // validated by commandMatchesRecorded before any kill decision.
        out.push({ entry: entry as AcpProcessEntry, filePath });
      } else {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
    }
  }
  return out;
};

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: process.kill throws a NodeJS.ErrnoException; EPERM means the pid
    // exists but is owned by another user, which counts as alive.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const readUnixProcInfo = (pid: number): { ppid: number; command: string } | null => {
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const line = (result.stdout || '').trim();
    if (!line) return null;
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) return null;
    return { ppid: Number.parseInt(match[1], 10), command: match[2] };
  } catch {
    return null;
  }
};

// Identity check for ACP agents: the live command must contain the recorded
// agent command's base name (no port, since ACP stdio agents expose none).
const commandMatchesRecorded = (liveCommand: string, entry: AcpProcessEntry): boolean => {
  // SAFETY: registry files are external JSON, so entry.command and liveCommand
  // are re-validated as strings before the identity comparison below.
  if (typeof entry.command !== 'string' || entry.command.trim() === '') return false;
  if (typeof liveCommand !== 'string') return false;
  const recordedBase = entry.command.split(/\s+/)[0]?.toLowerCase();
  if (!recordedBase) return false;
  const baseName = path.basename(recordedBase).toLowerCase();
  return liveCommand.toLowerCase().includes(baseName);
};

const killOrphan = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } catch {
      // ignore
    }
    return;
  }

  const signalTree = (signal: NodeJS.Signals) => {
    try { process.kill(-pid, signal); } catch { /* ignore */ }
    try { process.kill(pid, signal); } catch { /* ignore */ }
  };

  signalTree('SIGTERM');
  for (let waited = 0; waited < 1500 && isPidAlive(pid); waited += 150) {
    await sleep(150);
  }
  if (isPidAlive(pid)) {
    signalTree('SIGKILL');
    await sleep(300);
  }
};

const processEntry = async (
  entry: AcpProcessEntry,
  log?: (message: string) => void,
): Promise<boolean> => {
  if (!isPidAlive(entry.pid)) return false;

  const ownerGone = Number.isInteger(entry.ownerPid) && !isPidAlive(entry.ownerPid);

  if (process.platform === 'win32') {
    // Windows lacks reliable reparent-to-1 semantics; reap only when the owner
    // is provably dead (cannot cheaply match the command on Windows).
    if (ownerGone) {
      await killOrphan(entry.pid);
      log?.(`[acp] reaped orphaned ACP agent pid ${entry.pid} (owner ${entry.ownerPid} gone)`);
      return true;
    }
    return false;
  }

  const info = readUnixProcInfo(entry.pid);
  if (!info || !commandMatchesRecorded(info.command, entry)) return false;

  const orphaned = info.ppid === 1 || ownerGone;
  if (!orphaned) return false;

  await killOrphan(entry.pid);
  log?.(`[acp] reaped orphaned ACP agent pid ${entry.pid} (reparented/owner gone)`);
  return true;
};

export const reapOrphanedAcpAgents = async (
  options: { log?: (message: string) => void } = {},
): Promise<{ inspected: number; reaped: number }> => {
  const { log } = options;
  const records = readAllEntries();
  if (records.length === 0) return { inspected: 0, reaped: 0 };

  let reaped = 0;
  for (const { entry, filePath } of records) {
    let drop = false;
    try {
      const wasReaped = await processEntry(entry, log);
      if (wasReaped) reaped += 1;
      drop = wasReaped || !isPidAlive(entry.pid);
    } catch (error) {
      log?.(`[acp] reap check failed for pid ${entry.pid}: ${error instanceof Error ? error.message : error}`);
    }
    if (drop) {
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
    }
  }

  return { inspected: records.length, reaped };
};
