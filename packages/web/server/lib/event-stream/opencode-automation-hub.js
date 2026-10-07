// These consumers issue OpenCode API mutations. ACP events stay on the shared
// client/notification stream but must never drive OpenCode-only automation.
export const createOpenCodeAutomationEventHub = (hub) => ({
  subscribeEvent: (listener) => hub.subscribeEvent((event) => {
    if (event.backendId === 'opencode') listener(event);
  }),
  subscribeStatus: (listener) => hub.subscribeStatus(listener),
  isConnected: () => hub.isConnected(),
});
