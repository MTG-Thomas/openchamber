import { z } from 'zod';
import { createRelayTunnelClient, type RelayTunnelClient } from '../relay/tunnel-client';
import type { RelayRuntimeDescriptor } from '../relay/runtime-tunnel';
import { addRuntimeProxyHeaders } from '../runtime-fetch';
import { listRuntimeSessionIndex } from '../opencode/runtime-index';
import type { RuntimeDriver } from './registry';

export interface RuntimeConnection {
  id: string;
  baseUrl: string;
  clientToken?: string;
  headers?: Record<string, string>;
  relay?: RelayRuntimeDescriptor;
  activate(): Promise<void>;
}
const indexEvent = z.object({ type: z.string() });
const changedTypes = new Set(['session.created', 'session.updated', 'session.deleted', 'session.execution.started',
  'session.execution.succeeded', 'session.execution.failed', 'session.execution.cancelled']);

// Explicit configured owner, with its own headers and tunnel. Never reads or
// changes the foreground resolver/auth singleton for background traffic.
export const createRuntimeDriver = (connection: RuntimeConnection): RuntimeDriver => {
  const base = new URL(connection.baseUrl);
  let tunnel: RelayTunnelClient | null = null;
  let observation: AbortController | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const ownedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/api/`)) {
      throw new Error('Runtime request escaped its configured owner');
    }
    const headers = new Headers(request.headers);
    for (const [key, value] of Object.entries(connection.headers ?? {})) headers.set(key, value);
    if (connection.clientToken) headers.set('Authorization', `Bearer ${connection.clientToken}`);
    addRuntimeProxyHeaders(request.url, headers);
    const authenticated = new Request(request, { headers });
    if (connection.relay) {
      tunnel ??= createRelayTunnelClient(connection.relay);
      return tunnel.fetch(authenticated);
    }
    return fetch(authenticated);
  };
  const close = () => {
    observation?.abort(); observation = null;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    tunnel?.close(); tunnel = null;
  };
  return {
    list: (signal) => listRuntimeSessionIndex(connection.id, connection.baseUrl, ownedFetch, AbortSignal.any([signal, AbortSignal.timeout(15000)])),
    activate: connection.activate,
    close,
    observe: (changed, failed) => {
      observation?.abort();
      const controller = new AbortController();
      observation = controller;
      const notify = () => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; changed(); }, 250);
      };
      void (async () => {
        const url = `${connection.baseUrl.replace(/\/$/, '')}/api/event`;
        const response = await ownedFetch(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`Runtime events unavailable (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        try {
          while (!controller.signal.aborted) {
            const result = await reader.read();
            if (result.done) throw new Error('Runtime event connection closed; reconnect to refresh');
            pending += decoder.decode(result.value, { stream: true });
            pending = pending.replace(/\r\n/g, '\n');
            if (pending.length > 1024 * 1024) throw new Error('Runtime event exceeded the index buffer limit');
            let boundary = pending.indexOf('\n\n');
            while (boundary !== -1) {
              const frame = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
              if (data) {
                const event = indexEvent.safeParse(JSON.parse(data));
                if (event.success && changedTypes.has(event.data.type)) notify();
              }
              boundary = pending.indexOf('\n\n');
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      })().catch((error) => { if (!controller.signal.aborted) failed(error instanceof Error ? error : new Error('Runtime events unavailable')); });
      return () => { controller.abort(); if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = null; };
    },
  };
};
