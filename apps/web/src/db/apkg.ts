/// <reference lib="webworker" />
/**
 * Reads an Anki .apkg in the worker and feeds it to core's AnkiImport.
 *
 * An .apkg is a zip holding a SQLite collection and media files named 0, 1, 2…
 * with a map from those numbers to real filenames. Two generations exist:
 *
 *   older: collection.anki2 or collection.anki21; the media map is JSON.
 *   newer: collection.anki21b, zstd-compressed, with note types, templates and
 *          decks in their own tables (config as protobuf); the media map is
 *          zstd-compressed protobuf and each media file is zstd-compressed.
 *
 * Nothing is held in memory whole except the collection file itself: zip
 * entries are read one at a time from the File, and rows are read in pages.
 */
import { AnkiImport, type AnkiCard, type AnkiImportSummary, type AnkiModel, type AnkiNote, type AnkiReview, type Collection } from '@dk/core';
import type { Database, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { decompress as zstd } from 'fzstd';
import type { MediaFiles } from './syncEngine';

// Zip ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  headerOffset: number;
}

async function readZipDirectory(file: Blob): Promise<Map<string, ZipEntry>> {
  const tailSize = Math.min(file.size, 65_557);
  const tail = new DataView(await file.slice(file.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file is not a zip archive, so it is not an Anki package.');
  const count = tail.getUint16(eocd + 10, true);
  const size = tail.getUint32(eocd + 12, true);
  const offset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('This package is larger than 4 GB (zip64), which is not supported.');
  const dir = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const entries = new Map<string, ZipEntry>();
  const utf8 = new TextDecoder();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= dir.byteLength; i++) {
    if (dir.getUint32(p, true) !== 0x02014b50) break;
    const nameLen = dir.getUint16(p + 28, true);
    const name = utf8.decode(new Uint8Array(dir.buffer, p + 46, nameLen));
    entries.set(name, {
      name,
      method: dir.getUint16(p + 10, true),
      compressedSize: dir.getUint32(p + 20, true),
      headerOffset: dir.getUint32(p + 42, true),
    });
    p += 46 + nameLen + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
  }
  return entries;
}

async function readZipEntry(file: Blob, e: ZipEntry): Promise<Uint8Array> {
  const head = new DataView(await file.slice(e.headerOffset, e.headerOffset + 30).arrayBuffer());
  if (head.getUint32(0, true) !== 0x04034b50) throw new Error(`The package is damaged (entry "${e.name}").`);
  const start = e.headerOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const body = file.slice(start, start + e.compressedSize);
  if (e.method === 0) return new Uint8Array(await body.arrayBuffer());
  if (e.method !== 8) throw new Error(`The package uses a compression method this app cannot read (entry "${e.name}").`);
  const stream = body.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Protobuf: just enough to read strings, bytes and varints by field number -------------

function protoFields(buf: Uint8Array): { field: number; value: number | Uint8Array }[] {
  const out: { field: number; value: number | Uint8Array }[] = [];
  let p = 0;
  const varint = () => {
    let v = 0;
    let shift = 1;
    for (;;) {
      const b = buf[p++]!;
      v += (b & 0x7f) * shift;
      shift *= 128;
      if (b < 128 || p >= buf.length) return v;
    }
  };
  while (p < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) out.push({ field, value: varint() });
    else if (wire === 2) {
      const len = varint();
      out.push({ field, value: buf.subarray(p, p + len) });
      p += len;
    } else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else break;
  }
  return out;
}

const utf8 = new TextDecoder();
function protoString(buf: Uint8Array, field: number): string {
  const f = protoFields(buf).find((x) => x.field === field);
  return f && typeof f.value !== 'number' ? utf8.decode(f.value) : '';
}
function protoNumber(buf: Uint8Array, field: number): number {
  const f = protoFields(buf).find((x) => x.field === field);
  return f && typeof f.value === 'number' ? f.value : 0;
}

// Reading the collection ---------------------------------------------------------------

type Row = Record<string, unknown>;
const rows = (db: Database, sql: string, bind: (string | number)[] = []): Row[] =>
  db.exec({ sql, bind: bind.length ? bind : undefined, rowMode: 'object', returnValue: 'resultRows' }) as Row[];
const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array());

