import { OpenCode } from '@opencode/client';
import { projectSession } from './projection';
import { acpSessionOwnerSchema, isAcpSessionRecord } from '../agent/types';
import type { IndexedSession } from '../runtimes/registry';

// Wire shapes stay inside the OpenCode integration. Global session reads do
// not start project locations or MCP fleets on background hosts.
export const listRuntimeSessionIndex = async (
  runtimeId: string, baseUrl: string, fetcher: typeof fetch, signal: AbortSignal,
): Promise<IndexedSession[]> => {
  const client = OpenCode.make({ baseUrl, fetch: (input, init) => fetcher(input, { ...init, signal }) });
  const sessions: IndexedSession[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.session.list({ limit: 500, cursor, parentID: null });
    for (const info of page.data) {
      const session = projectSession(info);
      const acpOwner = acpSessionOwnerSchema.safeParse(session.metadata?.openchamber);
      if (isAcpSessionRecord(session) && !acpOwner.success) throw new Error('ACP session index has no backend owner');
      sessions.push({ ref: { runtimeId, backendId: acpOwner.success ? `acp:${acpOwner.data.agentId}` : 'opencode',
        sessionId: session.id, projectId: session.projectID || session.directory },
      title: session.title, directory: session.directory });
    }
    cursor = page.cursor.next ?? undefined;
    if (cursor && seenCursors.has(cursor)) throw new Error('Session index repeated a pagination cursor');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return sessions;
};
