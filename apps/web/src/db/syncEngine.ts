/// <reference lib="webworker" />
import type { Collection, PullResponse, PushResponse, SyncTransport } from '@dk/core';
import type { SyncStatus } from './protocol';

class HttpError extends Error {
  constructor(public status: number) {
    super(`The server answered ${status}.`);
  }
}

async function call(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) throw new HttpError(res.status);
  return res;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const transport: SyncTransport = {
  push: async (body) => (await call('/api/sync/push', json(body))).json() as Promise<PushResponse>,
  pull: async (since, limit) => (await call(`/api/sync/pull?since=${since}&limit=${limit}`)).json() as Promise<PullResponse>,
};

export interface MediaFiles {
  has(hash: string): Promise<boolean>;
  read(hash: string): Promise<Blob | null>;
  write(hash: string, bytes: ArrayBuffer): Promise<void>;
}

const UPLOADED = 'media_uploaded';
const INTERVAL_MS = 60_000;
const AFTER_CHANGE_MS = 3_000;
const RETRY_MS = 15_000;

/**
 * Keeps this device in step with the server: on start, when connectivity
 * returns, shortly after local changes, and on a timer. Row sync and media
 * sync are separate, and neither ever blocks the UI: the app reads and writes
 * the local database only.
 */
export class SyncEngine {
  private status: SyncStatus = { phase: 'idle', pending: 0, lastSyncedAt: null, error: null };
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private col: Collection,
    private files: MediaFiles,
    private report: (s: SyncStatus) => void,
  ) {}

  start() {
    void this.col.getMetaValue('last_synced_at').then((v) => {
      this.set({ lastSyncedAt: v ? Number(v) : null });
      void this.syncNow();
    });
    self.addEventListener('online', () => void this.syncNow());
    setInterval(() => this.status.phase !== 'signed-out' && void this.syncNow(), INTERVAL_MS);
    // When the server could not be reached, try again sooner than the regular interval.
    setInterval(() => this.status.phase === 'offline' && navigator.onLine && void this.syncNow(), RETRY_MS);
  }

  getStatus = () => this.status;

  private set(patch: Partial<SyncStatus>) {
    this.status = { ...this.status, ...patch };
    this.report(this.status);
  }

  /** Called after any local change: refresh the pending count and sync soon. */
  async onLocalChange() {
    const pending = await this.col.pendingCount();
    this.set({ pending });
    if (!pending || this.status.phase === 'signed-out') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.syncNow(), AFTER_CHANGE_MS);
  }

  /** Runs a sync, or joins the one in progress and asks for another pass after it. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  private async run() {
    clearTimeout(this.timer);
    if (!navigator.onLine) {
      this.set({ phase: 'offline', pending: await this.col.pendingCount() });
      return;
    }
    this.set({ phase: 'syncing', error: null });
    try {
      await this.col.sync(transport);
      // Media goes after the rows, and its failures are not sync failures: the cards are already safe.
      await this.uploadMedia().catch((e) => console.warn('Media upload failed; it will be retried.', e));
      const now = Date.now();
      await this.col.setMetaValue('last_synced_at', String(now));
      this.set({ phase: 'idle', pending: await this.col.pendingCount(), lastSyncedAt: now });
    } catch (e) {
      const pending = await this.col.pendingCount();
      if (e instanceof HttpError && e.status === 401) this.set({ phase: 'signed-out', pending });
      // A failed fetch (TypeError) or a gateway error means the server cannot be reached right now.
      else if (e instanceof TypeError || (e instanceof HttpError && e.status >= 502)) this.set({ phase: 'offline', pending });
      else {
        console.error('Sync failed', e);
        this.set({ phase: 'error', pending, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private async uploadMedia() {
    const uploaded = new Set<string>(JSON.parse((await this.col.getMetaValue(UPLOADED)) ?? '[]') as string[]);
    const candidates: string[] = [];
    for (const m of await this.col.listMedia()) {
      if (!uploaded.has(m.id) && (await this.files.has(m.id))) candidates.push(m.id);
    }
    if (!candidates.length) return;
    const { missing } = (await (await call('/api/media/missing', json({ ids: candidates }))).json()) as { missing: string[] };
    for (const hash of missing) {
      const blob = await this.files.read(hash);
      if (blob) await call(`/api/media/${hash}`, { method: 'PUT', body: blob });
    }
    for (const id of candidates) uploaded.add(id);
    await this.col.setMetaValue(UPLOADED, JSON.stringify([...uploaded]));
  }

  /** Fetches a media file this device does not have yet. Returns false if it cannot be had right now. */
  async downloadMedia(hash: string): Promise<boolean> {
    if (this.status.phase === 'signed-out' || !navigator.onLine) return false;
    try {
      const res = await call(`/api/media/${hash}`);
      await this.files.write(hash, await res.arrayBuffer());
      return true;
    } catch {
      return false;
    }
  }
}
