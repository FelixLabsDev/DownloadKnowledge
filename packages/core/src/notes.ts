import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { DkError, deckPath, loadDecks, requireDeck, subtree } from './decks';
import type { DbOrTx } from './driver';
import { uuidv7 } from './ids';
import { builtinNoteTypes } from './noteTypes';
import { cardOrdinals, stripHtml } from './render';
import { newCardSched, State, studyDayStart, DAY_MS } from './scheduler';
import { cards, notes, noteTypes, templates, type Card, type Note, type NoteType, type Template } from './schema';
import { chunk, put, softDelete, type Ctx } from './store';

export interface NoteTypeWithTemplates extends NoteType {
  templates: Template[];
}

/** Inserts the built-in note types if absent. `modified_at` 0 means any later edit wins. */
export async function seedBuiltins(ctx: Ctx): Promise<void> {
  const existing = new Set((await ctx.tx.select({ id: noteTypes.id }).from(noteTypes)).map((r) => r.id));
  const seedCtx = { ...ctx, now: 0 };
  for (const nt of builtinNoteTypes) {
    if (existing.has(nt.id)) continue;
    await put(seedCtx, 'note_types', {
      id: nt.id,
      modifiedAt: -1,
      deletedAt: null,
      name: nt.name,
      kind: nt.kind,
      fields: nt.fields,
      css: nt.css,
    });
    for (const t of nt.templates) {
      await put(seedCtx, 'templates', { ...t, modifiedAt: -1, deletedAt: null, noteTypeId: nt.id });
    }
  }
  ctx.wrote ||= seedCtx.wrote;
}

export async function listNoteTypes(tx: DbOrTx): Promise<NoteTypeWithTemplates[]> {
  const types = await tx.select().from(noteTypes).where(isNull(noteTypes.deletedAt)).orderBy(asc(noteTypes.name));
  const tpls = await tx.select().from(templates).where(isNull(templates.deletedAt)).orderBy(asc(templates.ordinal));
  return types.map((t) => ({ ...t, templates: tpls.filter((x) => x.noteTypeId === t.id) }));
}

export async function requireNoteType(tx: DbOrTx, id: string): Promise<NoteTypeWithTemplates> {
  const nt = (await listNoteTypes(tx)).find((t) => t.id === id);
  if (!nt) throw new DkError('not_found', 'That note type does not exist.');
  return nt;
}

export function normaliseTags(tags: string[] | undefined): string[] {
  const seen = new Map<string, string>();
  for (const raw of tags ?? []) {
    const t = raw.trim().replace(/\s+/g, '_');
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function fitFields(nt: NoteType, fields: string[] | Record<string, string>): string[] {
  if (Array.isArray(fields)) return nt.fields.map((_, i) => fields[i] ?? '');
  const unknown = Object.keys(fields).filter((k) => !nt.fields.includes(k));
  if (unknown.length) {
    throw new DkError('invalid', `Unknown field(s) for note type "${nt.name}": ${unknown.join(', ')}. Expected: ${nt.fields.join(', ')}.`);
  }
  return nt.fields.map((name) => fields[name] ?? '');
}

export interface AddNoteInput {
  noteTypeId: string;
  deckId: string;
  /** Values by position, or by field name. */
  fields: string[] | Record<string, string>;
  tags?: string[];
  batchId?: string | null;
}

/** Creates a note and the cards it generates. */
export async function addNote(ctx: Ctx, input: AddNoteInput): Promise<{ note: Note; cards: Card[] }> {
  const nt = await requireNoteType(ctx.tx, input.noteTypeId);
  await requireDeck(ctx.tx, input.deckId);
  const fields = fitFields(nt, input.fields);
  if (stripHtml(fields[0] ?? '') === '' && !/<(img|audio)\b/i.test(fields[0] ?? '')) {
    throw new DkError('invalid', `The first field (${nt.fields[0]}) is empty.`);
  }
  const ordinals = cardOrdinals(nt.kind, nt.fields, fields, nt.templates);
  if (!ordinals.length) throw new DkError('invalid', 'This note would not generate any cards.');
  const note = await put(ctx, 'notes', {
    id: uuidv7(ctx.now),
    deletedAt: null,
    noteTypeId: nt.id,
    fields,
    tags: normaliseTags(input.tags),
    batchId: input.batchId ?? null,
  });
  const made: Card[] = [];
  for (const ordinal of ordinals) made.push(await newCard(ctx, note.id, ordinal, input.deckId));
  return { note, cards: made };
}

function newCard(ctx: Ctx, noteId: string, ordinal: number, deckId: string): Promise<Card> {
  return put(ctx, 'cards', {
    id: uuidv7(ctx.now),
    deletedAt: null,
    noteId,
    ordinal,
    deckId,
    ...newCardSched(ctx.now),
    suspended: false,
  });
}

export async function requireNote(tx: DbOrTx, id: string): Promise<Note> {
  const rows = await tx.select().from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt)));
  if (!rows[0]) throw new DkError('not_found', 'That note does not exist.');
  return rows[0];
}

