import { expect, it } from 'vitest';
import { createGlobalMessageStreamHub } from './global-hub.js';
import { createOpenCodeAutomationEventHub } from './opencode-automation-hub.js';
it('keeps same-native-ID ACP events out of OpenCode automation while clients receive both', () => {
  const hub = createGlobalMessageStreamHub({ buildOpenCodeUrl: () => 'http://unused', getOpenCodeAuthHeaders: () => ({}) });
  const clients = []; const automation = [];
  const stopClient = hub.subscribeEvent(event => clients.push(event.backendId));
  const stopAutomation = createOpenCodeAutomationEventHub(hub).subscribeEvent(event => automation.push(event.backendId));
  const payload = { type: 'session.execution.started', data: { sessionID: 'ses_same' } };
  hub.injectEvent({ payload, directory: '/tmp' });
  hub.publishEvent(payload, { directory: '/tmp' });
  hub.flushPending();
  expect(clients).toEqual(['opencode', 'acp']);
  expect(automation).toEqual(['opencode']);
  stopAutomation(); stopClient(); hub.stop();
});
