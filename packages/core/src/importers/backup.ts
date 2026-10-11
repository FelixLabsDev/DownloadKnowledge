import { deckPath, loadDecks } from '../decks';
import { listNoteTypes } from '../notes';
import { cards, notes, syncedTableNames, syncedTables } from '../schema';
import type { Ctx } from '../store';
import { isNull } from 'drizzle-orm';

export interface Backup {
  format: 'downloadknowledge-backup';
  version: 1;
  exportedAt: string;
  /** Every row of every synced table, including soft-deleted ones. Media rows are metadata only; the files are not included. */
  tables: Record<string, unknown[]>;
}

/** The whole collection as one JSON-serialisable object. */
export async function exportBackup(ctx: Ctx): Promise<Backup> {
  const tables: Record<string, unknown[]> = {};
  for (const name of syncedTableNames) tables[name] = await ctx.tx.select().from(syncedTables[name]);
  return { format: 'downloadknowledge-backup', version: 1, exportedAt: new Date(ctx.now).toISOString(), tables };
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Notes as CSV, one row per note: deck, note type, tags, then the fields in
 * order. Readable in a spreadsheet and importable again (here or in Anki).
 */
export async function exportNotesCsv(ctx: Ctx): Promise<string> {
  const index = await loadDecks(ctx.tx);
  const types = new Map((await listNoteTypes(ctx.tx)).map((t) => [t.id, t]));
  const allNotes = await ctx.tx.select().from(notes).where(isNull(notes.deletedAt));
  const deckOf = new Map<string, string>();
  for (const c of await ctx.tx.select({ noteId: cards.noteId, deckId: cards.deckId }).from(cards).where(isNull(cards.deletedAt))) {
    if (!deckOf.has(c.noteId)) deckOf.set(c.noteId, c.deckId);
  }
  const width = Math.max(1, ...allNotes.map((n) => n.fields.length));
  const lines = [['deck', 'note_type', 'tags', ...Array.from({ length: width }, (_, i) => `field_${i + 1}`)].join(',')];
  for (const n of allNotes) {
    const deck = deckOf.get(n.id);
    if (!deck) continue;
    const row = [deckPath(index, deck), types.get(n.noteTypeId)?.name ?? '', n.tags.join(' '), ...n.fields];
    while (row.length < width + 3) row.push('');
    lines.push(row.map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
