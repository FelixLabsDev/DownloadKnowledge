import { DkError, ensureDeckPath, requireDeck } from '../decks';
import { addNote, findDuplicate, requireNoteType } from '../notes';
import { stripHtml } from '../render';
import type { Ctx } from '../store';

export interface ParsedTable {
  delimiter: ',' | '\t' | ';';
  rows: string[][];
  /** Widest row. */
  columns: number;
}

/**
 * Parses CSV or TSV: quoted fields, doubled quotes, line breaks inside quotes.
 * The delimiter is detected from the first line unless an Anki-style
 * `#separator:` header names it. Lines starting with `#` at the top are skipped.
 */
export function parseDelimited(text: string): ParsedTable {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte-order mark
  let delimiter: ParsedTable['delimiter'] | null = null;
  while (text.startsWith('#')) {
    const end = text.indexOf('\n');
    const line = (end < 0 ? text : text.slice(0, end)).trim().toLowerCase();
    const m = /^#separator:\s*(\S+)/.exec(line);
    if (m) delimiter = m[1] === 'tab' || m[1] === '\\t' ? '\t' : m[1] === 'semicolon' || m[1] === ';' ? ';' : ',';
    text = end < 0 ? '' : text.slice(end + 1);
  }
  if (!delimiter) {
    const first = text.slice(0, text.indexOf('\n') < 0 ? undefined : text.indexOf('\n'));
    const count = (d: string) => first.split(d).length - 1;
    delimiter = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',';
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  const endField = () => {
    row.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    if (row.some((f) => f !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.trim() === '') {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (c === delimiter) endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) endRow();
  return { delimiter, rows, columns: Math.max(0, ...rows.map((r) => r.length)) };
}

/** What a column of the file is used for: a field (by position in the note type), tags, the deck, or nothing. */
export type ColumnTarget = { field: number } | 'tags' | 'deck' | null;

export interface RowImportOptions {
  noteTypeId: string;
  /** Deck for rows without a deck column. */
  deckId: string;
  mapping: ColumnTarget[];
  /** Tags added to every imported note. */
  tags?: string[];
  skipFirstRow?: boolean;
  allowDuplicates?: boolean;
  /** Plain text files use line breaks; fields are HTML. On by default. */
  convertLineBreaks?: boolean;
}

export interface RowImportResult {
  added: number;
  cards: number;
  duplicates: number;
  /** Rows that could not be imported, with the reason. Row numbers are 1-based, as in the file. */
  errors: { row: number; message: string }[];
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const looksLikeHtml = (s: string) => /<\/?[a-z][^>]*>|&[a-z]+;/i.test(s);

/** Imports rows as notes. Bad rows are reported and skipped; the rest are imported. */
export async function importRows(ctx: Ctx, rows: string[][], opts: RowImportOptions): Promise<RowImportResult> {
  const nt = await requireNoteType(ctx.tx, opts.noteTypeId);
  await requireDeck(ctx.tx, opts.deckId);
  if (!opts.mapping.some((m) => m && typeof m === 'object' && m.field === 0)) {
    throw new DkError('invalid', `Choose which column holds "${nt.fields[0]}".`);
  }
  const result: RowImportResult = { added: 0, cards: 0, duplicates: 0, errors: [] };
  const deckCache = new Map<string, string>();
  const seen = new Set<string>();

  for (const [i, row] of rows.entries()) {
    if (i === 0 && opts.skipFirstRow) continue;
    const fields = nt.fields.map(() => '');
    let tags = [...(opts.tags ?? [])];
    let deckId = opts.deckId;
    try {
      for (const [col, target] of opts.mapping.entries()) {
        const value = row[col] ?? '';
        if (!target || value === '') continue;
        if (target === 'tags') tags = tags.concat(value.split(/[\s,]+/).filter(Boolean));
        else if (target === 'deck') {
          if (!deckCache.has(value)) deckCache.set(value, (await ensureDeckPath(ctx, value)).id);
          deckId = deckCache.get(value)!;
        } else if (target.field < fields.length) {
          const html = looksLikeHtml(value) || opts.convertLineBreaks === false ? value : escapeHtml(value).replace(/\n/g, '<br>');
          fields[target.field] = fields[target.field] ? `${fields[target.field]}<br>${html}` : html;
        }
      }
      if (!opts.allowDuplicates) {
        const key = `${deckId}|${stripHtml(fields[0]!).toLowerCase()}`;
        if (seen.has(key) || (await findDuplicate(ctx.tx, deckId, nt.id, fields[0]!))) {
          result.duplicates++;
          continue;
        }
        seen.add(key);
      }
      const made = await addNote(ctx, { noteTypeId: nt.id, deckId, fields, tags });
      result.added++;
      result.cards += made.cards.length;
    } catch (e) {
      if (!(e instanceof DkError)) throw e;
      result.errors.push({ row: i + 1, message: e.message });
    }
  }
  return result;
}
