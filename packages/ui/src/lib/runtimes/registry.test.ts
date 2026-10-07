import { describe, expect, test } from 'bun:test';
import { RuntimeRegistry, type RuntimeDriver, type IndexedSession } from './registry';
const row = (runtimeId: string, backendId = 'opencode'): IndexedSession => ({
  ref: { runtimeId, backendId, sessionId: 'same', projectId: '/repo' }, title: runtimeId, directory: '/repo',
});
const driver = (list: RuntimeDriver['list'], activate = async () => {}): RuntimeDriver => ({
  list, activate, observe: () => () => {}, close: () => {},
});

describe('runtime session index', () => {
  test('keeps equal IDs from two hosts and two backends, activates the actual owner', async () => {
    const registry = new RuntimeRegistry();
    const activated: string[] = [];
    registry.register('a', 'Local', driver(async () => [row('a'), row('a', 'acp:muse')], async () => { activated.push('a'); }));
    registry.register('b', 'Remote', driver(async () => [row('b')], async () => { activated.push('b'); }));
    await registry.refresh('a'); await registry.refresh('b');
    expect(registry.getSnapshot().map((runtime) => runtime.sessions.length)).toEqual([2, 1]);
    await registry.activate(row('b').ref);
    expect(activated).toEqual(['b']);
  });
  test('failed host retains rows while another host updates successfully', async () => {
    const registry = new RuntimeRegistry();
    let fail = false;
    registry.register('a', 'Local', driver(async () => { if (fail) throw new Error('offline'); return [row('a')]; }));
    registry.register('b', 'Remote', driver(async () => [row('b')]));
    await registry.refresh('a'); fail = true;
    await Promise.all([registry.refresh('a'), registry.refresh('b')]);
    expect(registry.getSnapshot()[0].sessions).toEqual([row('a')]);
    expect(registry.getSnapshot()[0].status).toBe('error');
    expect(registry.getSnapshot()[1].status).toBe('ready');
  });
  test('late response from a replaced connection cannot replace new rows', async () => {
    const registry = new RuntimeRegistry();
    let release = (rows: IndexedSession[]) => { void rows; };
    registry.register('a', 'Old', driver(() => new Promise((resolve) => { release = resolve; })));
    const pending = registry.refresh('a');
    registry.register('a', 'New', driver(async () => []));
    await registry.refresh('a'); release([row('a')]); await pending;
    expect(registry.getSnapshot()[0].label).toBe('New');
    expect(registry.getSnapshot()[0].sessions).toEqual([]);
  });
  test('suspension preserves summaries and resume reloads authoritative state', async () => {
    const registry = new RuntimeRegistry();
    let reads = 0;
    registry.register('a', 'Local', driver(async () => { reads++; return [row('a')]; }));
    await registry.refresh('a'); const before = reads;
    registry.setSuspended(true); await registry.refresh('a');
    expect(reads).toBe(before);
    expect(registry.getSnapshot()[0].sessions).toEqual([row('a')]);
    expect(registry.getSnapshot()[0].status).toBe('suspended');
    registry.setSuspended(false); await registry.refresh('a');
    expect(registry.getSnapshot()[0].status).toBe('ready');
    expect(reads).toBeGreaterThan(before);
  });
  test('rejects a list from the wrong owner instead of mixing hosts', async () => {
    const registry = new RuntimeRegistry();
    registry.register('a', 'Local', driver(async () => [row('b')]));
    await registry.refresh('a');
    expect(registry.getSnapshot()[0].status).toBe('error');
    expect(registry.getSnapshot()[0].sessions).toEqual([]);
  });
});