export async function cardsOfNote(tx: DbOrTx, noteId: string): Promise<Card[]> {
  return tx
    .select()
    .from(cards)
    .where(and(eq(cards.noteId, noteId), isNull(cards.deletedAt)))
    .orderBy(asc(cards.ordinal));
}

/**
 * Edits a note and reconciles its cards: cards for new templates or cloze
 * indexes are added, cards whose template or cloze no longer applies are
 * deleted, and surviving cards keep their scheduling.
 */
export async function updateNote(
  ctx: Ctx,
  id: string,
  patch: { fields?: string[] | Record<string, string>; tags?: string[] },
): Promise<{ note: Note; cards: Card[] }> {
  const note = await requireNote(ctx.tx, id);
  const nt = await requireNoteType(ctx.tx, note.noteTypeId);
  const fields = patch.fields ? fitFields(nt, Array.isArray(patch.fields) ? patch.fields : { ...Object.fromEntries(nt.fields.map((n, i) => [n, note.fields[i] ?? ''])), ...patch.fields }) : note.fields;
  const saved = await put(ctx, 'notes', {
    ...note,
    fields,
    tags: patch.tags ? normaliseTags(patch.tags) : note.tags,
  });
  const existing = await cardsOfNote(ctx.tx, id);
  const wanted = cardOrdinals(nt.kind, nt.fields, fields, nt.templates);
  const deckId = existing[0]?.deckId;
  for (const c of existing) if (!wanted.includes(c.ordinal)) await softDelete(ctx, 'cards', c);
  if (deckId) {
    for (const o of wanted) if (!existing.some((c) => c.ordinal === o)) await newCard(ctx, id, o, deckId);
  }
  return { note: saved, cards: await cardsOfNote(ctx.tx, id) };
}

/** Soft-deletes notes and all their cards. */
export async function deleteNotes(ctx: Ctx, noteIds: string[]): Promise<number> {
  let n = 0;
  for (const ids of chunk([...new Set(noteIds)])) {
    const ns = await ctx.tx.select().from(notes).where(and(inArray(notes.id, ids), isNull(notes.deletedAt)));
    const cs = await ctx.tx.select().from(cards).where(and(inArray(cards.noteId, ids), isNull(cards.deletedAt)));
    for (const c of cs) await softDelete(ctx, 'cards', c);
    for (const note of ns) await softDelete(ctx, 'notes', note);
    n += ns.length;
  }
  return n;
}

/** Deletes any of the given notes that no longer have a live card. */
export async function deleteOrphanNotes(ctx: Ctx, noteIds: string[]): Promise<number> {
  const orphans: string[] = [];
  for (const ids of chunk(noteIds)) {
    const live = await ctx.tx
      .selectDistinct({ noteId: cards.noteId })
      .from(cards)
      .where(and(inArray(cards.noteId, ids), isNull(cards.deletedAt)));
    const alive = new Set(live.map((r) => r.noteId));
    orphans.push(...ids.filter((x) => !alive.has(x)));
  }
  return deleteNotes(ctx, orphans);
}

