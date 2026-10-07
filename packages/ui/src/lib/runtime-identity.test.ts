import { describe, expect, test } from 'bun:test';
import { parseSessionOwner, projectRefKey, sessionOwnerQuery, sessionRefKey } from './runtime-identity';

describe('qualified identity', () => {
  test('isolates identical native IDs across hosts and backends', () => {
    const refs = [
      { runtimeId: 'local', backendId: 'opencode', sessionId: 'same' },
      { runtimeId: 'remote', backendId: 'opencode', sessionId: 'same' },
      { runtimeId: 'local', backendId: 'acp:muse', sessionId: 'same' },
    ];
    expect(new Set(refs.map(sessionRefKey)).size).toBe(3);
    expect(projectRefKey({ runtimeId: 'local', projectId: '/repo' }))
      .not.toBe(projectRefKey({ runtimeId: 'remote', projectId: '/repo' }));
  });
  test('survives separators, Unicode, and project moves', () => {
    const ref = { runtimeId: 'host:a/b', backendId: 'acp:1', sessionId: '会話/1', projectId: '/repo' };
    expect(parseSessionOwner(sessionOwnerQuery(ref), ref.sessionId)).toEqual(ref);
    expect(sessionRefKey(ref)).toBe(sessionRefKey({ ...ref, projectId: '/other' }));
    expect(parseSessionOwner(new URLSearchParams('runtime=local'), 'same')).toBeNull();
  });
});
