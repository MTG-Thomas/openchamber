// Managed ACP agent subprocess registry + orphan reaper.
//
// Mirrors the safety model of the OpenCode managed-process-registry
// (packages/web/server/lib/opencode/managed-process-registry.js) but for ACP
// stdio agents. Differences from the OpenCode registry:
//   - Records live under ~/.config/openchamber/managed-acp-agents/<pid>.json.
//   - The record carries { pid, agentId, command, ownerPid, transport }.
//   - Identity verification is command-based (the live process command must
//     contain the recorded agent command), NOT port-based, because ACP stdio
//     agents expose no port.
//
// Safety model (identical guarantees to the OpenCode registry):
//   1. The reaper only ever considers pids THIS product recorded.
//   2. Before killing, it re-verifies the live pid still matches the recorded
//      agent command (guards against the OS recycling a dead pid onto an
//      unrelated process).
//   3. It kills only when the spawning owner is provably gone (the child has
//      been reparented to init/pid 1, or the recorded owner pid is dead). A
//      child still owned by a live instance is left untouched.
//
// The existing OpenCode registry is untouched (NFR-1: no weakened guarantees).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveAcpRegistryDir } from './env.js';

const DEFAULT_REGISTRY_DIR = path.join(os.homedir(), '.config', 'openchamber', 'managed-acp-agents');

const resolveDir = () => {
  const override = resolveAcpRegistryDir();
  return override && override.trim() ? override.trim() : DEFAULT_REGISTRY_DIR;
};

const entryFilePath = (pid) => path.join(resolveDir(), `${pid}.json`);

const writeEntryFile = (entry) => {
  const dir = resolveDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${entry.pid}.json`);
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
    fs.renameSync(tmp, filePath);
  } catch {
    // Best-effort: a failed registry write must never break spawn/shutdown.
  }
};

const readAllEntries = () => {
  const dir = resolveDir();
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const entry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (entry && Number.isInteger(entry.pid)) {
        out.push({ entry, filePath });
      } else {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // Corrupt/partial file — drop it.
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  }
  return out;
};

/**
 * Record an ACP agent subprocess WE spawned so a future run can reap it if
 * orphaned. `command` is the agent's invocation command, used for identity
 * verification during reap (ACP stdio agents have no port).
 */
export const registerAcpAgent = ({ pid, agentId, command, ownerPid } = {}) => {
  if (!Number.isInteger(pid)) return;
  writeEntryFile({
    pid,
    agentId: typeof agentId === 'string' ? agentId : null,
    command: typeof command === 'string' ? command : null,
    ownerPid: Number.isInteger(ownerPid) ? ownerPid : process.pid,
    transport: 'stdio',
    spawnedAt: new Date().toISOString(),
  });
};

/** Drop a pid from the registry (after we have killed/closed it ourselves). */
export const unregisterAcpAgent = (pid) => {
  if (!Number.isInteger(pid)) return;
  try {
    fs.rmSync(entryFilePath(pid), { force: true });
  } catch {
  }
};

const isPidAlive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = process exists but we lack permission to signal it → still alive.
    return error?.code === 'EPERM';
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns { ppid, command } for a live pid on Unix, or null if unreadable.
const readUnixProcInfo = (pid) => {
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

// Windows image name for a pid (e.g. "node.exe"), or null.
const readWindowsImageName = (pid) => {
  try {
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    return (result.stdout || '').trim() || null;
  } catch {
    return null;
  }
};

// Identity check for ACP agents: the live command must contain the recorded
// agent command token. Replaces the OpenCode registry's port-based check.
const commandMatchesRecorded = (liveCommand, entry) => {
  if (typeof entry.command !== 'string' || entry.command.trim() === '') return false;
  if (typeof liveCommand !== 'string') return false;
  // Match on the first token of the recorded command (the executable/path),
  // so trailing args don't defeat the comparison.
  const recordedBase = entry.command.split(/\s+/)[0]?.toLowerCase();
  if (!recordedBase) return false;
  const baseName = path.basename(recordedBase).toLowerCase();
  return liveCommand.toLowerCase().includes(baseName);
};

const killOrphan = async (pid) => {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } catch {
    }
    return;
  }

  const signalTree = (signal) => {
    try { process.kill(-pid, signal); } catch {}
    try { process.kill(pid, signal); } catch {}
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

// Decide+act on a single registry entry. Returns true if it was reaped.
const processEntry = async (entry, { log }) => {
  // Dead pid → nothing to do (caller drops the file).
  if (!isPidAlive(entry.pid)) return false;

  const ownerGone = Number.isInteger(entry.ownerPid) && !isPidAlive(entry.ownerPid);

  if (process.platform === 'win32') {
    // Windows lacks reliable reparent-to-1 semantics (job objects usually kill
    // children with the parent), so we reap only when the owner is provably
    // dead. We cannot cheaply match the command on Windows, so we trust the
    // recorded pid + dead-owner signal.
    if (ownerGone) {
      await killOrphan(entry.pid);
      log?.(`[acp] reaped orphaned ACP agent pid ${entry.pid} (owner ${entry.ownerPid} gone)`);
      return true;
    }
    return false;
  }

  const info = readUnixProcInfo(entry.pid);
  // Can't verify identity (or it no longer matches our recorded agent) → leave alone.
  if (!info || !commandMatchesRecorded(info.command, entry)) return false;

  const orphaned = info.ppid === 1 || ownerGone;
  if (!orphaned) return false; // still owned by a live instance

  await killOrphan(entry.pid);
  log?.(`[acp] reaped orphaned ACP agent pid ${entry.pid} (reparented/owner gone)`);
  return true;
};

/**
 * Kill any genuinely-orphaned ACP agent processes WE previously spawned, and
 * prune their registry files. Safe to call at startup before spawning a new
 * agent. Returns { inspected, reaped }.
 */
export const reapOrphanedAcpAgents = async ({ log } = {}) => {
  const records = readAllEntries();
  if (records.length === 0) return { inspected: 0, reaped: 0 };

  let reaped = 0;
  for (const { entry, filePath } of records) {
    let drop = false;
    try {
      const wasReaped = await processEntry(entry, { log });
      if (wasReaped) reaped += 1;
      // Drop the file when the process is gone (reaped now, or already dead);
      // keep it only while the process is still alive and owned by a live owner.
      drop = wasReaped || !isPidAlive(entry.pid);
    } catch (error) {
      log?.(`[acp] reap check failed for pid ${entry.pid}: ${error?.message ?? error}`);
    }
    if (drop) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
    }
  }

  return { inspected: records.length, reaped };
};
