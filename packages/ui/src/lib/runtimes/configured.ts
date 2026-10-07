import { desktopHostsGet, desktopLocalClientTokenGet, getDesktopHostApiUrl, type DesktopHost } from '../desktopHosts';
import { buildLocalDesktopHost, runtimeKeyForDesktopHost } from '../desktopCurrentHost';
import { isDesktopShell, isVSCodeRuntime } from '../desktop';
import { isCapacitorApp } from '../platform';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '../runtime-switch';
import { loadMobileRuntimeOwners, prepareMobileRuntimeConnection } from '@/apps/mobileConnections';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '../runtime-auth';
import { createRuntimeDriver, type RuntimeConnection } from './connection';
import { runtimeRegistry, type RuntimeDriver } from './registry';

export const unifiedRuntimesEnabled = import.meta.env.VITE_OPENCHAMBER_MULTIRUNTIME === '1';

// Native/mobile preparation is lazy and independently fallible. A Keychain or
// probe failure becomes that runtime's visible error, not an empty global list.
const deferredDriver = (prepare: () => Promise<RuntimeConnection>): RuntimeDriver => {
  let driver: RuntimeDriver | null = null;
  let preparing: Promise<RuntimeDriver> | null = null;
  let generation = 0;
  const ready = (): Promise<RuntimeDriver> => {
    if (driver) return Promise.resolve(driver);
    if (preparing) return preparing;
    const current = generation;
    preparing = prepare().then((connection) => {
      if (generation !== current) throw new Error('Runtime connection was retired');
      driver = createRuntimeDriver(connection);
      return driver;
    }).finally(() => { if (generation === current) preparing = null; });
    return preparing;
  };
  return {
    list: async (signal) => (await ready()).list(signal),
    activate: async () => (await ready()).activate(),
    observe: (changed, failed) => {
      let disposed = false;
      let stop = () => {};
      void ready().then((connection) => {
        if (!disposed) stop = connection.observe(changed, failed);
      }).catch((error) => { if (!disposed) failed(error instanceof Error ? error : new Error('Runtime unavailable')); });
      return () => { disposed = true; stop(); };
    },
    close: () => { generation += 1; driver?.close(); driver = null; preparing = null; },
  };
};
const desktopConnection = (host: DesktopHost): RuntimeConnection => {
  const id = runtimeKeyForDesktopHost(host);
  const baseUrl = host.relay && !host.apiUrl ? 'http://openchamber.runtime' : getDesktopHostApiUrl(host);
  const options = { apiBaseUrl: baseUrl, runtimeKey: id, clientToken: host.clientToken,
    requestHeaders: host.requestHeaders, relay: host.relay && !host.apiUrl ? host.relay : undefined };
  return { id, baseUrl, clientToken: host.clientToken, headers: host.requestHeaders,
    relay: host.relay && !host.apiUrl ? host.relay : undefined,
    activate: async () => { if (getRuntimeKey() !== id) switchRuntimeEndpoint(options); },
  };
};

// Fingerprints stay in memory; credentials are never persisted or logged here.
const connectionFingerprints = new Map<string, string>();
let configuredLoad: Promise<void> | null = null;
export const loadConfiguredRuntimes = (): Promise<void> => {
  if (configuredLoad) return configuredLoad;
  configuredLoad = (async () => {
    if (!unifiedRuntimesEnabled || isVSCodeRuntime()) return;
    const ids = new Set<string>();
    if (isCapacitorApp()) {
      for (const owner of await loadMobileRuntimeOwners()) {
        ids.add(owner.id);
        if (!runtimeRegistry.getSnapshot().some((entry) => entry.id === owner.id)) {
          runtimeRegistry.register(owner.id, owner.label, deferredDriver(() => prepareMobileRuntimeConnection(owner.savedId)));
        }
      }
    } else if (isDesktopShell()) {
      const config = await desktopHostsGet();
      const local = buildLocalDesktopHost(config.localOrigin);
      local.clientToken = await desktopLocalClientTokenGet();
      for (const host of [local, ...config.hosts]) {
        const connection = desktopConnection(host);
        ids.add(connection.id);
        const fingerprint = JSON.stringify([host.label, connection.baseUrl, connection.clientToken, connection.headers, connection.relay]);
        if (connectionFingerprints.get(connection.id) !== fingerprint || !runtimeRegistry.getSnapshot().some((entry) => entry.id === connection.id)) {
          connectionFingerprints.set(connection.id, fingerprint);
          runtimeRegistry.register(connection.id, host.label, createRuntimeDriver(connection));
        }
      }
    } else {
      const id = getRuntimeKey();
      ids.add(id);
      const baseUrl = getRuntimeApiBaseUrl() || window.location.origin;
      const clientToken = getRuntimeBearerTokenSync();
      const headers = getRuntimeExtraHeadersSync();
      if (!runtimeRegistry.getSnapshot().some((entry) => entry.id === id)) {
        runtimeRegistry.register(id, window.location.host, createRuntimeDriver({ id, baseUrl, clientToken, headers,
          activate: async () => { if (getRuntimeKey() !== id) switchRuntimeEndpoint({ apiBaseUrl: baseUrl, runtimeKey: id, clientToken, requestHeaders: headers }); } }));
      }
    }
    for (const entry of runtimeRegistry.getSnapshot()) if (!ids.has(entry.id)) {
      runtimeRegistry.remove(entry.id);
      connectionFingerprints.delete(entry.id);
    }
  })().finally(() => { configuredLoad = null; });
  return configuredLoad;
};
