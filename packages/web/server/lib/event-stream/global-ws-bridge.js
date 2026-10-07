import { sendMessageStreamWsEvent, sendMessageStreamWsFrame, sendSerializedMessageStreamWsFrame, serializeMessageStreamWsEvent } from './protocol.js';

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
}

export function createGlobalMessageStreamWsBridge({
  globalHub,
  ownsGlobalHub,
  wsClients,
  processForwardedEventPayload,
  triggerHealthCheck,
  heartbeatIntervalMs,
}) {
  const clients = new Set();
  const clientLastEventIds = new Map();
  const readyClients = new Set();
  // Health checks fire once per upstream outage, not once per retry.
  let upstreamHealthCheckTriggered = false;

  const removeClient = (socket) => {
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    wsClients.delete(socket);
  };

  const replayEvents = (socket, entries) => {
    for (const entry of entries) {
      const sent = sendSerializedMessageStreamWsFrame(socket, entry.serializedFrame);
      if (!sent) {
        removeClient(socket);
        return;
      }
    }
  };

  const markReady = (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    globalHub.flushPending();
    const replay = globalHub.replayAfter(requestedLastEventId);
    const ready = { type: 'ready', scope: 'global' };
    if (replay === null) ready.replayReset = true;
    const sent = sendMessageStreamWsFrame(socket, ready);
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    if (replay !== null) replayEvents(socket, replay);
  };

  const stopHubIfUnused = () => {
    if (ownsGlobalHub && clients.size === 0) {
      globalHub.stop();
    }
  };

  // Browser clients take the events of isolated spaces too: each frame carries its directory,
  // and a space's directory is one more project directory to the UI.
  const unsubscribeEvent = globalHub.subscribeEvent((event) => {
    const { payload } = event;
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      const sent = sendSerializedMessageStreamWsFrame(socket, event.serialize());
      if (!sent) {
        removeClient(socket);
      }
    }

    processForwardedEventPayload(payload, (syntheticPayload) => {
      if (readyClients.size === 0) return;
      const serializedFrame = serializeMessageStreamWsEvent(syntheticPayload, { directory: 'global' });
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          continue;
        }
        const sent = sendSerializedMessageStreamWsFrame(socket, serializedFrame);
        if (!sent) {
          removeClient(socket);
        }
      }
    });
  }, { spaces: true });

  const unsubscribeStatus = globalHub.subscribeStatus((status) => {
    if (status.type === 'connect') {
      upstreamHealthCheckTriggered = false;
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          markReady(socket, clientLastEventIds.get(socket) ?? '');
          continue;
        }

        if (status.wasReady) {
          const sent = sendMessageStreamWsFrame(socket, {
            type: 'ready',
            scope: 'global',
          });
          if (!sent) {
            removeClient(socket);
          }
        }
      }
      return;
    }

    if (status.type === 'initial-error') {
      // Upstream (OpenCode) is unavailable, but the OpenChamber stream itself
      // is alive and still carries locally published events (e.g. ACP
      // sessions). Keep clients connected instead of closing them into a
      // reconnect storm; the upstream reader keeps retrying in the background
      // and a later 'connect' status re-marks readiness with replay. The
      // failure stays observable through the health endpoints.
      let shouldTrigger = false;
      if (!upstreamHealthCheckTriggered) {
        if (status.error?.response) {
          shouldTrigger = shouldTriggerUpstreamHealthCheck(status.error.response);
        } else {
          // URL build failures retry with the same mechanism; no health probe.
          shouldTrigger = !status.buildUrlFailed;
        }
      }
      if (shouldTrigger) {
        upstreamHealthCheckTriggered = true;
        triggerHealthCheck?.();
      }
      return;
    }

    if (status.type === 'error' && status.error?.type === 'stream_error') {
      console.warn('Message stream WS proxy error:', status.error.error);
    }
  });

  const accept = (socket, { requestedLastEventId = '' } = {}) => {
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, heartbeatIntervalMs);

    const heartbeatInterval = setInterval(() => {
      if (!globalHub.isConnected()) {
        return;
      }

      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      removeClient(socket);
      stopHubIfUnused();
    });

    socket.on('error', () => {
      void 0;
    });

    clients.add(socket);
    clientLastEventIds.set(socket, requestedLastEventId);
    globalHub.start();
    // Mark the client ready immediately: the hub also carries locally
    // published events (ACP sessions) that must flow while the OpenCode
    // upstream is still connecting. Upstream events start flowing once the
    // reader connects and a 'connect' status re-marks readiness with replay.
    markReady(socket, requestedLastEventId);
  };

  const close = () => {
    unsubscribeEvent();
    unsubscribeStatus();
    if (ownsGlobalHub) {
      globalHub.stop();
    }
    for (const socket of Array.from(clients)) {
      removeClient(socket);
    }
  };

  return {
    accept,
    close,
  };
}
