/**
 * Builds small Anki packages for the import tests, in both generations of the
 * format, the way Anki lays them out. These are stand-ins: real exported decks
 * are still the acceptance test for the importer.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const DAY = 86_400;

function zip(files: Record<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    // Deflate some entries and store others, as real packages do.
    const deflate = raw.length > 64;
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(zlib.crc32(raw), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    local.push(head, nameBytes, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(zlib.crc32(raw), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirBytes, end]);
}

// Protobuf encoding, the little that is needed.
function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}
const pbBytes = (field: number, value: Buffer | string) => {
  const b = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]);
};
const pbInt = (field: number, value: number) => Buffer.concat([varint(field * 8), varint(value)]);

function database(build: (db: DatabaseSync) => void): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'dk-apkg-'));
  try {
    const file = path.join(dir, 'collection.db');
    const db = new DatabaseSync(file);
    build(db);
    db.close();
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOTES_AND_CARDS = `
  CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null,
    tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
  CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null,
    usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null,
    reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
  CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null,
    lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
`;

/** Three notes: a Basic one with an image (in review, due in 5 days), a two-gap cloze (new), and a custom type with a script. */
function fill(db: DatabaseSync, name: string, crt: number) {
  const note = db.prepare('INSERT INTO notes VALUES (?, ?, ?, 0, -1, ?, ?, 0, 0, 0, \'\')');
  note.run(1001, `${name}-g1`, 11, ' animal ', `the dog <img src="dot ${name}.png">\u001fel perro`);
  note.run(1002, `${name}-g2`, 12, '', '{{c1::Lima}} is the capital of {{c2::Peru}}\u001f');
  note.run(1003, `${name}-g3`, 13, '', 'typed\u001fanswer');
  const card = db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, 0, -1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?)');
  const today = Math.floor((Date.now() / 1000 - crt) / DAY);
  card.run(2001, 1001, 21, 0, 2, 2, today + 5, 20, 2500, 6, 0, '{"s":21.5,"d":4.5}');
  card.run(2002, 1002, 22, 0, 0, 0, 1, 0, 0, 0, 0, '');
  card.run(2003, 1002, 22, 1, 0, 0, 2, 0, 0, 0, 0, '');
  card.run(2004, 1003, 22, 0, 2, -1, today - 2, 9, 2300, 3, 1, '');
  const log = db.prepare('INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, 2500, 6000, ?)');
  const ms = Date.now();
  log.run(ms - 40 * DAY * 1000, 2001, 3, -600, -60, 0);
  log.run(ms - 39 * DAY * 1000, 2001, 3, 4, -600, 0);
  log.run(ms - 15 * DAY * 1000, 2001, 3, 20, 4, 1);
}

const BASIC_BACK = '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}';
const CUSTOM = { front: '{{Front}} {{type:Back}}<script>document.title = "pwned"</script>', back: '{{Back}}' };

export function legacyApkg(name: string): Buffer {
  const crt = Math.floor(Date.now() / 1000) - 200 * DAY;
  const model = (id: number, n: string, type: number, flds: string[], tmpls: { name: string; qfmt: string; afmt: string }[]) => ({
    id, name: n, type, css: '.card { font-size: 22px; }', flds: flds.map((f, ord) => ({ name: f, ord })), tmpls: tmpls.map((t, ord) => ({ ...t, ord })),
  });
  const db = database((d) => {
    d.exec(`CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null,
      dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);${NOTES_AND_CARDS}`);
    d.prepare('INSERT INTO col VALUES (1, ?, 0, 0, 11, 0, 0, 0, \'{}\', ?, ?, \'{}\', \'{}\')').run(
      crt,
      JSON.stringify({
        11: model(11, 'Basic', 0, ['Front', 'Back'], [{ name: 'Card 1', qfmt: '{{Front}}', afmt: BASIC_BACK }]),
        12: model(12, 'Cloze', 1, ['Text', 'Back Extra'], [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }]),
        13: model(13, 'Typed', 0, ['Front', 'Back'], [{ name: 'Card 1', qfmt: CUSTOM.front, afmt: CUSTOM.back }]),
      }),
      JSON.stringify({ 1: { id: 1, name: 'Default' }, 21: { id: 21, name: `${name}::Animals` }, 22: { id: 22, name: `${name}::Other` } }),
    );
    fill(d, name, crt);
  });
  return zip({ 'collection.anki2': db, media: Buffer.from(JSON.stringify({ 0: `dot ${name}.png` })), 0: PNG });
}

export function modernApkg(name: string): Buffer {
  const crt = Math.floor(Date.now() / 1000) - 200 * DAY;
  const db = database((d) => {
    d.exec(`CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null,
      dty integer not null, usn integer not null, ls integer not null);
      CREATE TABLE notetypes (id integer primary key, name text not null, mtime_secs integer not null, usn integer not null, config blob not null);
      CREATE TABLE fields (ntid integer not null, ord integer not null, name text not null, config blob not null, primary key (ntid, ord)) without rowid;
      CREATE TABLE templates (ntid integer not null, ord integer not null, name text not null, mtime_secs integer not null, usn integer not null, config blob not null, primary key (ntid, ord)) without rowid;
      CREATE TABLE decks (id integer primary key, name text not null, mtime_secs integer not null, usn integer not null, common blob not null, kind blob not null);${NOTES_AND_CARDS}`);
    d.prepare('INSERT INTO col VALUES (1, ?, 0, 0, 18, 0, 0, 0)').run(crt);
    const types: [number, string, number, string[], { name: string; front: string; back: string }[]][] = [
      [11, 'Basic', 0, ['Front', 'Back'], [{ name: 'Card 1', front: '{{Front}}', back: BASIC_BACK }]],
      [12, 'Cloze', 1, ['Text', 'Back Extra'], [{ name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}<br>\n{{Back Extra}}' }]],
      [13, 'Typed', 0, ['Front', 'Back'], [{ name: 'Card 1', ...CUSTOM }]],
    ];
    for (const [id, n, kind, fields, templates] of types) {
      d.prepare('INSERT INTO notetypes VALUES (?, ?, 0, 0, ?)').run(id, n, Buffer.concat([pbInt(1, kind), pbBytes(3, '.card { font-size: 22px; }')]));
      fields.forEach((f, ord) => d.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)').run(id, ord, f, Buffer.alloc(0)));
      templates.forEach((t, ord) => d.prepare('INSERT INTO templates VALUES (?, ?, ?, 0, 0, ?)').run(id, ord, t.name, Buffer.concat([pbBytes(1, t.front), pbBytes(2, t.back)])));
    }
    const deck = d.prepare('INSERT INTO decks VALUES (?, ?, 0, 0, ?, ?)');
    deck.run(1, 'Default', Buffer.alloc(0), Buffer.alloc(0));
    deck.run(21, `${name}\u001fAnimals`, Buffer.alloc(0), Buffer.alloc(0));
    deck.run(22, `${name}\u001fOther`, Buffer.alloc(0), Buffer.alloc(0));
    fill(d, name, crt);
  });
  const mediaMap = pbBytes(1, Buffer.concat([pbBytes(1, `dot ${name}.png`), pbInt(2, PNG.length)]));
  return zip({
    meta: pbInt(1, 3),
    // Anki also ships a stub in the old format telling old clients to update. It must be ignored.
    'collection.anki2': Buffer.from('not the real collection'),
    'collection.anki21b': zlib.zstdCompressSync(db),
    media: zlib.zstdCompressSync(mediaMap),
    0: zlib.zstdCompressSync(PNG),
  });
}
