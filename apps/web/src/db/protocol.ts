import type { Collection } from '@dk/core';

export interface Request {
  id: number;
  method: string;
  args: unknown[];
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }
  | { event: 'ready' }
  | { event: 'failed'; message: string }
  | { event: 'change' }
  | { event: 'sync'; status: SyncStatus };

export interface SyncStatus {
  /** `offline` also covers "the server cannot be reached". */
  phase: 'idle' | 'syncing' | 'offline' | 'signed-out' | 'error';
  /** Local changes not yet on the server. */
  pending: number;
  lastSyncedAt: number | null;
  error: string | null;
}

export interface StorageInfo {
  vfs: string;
  sqliteVersion: string;
  dbBytes: number;
  mediaBytes: number;
  mediaFiles: number;
  usage: number | null;
  quota: number | null;
  persisted: boolean;
}

/** Things the worker does that are about the browser rather than the collection. */
export interface WorkerExtras {
  storageInfo(): Promise<StorageInfo>;
  /** Storage self-test: writes a row outside the collection's tables. */
  probeWrite(value: string): Promise<void>;
  probeRead(): Promise<{ value: string; at: number }[]>;
  /** Stores a file and returns the filename to reference from a field. */
  addMedia(blob: Blob, name: string): Promise<string>;
  readMedia(filename: string): Promise<Blob | null>;
  syncNow(): Promise<SyncStatus>;
  syncStatus(): Promise<SyncStatus>;
}

type Fn = (...args: never[]) => unknown;
type Methods<T> = { [K in keyof T as T[K] extends Fn ? K : never]: T[K] };

/** What the page can call: the collection's methods plus the worker extras. */
export type Api = Omit<Methods<Collection>, 'run' | 'sync' | 'applyPush' | 'readChanges' | 'purgeDeleted'> & WorkerExtras;
