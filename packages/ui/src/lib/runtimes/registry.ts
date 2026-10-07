import type { SessionRef } from '../runtime-identity';
import { sessionRefKey } from '../runtime-identity';

export interface IndexedSession {
  ref: SessionRef;
  title: string;
  directory: string;
}
export interface RuntimeDriver {
  list(signal: AbortSignal): Promise<IndexedSession[]>;
  activate(): Promise<void>;
  observe(changed: () => void, failed: (error: Error) => void): () => void;
  close(): void;
}
export interface RuntimeView {
  id: string;
  label: string;
  status: 'connecting' | 'ready' | 'error' | 'suspended';
  error: string | null;
  sessions: readonly IndexedSession[];
}
interface RuntimeEntry {
  driver: RuntimeDriver;
  view: RuntimeView;
  stop: () => void;
  pending: AbortController | null;
  observationError: string | null;
}

// Summaries only. The runtime remains authoritative for transcripts, permissions,
// filesystem, and mutations. Each entry owns its connection and request lifetime.
export class RuntimeRegistry {
  private entries = new Map<string, RuntimeEntry>();
  private listeners = new Set<() => void>();
  private snapshot: readonly RuntimeView[] = [];
  private suspended = false;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): readonly RuntimeView[] => this.snapshot;
  private publish(): void {
    this.snapshot = Array.from(this.entries.values(), (entry) => entry.view);
    for (const listener of this.listeners) listener();
  }
  register(id: string, label: string, driver: RuntimeDriver): void {
    const prior = this.entries.get(id);
    prior?.pending?.abort();
    prior?.stop();
    prior?.driver.close();
    const entry: RuntimeEntry = { driver, stop: () => {}, pending: null, observationError: null,
      view: { id, label, status: 'connecting', error: null, sessions: prior?.view.sessions ?? [] } };
    this.entries.set(id, entry);
    this.publish();
    if (!this.suspended) this.start(entry);
  }
  private start(entry: RuntimeEntry): void {
    entry.stop = entry.driver.observe(() => { void this.refresh(entry.view.id); }, (error) => {
      if (this.entries.get(entry.view.id) !== entry || this.suspended) return;
      entry.observationError = error.message;
      entry.view = { ...entry.view, status: 'error', error: error.message };
      this.publish();
    });
    void this.refresh(entry.view.id);
  }
  async refresh(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || this.suspended) return;
    entry.pending?.abort();
    const request = new AbortController();
    entry.pending = request;
    try {
      const sessions = await entry.driver.list(request.signal);
      if (request.signal.aborted || this.entries.get(id) !== entry) return;
      const keys = new Set<string>();
      for (const session of sessions) {
        if (session.ref.runtimeId !== id) throw new Error('Session index returned a different runtime owner');
        const key = sessionRefKey(session.ref);
        if (keys.has(key)) throw new Error('Session index returned a duplicate qualified identity');
        keys.add(key);
      }
      entry.view = { ...entry.view, status: entry.observationError ? 'error' : 'ready', error: entry.observationError, sessions };
    } catch (error) {
      if (request.signal.aborted || this.entries.get(id) !== entry) return;
      entry.view = { ...entry.view, status: 'error', error: error instanceof Error ? error.message : 'Session index unavailable' };
    } finally {
      if (entry.pending === request) { entry.pending = null; this.publish(); }
    }
  }
  reconnect(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.suspended) return;
    entry.pending?.abort(); entry.stop(); entry.driver.close();
    entry.observationError = null;
    this.start(entry);
  }
  async activate(ref: SessionRef): Promise<void> {
    const entry = this.entries.get(ref.runtimeId);
    if (!entry || !entry.view.sessions.some((session) => sessionRefKey(session.ref) === sessionRefKey(ref))) {
      throw new Error('Session owner is unavailable');
    }
    await entry.driver.activate();
  }
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.pending?.abort(); entry.stop(); entry.driver.close();
    this.entries.delete(id); this.publish();
  }
  setSuspended(value: boolean): void {
    if (this.suspended === value) return;
    this.suspended = value;
    for (const entry of this.entries.values()) {
      if (value) {
        entry.pending?.abort(); entry.stop(); entry.driver.close();
        entry.view = { ...entry.view, status: 'suspended' };
      } else { entry.observationError = null; this.start(entry); }
    }
    this.publish();
  }
}
export const runtimeRegistry = new RuntimeRegistry();
