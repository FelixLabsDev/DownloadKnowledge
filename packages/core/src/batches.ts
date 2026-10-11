import { and, desc, eq, isNull } from 'drizzle-orm';
import { DkError, ensureDeckPath, loadDecks, deckPath } from './decks';
import { uuidv7 } from './ids';
import { addNote, deleteNotes, findDuplicate, listNoteTypes } from './notes';
import { stripHtml } from './render';
import { agentBatches, cards, notes, type AgentBatch } from './schema';
import { put, softDelete, type Ctx } from './store';

export const AGENT_TAG = 'agent';

export interface BulkNote {
  /** Field values by name, e.g. `{ "Front": "…", "Back": "…" }`. */
  fields: Record<string, string>;
  tags?: string[];
  /** Deck path (`A::B`); overrides the batch default. Created if missing. */
  deck?: string;
  /** Note type name; overrides the batch default. */
  type?: string;
}

export interface BulkAddOptions {
  /** Default deck path for notes that do not name one. */
  deck?: string;
  /** Default note type name. `Basic` if omitted. */
  type?: string;
  tags?: string[];
  /** What this batch is, for whoever reviews it later. */
  description: string;
  allowDuplicates?: boolean;
}

export interface BulkAddResult {
  batchId: string | null;
  added: { noteId: string; cards: number; deck: string; first: string }[];
  /** Notes not added because the same first field already exists in the deck. */
  skipped: { index: number; first: string; reason: string }[];
}

/**
 * Adds many notes as one recorded batch (the agent path). Every note gets the
 * `agent` tag and the batch id so the whole run can be found and undone.
 * All-or-nothing: an invalid note aborts the batch, naming its position.
 */
export async function bulkAddNotes(ctx: Ctx, items: BulkNote[], opts: BulkAddOptions): Promise<BulkAddResult> {
  if (!Array.isArray(items) || items.length === 0) throw new DkError('invalid', 'Expected a non-empty JSON array of notes.');
  if (!opts.description?.trim()) throw new DkError('invalid', 'A batch needs a description.');
  const types = await listNoteTypes(ctx.tx);
  const batchId = uuidv7(ctx.now);
  const result: BulkAddResult = { batchId, added: [], skipped: [] };
  const seen = new Set<string>();

  for (const [index, item] of items.entries()) {
    const where = `Note ${index + 1}`;
    if (typeof item !== 'object' || item === null || typeof item.fields !== 'object' || item.fields === null) {
      throw new DkError('invalid', `${where}: expected { "fields": { ... } }.`);
    }
    const typeName = item.type ?? opts.type ?? 'Basic';
    const type = types.find((t) => t.name.toLowerCase() === typeName.toLowerCase());
    if (!type) throw new DkError('invalid', `${where}: unknown note type "${typeName}". Known: ${types.map((t) => t.name).join(', ')}.`);
    const path = item.deck ?? opts.deck;
    if (!path) throw new DkError('invalid', `${where}: no deck given (use --deck or a "deck" property).`);
    const deck = await ensureDeckPath(ctx, path);
    const first = item.fields[type.fields[0]!] ?? '';
    const text = stripHtml(first);

    if (!opts.allowDuplicates) {
      const key = `${deck.id}|${type.id}|${text.toLowerCase()}`;
      if (seen.has(key) || (await findDuplicate(ctx.tx, deck.id, type.id, first))) {
        result.skipped.push({ index, first: text, reason: 'A note with the same first field already exists in this deck.' });
        continue;
      }
      seen.add(key);
    }
    try {
      const made = await addNote(ctx, {
        noteTypeId: type.id,
        deckId: deck.id,
        fields: item.fields,
        tags: [...(opts.tags ?? []), ...(item.tags ?? []), AGENT_TAG],
        batchId,
      });
      result.added.push({ noteId: made.note.id, cards: made.cards.length, deck: path, first: text });
    } catch (e) {
      throw e instanceof DkError ? new DkError(e.code, `${where}: ${e.message}`) : e;
    }
  }

  if (result.added.length === 0) return { ...result, batchId: null };
  await put(ctx, 'agent_batches', { id: batchId, deletedAt: null, createdAt: ctx.now, description: opts.description.trim() });
  return result;
}

export interface BatchSummary extends AgentBatch {
  /** Notes from this batch that still exist. */
  notes: number;
  decks: string[];
}

export async function listBatches(ctx: Ctx): Promise<BatchSummary[]> {
  const batches = await ctx.tx.select().from(agentBatches).where(isNull(agentBatches.deletedAt)).orderBy(desc(agentBatches.createdAt));
  const index = await loadDecks(ctx.tx);
  const out: BatchSummary[] = [];
  for (const b of batches) {
    const rows = await ctx.tx
      .selectDistinct({ noteId: notes.id, deckId: cards.deckId })
      .from(notes)
      .innerJoin(cards, eq(cards.noteId, notes.id))
      .where(and(eq(notes.batchId, b.id), isNull(notes.deletedAt), isNull(cards.deletedAt)));
    out.push({
      ...b,
      notes: new Set(rows.map((r) => r.noteId)).size,
      decks: [...new Set(rows.map((r) => deckPath(index, r.deckId)))].sort(),
    });
  }
  return out;
}

/** Reverses one batch: soft-deletes every note it created that still exists. Decks it created are left alone. */
export async function undoBatch(ctx: Ctx, batchId: string): Promise<{ notesDeleted: number }> {
  const batch = (await ctx.tx.select().from(agentBatches).where(eq(agentBatches.id, batchId)))[0];
  if (!batch) throw new DkError('not_found', `No batch with id ${batchId}.`);
  const rows = await ctx.tx.select({ id: notes.id }).from(notes).where(and(eq(notes.batchId, batchId), isNull(notes.deletedAt)));
  const notesDeleted = await deleteNotes(ctx, rows.map((r) => r.id));
  await softDelete(ctx, 'agent_batches', batch);
  return { notesDeleted };
}
