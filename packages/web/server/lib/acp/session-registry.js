// Registry of the ACP sessions this server knows about, with the directory each
// one runs in.
//
// ACP sessions never exist in OpenCode, so OpenCode's own `session.list` and
// `session.get` cannot describe them. Every session list the UI reads is an
// authoritative snapshot (a session missing from it is dropped from the
// sidebar), so the server overlays these records onto the OpenCode list and
// answers `session.get` from them. Records follow the OpenCode 2.x
// `SessionInfo` wire shape and carry the `openchamber.acp` marker the UI uses
// to route calls for ACP sessions away from OpenCode.
//
// The registry belongs to one agent at a time: `setRegistryOwner` drops every
// record when the configured agent changes, because the old agent's session ids
// mean nothing to the new one.

const records = new Map(); // sessionId -> { id, directory, title, created, updated }
let owner = null;

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const toMillis = (value, fallback) => {
  if (Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Bind the registry to an agent identity; a different identity clears it. */
export const setRegistryOwner = (key) => {
  const next = typeof key === 'string' && key.length > 0 ? key : null;
  if (next === owner) return;
  owner = next;
  records.clear();
};

export const hasAcpSession = (sessionId) => records.has(sessionId);

export const getAcpSessionDirectory = (sessionId) => records.get(sessionId)?.directory;

/** Forget a session (deleted on the agent). */
export const removeAcpSession = (sessionId) => { records.delete(sessionId); };

export const acpSessionCount = () => records.size;

/** Directories that have at least one known ACP session. */
export const acpSessionDirectories = () => [...new Set([...records.values()].map((record) => record.directory))];

/** Record (or refresh) one session. `directory` is required for a new record. */
export const upsertAcpSession = ({ id, directory, title, updated }) => {
  if (typeof id !== 'string' || id.length === 0) return;
  const now = Date.now();
  const existing = records.get(id);
  const nextDirectory = typeof directory === 'string' && directory.length > 0 ? directory : existing?.directory;
  if (!nextDirectory) return;
  const nextUpdated = toMillis(updated, existing?.updated ?? now);
  records.set(id, {
    id,
    directory: nextDirectory,
    title: typeof title === 'string' && title.trim().length > 0 ? title : (existing?.title ?? 'ACP session'),
    created: existing?.created ?? Math.min(nextUpdated, now),
    updated: nextUpdated,
  });
};

/** Fold an agent `session/list` answer for `cwd` into the registry. */
export const recordAgentSessions = (agentSessions, cwd) => {
  for (const session of Array.isArray(agentSessions) ? agentSessions : []) {
    upsertAcpSession({
      id: session?.sessionId,
      directory: typeof session?.cwd === 'string' && session.cwd.length > 0 ? session.cwd : cwd,
      title: session?.title,
      updated: session?.updatedAt,
    });
  }
};

const toSessionInfo = (record) => ({
  id: record.id,
  projectID: '',
  title: record.title,
  cost: 0,
  tokens: ZERO_TOKENS,
  time: { created: record.created, updated: record.updated },
  location: { directory: record.directory },
  metadata: { openchamber: { acp: true } },
});

/** The OpenCode 2.x `SessionInfo` for one known session, or null. */
export const getAcpSessionInfo = (sessionId) => {
  const record = records.get(sessionId);
  return record ? toSessionInfo(record) : null;
};

/** `SessionInfo` records for a session list, optionally scoped to a directory and title search. */
export const listAcpSessionInfos = ({ directory, search } = {}) => {
  const needle = typeof search === 'string' ? search.trim().toLowerCase() : '';
  return [...records.values()]
    .filter((record) => !directory || record.directory === directory)
    .filter((record) => !needle || record.title.toLowerCase().includes(needle))
    .sort((a, b) => b.updated - a.updated)
    .map(toSessionInfo);
};

/** Test helper. */
export const _resetAcpSessionRegistry = () => {
  records.clear();
  owner = null;
};
