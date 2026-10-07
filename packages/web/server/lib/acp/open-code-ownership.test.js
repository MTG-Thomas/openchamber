import { createServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { createOpenCodeSessionOwnershipProbe } from './open-code-ownership.js';
const server = createServer((req, res) => {
  const id = decodeURIComponent(req.url.split('/').at(-1));
  res.setHeader('Content-Type', 'application/json');
  if (req.headers.authorization !== 'Basic fixture' || !req.url.startsWith('/api/session/')) {
    res.writeHead(401); res.end('{}'); return;
  }
  const fixtures = {
    uuid: [400, { _tag: 'InvalidRequestError', kind: 'Params' }],
    ses_missing: [404, {}],
    ses_found: [200, { data: { id: 'ses_found' } }],
    ses_broken: [500, {}],
    ses_wrong: [200, { data: { id: 'ses_other' } }],
  };
  const [status, body] = fixtures[id]; res.writeHead(status); res.end(JSON.stringify(body));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise(resolve => server.close(resolve)));
const probe = createOpenCodeSessionOwnershipProbe({
  buildOpenCodeUrl: path => `http://127.0.0.1:${server.address().port}${path}`,
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic fixture' }),
});
describe('OpenCode ownership HTTP boundary', () => {
  it('rejects collisions, accepts absent IDs and invalid OpenCode-native IDs', async () => {
    expect(await probe('uuid')).toBe(false);
    expect(await probe('ses_missing')).toBe(false);
    expect(await probe('ses_found')).toBe(true);
  });
  it('does not interpret failures or a different session as absence', async () => {
    await expect(probe('ses_broken')).rejects.toThrow();
    await expect(probe('ses_wrong')).rejects.toThrow();
  });
});