async function cardsById(tx: DbOrTx, ids: string[]): Promise<Card[]> {
  const out: Card[] = [];
  for (const part of chunk([...new Set(ids)])) {
    out.push(...(await tx.select().from(cards).where(and(inArray(cards.id, part), isNull(cards.deletedAt)))));
  }
  return out;
}

export async function moveCards(ctx: Ctx, cardIds: string[], deckId: string): Promise<number> {
  await requireDeck(ctx.tx, deckId);
  const rows = (await cardsById(ctx.tx, cardIds)).filter((c) => c.deckId !== deckId);
  for (const c of rows) await put(ctx, 'cards', { ...c, deckId });
  return rows.length;
}

export async function setSuspended(ctx: Ctx, cardIds: string[], suspended: boolean): Promise<number> {
  const rows = (await cardsById(ctx.tx, cardIds)).filter((c) => c.suspended !== suspended);
  for (const c of rows) await put(ctx, 'cards', { ...c, suspended });
  return rows.length;
}

/** Deleting cards deletes their notes (and so their sibling cards), as in Anki. */
export async function deleteCards(ctx: Ctx, cardIds: string[]): Promise<number> {
  const rows = await cardsById(ctx.tx, cardIds);
  return deleteNotes(ctx, rows.map((c) => c.noteId));
}

export async function changeTags(ctx: Ctx, noteIds: string[], add: string[], remove: string[]): Promise<number> {
  const drop = new Set(remove.map((t) => t.toLowerCase()));
  let changed = 0;
  for (const ids of chunk([...new Set(noteIds)])) {
    const ns = await ctx.tx.select().from(notes).where(and(inArray(notes.id, ids), isNull(notes.deletedAt)));
    for (const note of ns) {
      const tags = normaliseTags([...note.tags.filter((t) => !drop.has(t.toLowerCase())), ...add]);
      if (tags.join(' ') === note.tags.join(' ')) continue;
      await put(ctx, 'notes', { ...note, tags });
      changed++;
    }
  }
  return changed;
}

export async function listTags(tx: DbOrTx): Promise<{ tag: string; count: number }[]> {
  const rows = await tx.select({ tags: notes.tags }).from(notes).where(isNull(notes.deletedAt));
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Another live note in the same deck whose first field has the same text, if any. */
export async function findDuplicate(tx: DbOrTx, deckId: string, noteTypeId: string, firstField: string): Promise<Note | null> {
  const want = stripHtml(firstField).toLowerCase();
  const rows = await tx
    .selectDistinct({ note: notes })
    .from(notes)
    .innerJoin(cards, eq(cards.noteId, notes.id))
    .where(and(eq(cards.deckId, deckId), eq(notes.noteTypeId, noteTypeId), isNull(notes.deletedAt), isNull(cards.deletedAt)));
  return rows.find((r) => stripHtml(r.note.fields[0] ?? '').toLowerCase() === want)?.note ?? null;
}

// ---------------------------------------------------------------------------
// Search

export interface CardRow {
  card: Card;
  note: Note;
  deckPath: string;
  noteTypeName: string;
  templateName: string;
  /** Plain text of the note's first field. */
  preview: string;
}

export interface SearchResult {
  rows: CardRow[];
  total: number;
}

function tokenize(query: string): string[] {
  const out: string[] = [];
  const re = /(-?[a-z]+:)?"([^"]*)"|\S+/gi;
  for (const m of query.matchAll(re)) out.push(m[2] !== undefined ? `${m[1] ?? ''}${m[2]}` : m[0]);
  return out;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Card search. Plain words match field text. Filters: `deck:Name` (includes
 * sub-decks), `tag:x`, `note:TypeName`, `is:new|learn|review|due|suspended`.
 * Prefix a filter with `-` to negate it.
 */
