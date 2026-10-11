/// <reference lib="webworker" />
/**
 * The database worker. Owns the only SQLite connection (the OPFS SAH-pool VFS
 * allows exactly one) and runs all of packages/core. The page talks to it by
 * message; see client.ts.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { Collection, DkError, type SqlDriver } from '@dk/core';
import type { Request, Response, WorkerExtras } from './protocol';

const DB_FILE = '/dk.sqlite3';
const MEDIA_DIR = 'dk-media';

let collection: Collection;
let extras: WorkerExtras;

async function open(): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'dk-pool', directory: '/dk-sqlite', initialCapacity: 8 });
  const db = new pool.OpfsSAHPoolDb(DB_FILE);
  const driver: SqlDriver = {
    async exec(sql, params) {
      const bind = params.map((p) => (typeof p === 'boolean' ? Number(p) : (p ?? null)));
      return db.exec({
        sql,
        bind: bind.length ? (bind as never) : undefined,
        rowMode: 'array',
        returnValue: 'resultRows',
      }) as unknown[][];
    },
  };
  collection = await Collection.open(driver, {
    onChange: () => postMessage({ event: 'change' } satisfies Response),
  });

  const mediaDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(MEDIA_DIR, { create: true });

  extras = {
    async storageInfo() {
      const est = await navigator.storage.estimate();
      const row = (await driver.exec('SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()', []))[0];
      let mediaBytes = 0;
      let mediaFiles = 0;
      for await (const handle of (await mediaDir()).values()) {
        if (handle.kind !== 'file') continue;
        mediaBytes += (await (handle as FileSystemFileHandle).getFile()).size;
        mediaFiles++;
      }
      return {
        vfs: 'opfs-sahpool',
        sqliteVersion: sqlite3.version.libVersion,
        dbBytes: Number(row?.[0] ?? 0),
        mediaBytes,
        mediaFiles,
        usage: est.usage ?? null,
        quota: est.quota ?? null,
        persisted: await navigator.storage.persisted(),
      };
    },
    async probeWrite(value) {
      await driver.exec('CREATE TABLE IF NOT EXISTS storage_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)', []);
      await driver.exec('INSERT INTO storage_probe (value, at) VALUES (?, ?)', [value, Date.now()]);
    },
    async probeRead() {
      const has = await driver.exec("SELECT 1 FROM sqlite_master WHERE name = 'storage_probe'", []);
      if (!has.length) return [];
      const rows = await driver.exec('SELECT value, at FROM storage_probe ORDER BY id DESC LIMIT 20', []);
      return rows.map((r) => ({ value: String(r[0]), at: Number(r[1]) }));
    },
    async addMedia(blob, name) {
      const bytes = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? blob.type.split('/')[1] ?? 'bin').toLowerCase().replace('jpeg', 'jpg');
      const filename = `${hash.slice(0, 16)}.${ext}`;
      const file = await (await mediaDir()).getFileHandle(hash, { create: true });
      const w = await file.createWritable();
      await w.write(bytes);
      await w.close();
      await collection.registerMedia({ id: hash, filename, mime: blob.type || 'application/octet-stream', size: bytes.byteLength });
      return filename;
    },
    async readMedia(filename) {
      const m = await collection.findMedia(filename);
      if (!m) return null;
      try {
        const file = await (await (await mediaDir()).getFileHandle(m.id)).getFile();
        return new Blob([await file.arrayBuffer()], { type: m.mime });
      } catch {
        return null; // Known to the database but not downloaded to this device yet.
      }
    },
  };
}

const ready = open();

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, method, args } = e.data;
  try {
    await ready;
    const target = (method in extras ? extras : collection) as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fn = target[method];
    if (typeof fn !== 'function') throw new Error(`Unknown method: ${method}`);
    const result = await fn.apply(target, args);
    postMessage({ id, ok: true, result } satisfies Response);
  } catch (err) {
    const error = {
      code: err instanceof DkError ? err.code : 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    postMessage({ id, ok: false, error } satisfies Response);
  }
};

ready.then(
  () => postMessage({ event: 'ready' } satisfies Response),
  (err) => postMessage({ event: 'failed', message: err instanceof Error ? err.message : String(err) } satisfies Response),
);
