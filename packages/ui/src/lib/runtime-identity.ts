import { z } from 'zod';

// IDs identify owners, never endpoints or credentials. Changing transport does
// not change the runtime ID; changing agent configuration changes backend ID.
const ownerId = z.string().min(1).max(512);
export const sessionRefSchema = z.object({
  runtimeId: ownerId,
  backendId: ownerId,
  sessionId: ownerId,
  projectId: ownerId.optional(),
});
export type RuntimeId = string;
export type BackendId = string;
export type SessionRef = z.infer<typeof sessionRefSchema>;
export interface ProjectRef {
  runtimeId: RuntimeId;
  projectId: string;
}

// Tuple encoding avoids delimiter collisions and does not include projectId:
// moving a session between projects must preserve its identity.
export const sessionRefKey = (ref: SessionRef): string =>
  JSON.stringify([ref.runtimeId, ref.backendId, ref.sessionId]);
export const projectRefKey = (ref: ProjectRef): string =>
  JSON.stringify([ref.runtimeId, ref.projectId]);

export const sessionOwnerQuery = (ref: SessionRef): URLSearchParams => {
  const query = new URLSearchParams({ runtime: ref.runtimeId, backend: ref.backendId });
  if (ref.projectId) query.set('project', ref.projectId);
  return query;
};

// An incomplete owner must not silently become a legacy local link.
export const parseSessionOwner = (query: URLSearchParams, sessionId: string): SessionRef | null => {
  const parsed = sessionRefSchema.safeParse({
    runtimeId: query.get('runtime'), backendId: query.get('backend'),
    sessionId, projectId: query.get('project') ?? undefined,
  });
  return parsed.success ? parsed.data : null;
};