function readModels(db: Database, modern: boolean): AnkiModel[] {
  if (!modern) {
    const json = JSON.parse(String(rows(db, 'SELECT models FROM col')[0]?.models ?? '{}')) as Record<
      string,
      { id: number | string; name: string; type: number; css: string; flds: { name: string; ord: number }[]; tmpls: { name: string; ord: number; qfmt: string; afmt: string }[] }
    >;
    return Object.values(json).map((m) => ({
      id: String(m.id),
      name: m.name,
      kind: m.type === 1 ? 'cloze' : 'standard',
      css: m.css ?? '',
      fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
      templates: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({ ord: t.ord, name: t.name, front: t.qfmt, back: t.afmt })),
    }));
  }
  const fields = rows(db, 'SELECT ntid, ord, name FROM fields ORDER BY ntid, ord');
  const templates = rows(db, 'SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord');
  return rows(db, 'SELECT id, name, config FROM notetypes').map((nt) => {
    const id = String(nt.id);
    const config = bytes(nt.config);
    return {
      id,
      name: String(nt.name),
      kind: protoNumber(config, 1) === 1 ? 'cloze' : 'standard',
      css: protoString(config, 3),
      fields: fields.filter((f) => String(f.ntid) === id).map((f) => String(f.name)),
      templates: templates
        .filter((t) => String(t.ntid) === id)
        .map((t) => ({ ord: Number(t.ord), name: String(t.name), front: protoString(bytes(t.config), 1), back: protoString(bytes(t.config), 2) })),
    };
  });
}

function readDecks(db: Database, modern: boolean) {
  if (!modern) {
    const json = JSON.parse(String(rows(db, 'SELECT decks FROM col')[0]?.decks ?? '{}')) as Record<string, { id: number | string; name: string }>;
    return Object.values(json).map((d) => ({ id: String(d.id), name: d.name }));
  }
  // The newer schema separates the levels of a deck path with the unit-separator character.
  return rows(db, 'SELECT id, name FROM decks').map((d) => ({ id: String(d.id), name: String(d.name).split('\u001f').join('::') }));
}

export interface ImportProgress {
  phase: string;
  done: number;
  total: number;
}

const PAGE = 500;

