import { z } from 'zod';
const invalidSessionParams = z.object({ _tag: z.literal('InvalidRequestError'), kind: z.literal('Params') });
const sessionResponse = z.object({ data: z.object({ id: z.string() }) });
// Probe OpenCode directly, bypassing our ACP overlay. Invalid native ID params
// cannot identify an OpenCode session; other failures leave ownership unknown.
export const createOpenCodeSessionOwnershipProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }) => async (sessionId) => {
  const response = await fetch(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, ''), {
    headers: { ...getOpenCodeAuthHeaders(), Accept: 'application/json' }, signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) return false;
  const body = await response.json();
  if (response.status === 400 && invalidSessionParams.safeParse(body).success) return false;
  const session = sessionResponse.safeParse(body);
  if (!response.ok || !session.success || session.data.data.id !== sessionId) throw new Error('OpenCode ownership probe failed');
  return true;
};
