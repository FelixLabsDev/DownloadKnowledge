/// <reference lib="webworker" />
/**
 * The database worker. Owns the only SQLite connection (the OPFS SAH-pool VFS
 * allows exactly one) and runs all of packages/core. The page talks to it by
 * message; see client.ts.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { BASIC_ID, CLOZE_ID, Collection, DAY_MS, DkError, type Rating, type SqlDriver } from '@dk/core';
import type { Request, Response, WorkerExtras } from './protocol';
import { importApkg } from './apkg';
import { SyncEngine, type MediaFiles } from './syncEngine';

const DB_FILE = '/dk.sqlite3';
const MEDIA_DIR = 'dk-media';

let collection: Collection;
let extras: WorkerExtras;

async function open(): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  // A worker from the page's previous life (a reload) can take a moment to let go of its file handles.
  let pool: Awaited<ReturnType<typeof sqlite3.installOpfsSAHPoolVfs>> | undefined;
  for (let attempt = 0; !pool; attempt++) {
    try {
      // forceReinitIfPreviouslyFailed is supported by the library but missing from its type definitions.
      const options = { name: 'dk-pool', directory: '/dk-sqlite', initialCapacity: 8, forceReinitIfPreviouslyFailed: true };
      pool = await sqlite3.installOpfsSAHPoolVfs(options);
    } catch (e) {
      if (attempt >= 20) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
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
  // Filled in below; the collection must exist before the engine can.
  const ref: { engine?: SyncEngine } = {};
  // Only devSeed moves this: it lets months of study be simulated in seconds.
  let clockOffset = 0;
  collection = await Collection.open(driver, {
    now: () => Date.now() + clockOffset,
    onChange: () => {
      postMessage({ event: 'change' } satisfies Response);
      void ref.engine?.onLocalChange();
    },
  });

  const mediaDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(MEDIA_DIR, { create: true });
  const files: MediaFiles = {
    async has(hash) {
      return (await mediaDir()).getFileHandle(hash).then(() => true, () => false);
    },
    async read(hash) {
      try {
        return await (await (await mediaDir()).getFileHandle(hash)).getFile();
      } catch {
        return null;
      }
    },
    async write(hash, bytes) {
      const w = await (await (await mediaDir()).getFileHandle(hash, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
    },
  };
  const sync = new SyncEngine(collection, files, (status) => postMessage({ event: 'sync', status } satisfies Response));
  ref.engine = sync;

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
      await files.write(hash, bytes);
      await collection.registerMedia({ id: hash, filename, mime: blob.type || 'application/octet-stream', size: bytes.byteLength });
      return filename;
    },
    async readMedia(filename) {
      const m = await collection.findMedia(filename);
      if (!m) return null;
      // Media is fetched lazily: the first time a card needs a file this device does not have.
      let file = await files.read(m.id);
      if (!file && (await sync.downloadMedia(m.id))) file = await files.read(m.id);
      return file ? new Blob([await file.arrayBuffer()], { type: m.mime }) : null;
    },
    importApkg: (file, opts) =>
      importApkg(sqlite3, collection, files, file, opts, (progress) => postMessage({ event: 'progress', progress } satisfies Response)),
    async devSeed(days) {
      const col = collection;
      const spanish = await col.ensureDeckPath('Sample::Spanish');
      const capitals = await col.ensureDeckPath('Sample::Capitals');
      const biology = await col.ensureDeckPath('Sample biology');
      await col.updateDeck(spanish.id, { newPerDay: 4 });
      await col.updateDeck(capitals.id, { newPerDay: 3 });
      await col.updateDeck(biology.id, { newPerDay: 2 });
      clockOffset = -days * DAY_MS;
      let notes = 0;
      for (let i = 1; i <= 150; i++, notes++) await col.addNote({ noteTypeId: BASIC_ID, deckId: spanish.id, fields: [`palabra ${i}`, `word ${i}`], tags: ['sample'] });
      for (let i = 1; i <= 80; i++, notes++) await col.addNote({ noteTypeId: CLOZE_ID, deckId: capitals.id, fields: [`The capital of country ${i} is {{c1::city ${i}}}.`, ''], tags: ['sample'] });
      for (let i = 1; i <= 60; i++, notes++) await col.addNote({ noteTypeId: BASIC_ID, deckId: biology.id, fields: [`Term ${i}`, `Definition ${i}`], tags: ['sample'] });
      const sample = await col.ensureDeckPath('Sample');
      let reviews = 0;
      for (let day = days; day >= 0; day--) {
        if (day > 0 && Math.random() < 0.12) continue; // A day off now and then.
        clockOffset = -day * DAY_MS;
        for (const deckId of [sample.id, biology.id]) {
          for (let guard = 0; guard < 120; guard++) {
            const step = await col.nextStudyStep(deckId);
            if (!step.card) {
              if (step.waitUntil === null) break;
              clockOffset += step.waitUntil - (Date.now() + clockOffset);
              continue;
            }
            const roll = Math.random();
            const rating: Rating = roll < 0.09 ? 1 : roll < 0.2 ? 2 : roll < 0.88 ? 3 : 4;
            await col.answerCard(step.card.card.id, rating, 4000 + Math.random() * 8000);
            clockOffset += 9000;
            reviews++;
          }
        }
      }
      clockOffset = 0;
      return { notes, reviews };
    },
    async syncNow() {
      await sync.syncNow();
      return sync.getStatus();
    },
    syncStatus: async () => sync.getStatus(),
  };
  sync.start();
}

/**
 * Only one worker may own the database. This worker holds a Web Lock for as
 * long as it lives, so the lock and the file handles are released together.
 * If another tab has it, say so and take over when that tab goes away.
 */
const ready = new Promise<void>((resolve, reject) => {
  const openAndHold = () => new Promise<never>(() => void open().then(resolve, reject));
  if (!navigator.locks) {
    void open().then(resolve, reject);
    return;
  }
  void navigator.locks.request('dk-db', { ifAvailable: true }, (lock) => {
    if (lock) return openAndHold();
    postMessage({ event: 'blocked' } satisfies Response);
    void navigator.locks.request('dk-db', openAndHold);
    return undefined;
  });
});

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