export async function searchCards(
  ctx: Ctx,
  query: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SearchResult> {
  const tx = ctx.tx;
  const index = await loadDecks(tx);
  const types = await listNoteTypes(tx);
  const dayEnd = studyDayStart(ctx.now, ctx.tzOffsetMinutes) + DAY_MS;
  const where: SQL[] = [isNull(cards.deletedAt), isNull(notes.deletedAt)];

  for (const raw of tokenize(query)) {
    const negate = raw.startsWith('-') && raw.includes(':');
    const token = negate ? raw.slice(1) : raw;
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
    const value = colon > 0 ? token.slice(colon + 1) : token;
    let cond: SQL | undefined;
    if (key === 'deck') {
      const want = value.toLowerCase();
      const ids = new Set<string>();
      for (const d of index.byId.values()) {
        const path = deckPath(index, d.id).toLowerCase();
        if (path === want || d.name.toLowerCase() === want || d.id === value) {
          for (const s of subtree(index, d.id)) ids.add(s.id);
        }
      }
      cond = ids.size ? inArray(cards.deckId, [...ids]) : sql`0`;
    } else if (key === 'tag') {
      cond = sql`EXISTS (SELECT 1 FROM json_each(${notes.tags}) WHERE lower(value) = ${value.toLowerCase()})`;
    } else if (key === 'note') {
      const ids = types.filter((t) => t.name.toLowerCase() === value.toLowerCase()).map((t) => t.id);
      cond = ids.length ? inArray(notes.noteTypeId, ids) : sql`0`;
    } else if (key === 'is') {
      const v = value.toLowerCase();
      if (v === 'new') cond = sql`${cards.state} = ${State.New}`;
      else if (v === 'learn') cond = sql`${cards.state} IN (${State.Learning}, ${State.Relearning})`;
      else if (v === 'review') cond = sql`${cards.state} = ${State.Review}`;
      else if (v === 'suspended') cond = sql`${cards.suspended} = 1`;
      else if (v === 'due') cond = sql`(${cards.state} != ${State.New} AND ${cards.suspended} = 0 AND ${cards.due} < ${dayEnd})`;
      else cond = sql`0`;
    } else {
      cond = sql`${notes.fields} LIKE ${`%${likeEscape(JSON.stringify(token).slice(1, -1))}%`} ESCAPE '\\'`;
    }
    where.push(negate ? sql`NOT (${cond})` : cond);
  }

  const filter = and(...where);
  const total =
    (await tx.select({ n: sql<number>`count(*)` }).from(cards).innerJoin(notes, eq(notes.id, cards.noteId)).where(filter))[0]?.n ?? 0;
  const found = await tx
    .select({ card: cards, note: notes })
    .from(cards)
    .innerJoin(notes, eq(notes.id, cards.noteId))
    .where(filter)
    .orderBy(asc(cards.id))
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0);

  const typeById = new Map(types.map((t) => [t.id, t]));
  return {
    total,
    rows: found.map(({ card, note }) => {
      const nt = typeById.get(note.noteTypeId);
      return {
        card,
        note,
        deckPath: deckPath(index, card.deckId),
        noteTypeName: nt?.name ?? '(missing note type)',
        templateName:
          nt?.kind === 'cloze' ? `Cloze ${card.ordinal}` : (nt?.templates.find((t) => t.ordinal === card.ordinal)?.name ?? ''),
        preview: stripHtml(note.fields[0] ?? '').slice(0, 200),
      };
    }),
  };
}

export async function updateNoteType(ctx: Ctx, id: string, patch: { css?: string }): Promise<void> {
  const nt = await requireNoteType(ctx.tx, id);
  const { templates: _t, ...row } = nt;
  await put(ctx, 'note_types', { ...row, css: patch.css ?? row.css });
}

export async function updateTemplate(ctx: Ctx, id: string, patch: { front?: string; back?: string }): Promise<void> {
  const rows = await ctx.tx.select().from(templates).where(and(eq(templates.id, id), isNull(templates.deletedAt)));
  const t = rows[0];
  if (!t) throw new DkError('not_found', 'That template does not exist.');
  await put(ctx, 'templates', { ...t, front: patch.front ?? t.front, back: patch.back ?? t.back });
}