export async function importApkg(
  sqlite3: Sqlite3Static,
  col: Collection,
  files: MediaFiles,
  file: Blob,
  opts: { keepScheduling: boolean },
  progress: (p: ImportProgress) => void,
): Promise<AnkiImportSummary> {
  progress({ phase: 'Opening the package', done: 0, total: 1 });
  const zip = await readZipDirectory(file);
  const entry = zip.get('collection.anki21b') ?? zip.get('collection.anki21') ?? zip.get('collection.anki2');
  if (!entry) throw new Error('No Anki collection was found in this file. Export from Anki as "Anki Deck Package (.apkg)".');
  const compressed = entry.name.endsWith('.anki21b');
  let data = await readZipEntry(file, entry);
  if (compressed) data = zstd(data);

  // Open the collection as an in-memory database.
  const db = new sqlite3.oo1.DB(':memory:');
  try {
    const p = sqlite3.wasm.allocFromTypedArray(data);
    const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_READONLY;
    const rc = sqlite3.capi.sqlite3_deserialize(db.pointer!, 'main', p, data.byteLength, data.byteLength, flags);
    data = new Uint8Array(); // Let the JS copy go; SQLite has its own now.
    if (rc) throw new Error('The collection inside this package could not be opened.');
    // Anki's own collation, used by some of its indexes.
    try {
      sqlite3.capi.sqlite3_create_collation_v2(db.pointer!, 'unicase', sqlite3.capi.SQLITE_UTF8, 0, (_ctx: number, l1: number, p1: number, l2: number, p2: number) => {
        const heap = sqlite3.wasm.heap8u();
        const a = utf8.decode(heap.slice(p1, p1 + l1)).toLowerCase();
        const b = utf8.decode(heap.slice(p2, p2 + l2)).toLowerCase();
        return a < b ? -1 : a > b ? 1 : 0;
      }, 0);
    } catch {
      // Only needed for sorted queries on those columns, which we avoid.
    }

    const modern = rows(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'notetypes'").length > 0;
    const crt = Number(rows(db, 'SELECT crt FROM col')[0]?.crt ?? 0);
    const imp = new AnkiImport({ keepScheduling: opts.keepScheduling, crt });
    const models = readModels(db, modern);
    const decks = readDecks(db, modern);
    await col.run((c) => imp.addModels(c, models, decks));

    const count = (table: string) => Number(rows(db, `SELECT count(*) AS n FROM ${table}`)[0]?.n ?? 0);
    const paged = async <T>(phase: string, table: string, columns: string, map: (r: Row) => T, write: (batch: T[]) => Promise<void>) => {
      const total = count(table);
      let last = -1e308;
      for (let done = 0; ; ) {
        // Keyset paging on the id keeps every page as cheap as the first.
        const page = rows(db, `SELECT ${columns} FROM ${table} WHERE id > ? ORDER BY id LIMIT ${PAGE}`, [last]);
        if (!page.length) break;
        last = Number(page.at(-1)!.id);
        await write(page.map(map));
        done += page.length;
        progress({ phase, done, total });
      }
    };

    await paged<AnkiNote>('Notes', 'notes', 'id, guid, mid, tags, flds', (r) => ({
      id: String(r.id), guid: String(r.guid), modelId: String(r.mid), tags: String(r.tags ?? ''), fields: String(r.flds ?? '').split('\u001f'),
    }), (batch) => col.run((c) => imp.addNotes(c, batch)));

    await paged<AnkiCard>('Cards', 'cards', 'id, nid, did, odid, ord, type, queue, due, odue, ivl, factor, reps, lapses, data', (r) => {
      const filtered = Number(r.odid) !== 0;
      return {
        id: String(r.id), noteId: String(r.nid), deckId: String(filtered ? r.odid : r.did), ord: Number(r.ord), type: Number(r.type), queue: Number(r.queue),
        due: Number(filtered ? r.odue : r.due), ivl: Number(r.ivl), factor: Number(r.factor), reps: Number(r.reps), lapses: Number(r.lapses), data: String(r.data ?? ''),
      };
    }, (batch) => col.run((c) => imp.addCards(c, batch)));

    if (opts.keepScheduling) {
      await paged<AnkiReview>('Review history', 'revlog', 'id, cid, ease, type, ivl, lastIvl, time', (r) => ({
        id: Number(r.id), cardId: String(r.cid), ease: Number(r.ease), type: Number(r.type), ivl: Number(r.ivl), lastIvl: Number(r.lastIvl), time: Number(r.time),
      }), (batch) => col.run((c) => imp.addReviews(c, batch)));
    }

    const summary = imp.finish();
    summary.media = await importMedia(col, files, file, zip, compressed, progress, summary.warnings);
    return summary;
  } finally {
    db.close();
  }
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm',
};

async function importMedia(
  col: Collection,
  files: MediaFiles,
  file: Blob,
  zip: Map<string, ZipEntry>,
  compressed: boolean,
  progress: (p: ImportProgress) => void,
  warnings: string[],
): Promise<number> {
  const mapEntry = zip.get('media');
  if (!mapEntry) return 0;
  let raw = await readZipEntry(file, mapEntry);
  // Entry name in the zip → real filename.
  const names = new Map<string, string>();
  if (compressed) {
    raw = zstd(raw);
    let index = 0;
    for (const f of protoFields(raw)) {
      if (f.field === 1 && typeof f.value !== 'number') names.set(String(index++), protoString(f.value, 1));
    }
  } else {
    for (const [k, v] of Object.entries(JSON.parse(utf8.decode(raw) || '{}') as Record<string, string>)) names.set(k, v);
  }
  let done = 0;
  let failed = 0;
  for (const [key, filename] of names) {
    const e = zip.get(key);
    progress({ phase: 'Media', done: ++done, total: names.size });
    if (!e || !filename) continue;
    try {
      let content = await readZipEntry(file, e);
      if (compressed) content = zstd(content);
      const buffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (b) => b.toString(16).padStart(2, '0')).join('');
      if (!(await files.has(hash))) await files.write(hash, buffer);
      const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
      await col.registerMedia({ id: hash, filename, mime: MIME[ext] ?? 'application/octet-stream', size: buffer.byteLength });
    } catch {
      failed++;
    }
  }
  if (failed) warnings.push(`${failed} media ${failed === 1 ? 'file' : 'files'} could not be read and ${failed === 1 ? 'was' : 'were'} skipped.`);
  return names.size - failed;
}
