/**
 * Importing an Anki collection. This file is the platform-free half: it takes
 * rows already read out of the .apkg (the web app does the unzipping and the
 * SQLite reading) and writes notes, cards and history through the usual path.
 *
 * Ids are derived from Anki's own, so importing the same deck twice updates
 * what is there instead of duplicating it, and never overwrites progress made
 * here since the first import.
 */
import { inArray } from 'drizzle-orm';
import { ensureDeckPath } from '../decks';
import { listNoteTypes, normaliseTags } from '../notes';
import { DAY_MS, newCardSched, State } from '../scheduler';
import { cards, notes, type CardSched } from '../schema';
import { chunk, put, type Ctx } from '../store';

export interface AnkiModel {
  id: string;
  name: string;
  kind: 'standard' | 'cloze';
  fields: string[];
  css: string;
  templates: { ord: number; name: string; front: string; back: string }[];
}
export interface AnkiDeck {
  id: string;
  /** Full path with `::` separators. */
  name: string;
}
export interface AnkiNote {
  id: string;
  guid: string;
  modelId: string;
  fields: string[];
  /** Space-separated, as Anki stores them. */
  tags: string;
}
export interface AnkiCard {
  id: string;
  noteId: string;
  /** The card's home deck (the original deck if it sits in a filtered deck). */
  deckId: string;
  ord: number;
  /** 0 new, 1 learning, 2 review, 3 relearning. */
  type: number;
  /** -1 suspended. */
  queue: number;
  /** Review cards: days since the collection was created. */
  due: number;
  ivl: number;
  /** SM-2 ease, per mille (2500 = 250%). */
  factor: number;
  reps: number;
  lapses: number;
  /** JSON; newer Anki versions keep FSRS memory state here (`s`, `d`). */
  data: string;
}
export interface AnkiReview {
  /** Also the review time, ms since epoch. */
  id: number;
  cardId: string;
  ease: number;
  /** 0 learning, 1 review, 2 relearning, 3 filtered, 4 manual. */
  type: number;
  ivl: number;
  lastIvl: number;
  time: number;
}

export interface AnkiImportOptions {
  /** Keep Anki's scheduling and review history. Otherwise every card starts as new. */
  keepScheduling: boolean;
  /** Collection creation time, seconds since epoch (`col.crt`); review due dates count days from it. */
  crt: number;
}

export interface AnkiImportSummary {
  noteTypesCreated: string[];
  noteTypesReused: string[];
  decks: string[];
  notesAdded: number;
  notesUpdated: number;
  notesSkipped: number;
  cardsAdded: number;
  /** Cards that already existed here; their scheduling was left alone. */
  cardsKept: number;
  /** Cards whose FSRS memory state came across as-is. */
  scheduledFromFsrs: number;
  /** Cards scheduled by Anki's older SM-2 algorithm, converted: stability from the interval, difficulty from the ease. */
  scheduledFromSm2: number;
  /** Cards that were part-way through learning, which start again as new. */
  resetToNew: number;
  suspended: number;
  reviews: number;
  media: number;
  /** Things that will not look or work as they did in Anki. */
  warnings: string[];
}

// Anki writes id=answer where we write id="answer"; whitespace and quoting are not differences that matter.
const squash = (s: string) => s.replace(/[\s"']+/g, '');
const same = (a: string, b: string) => squash(a) === squash(b);

function templateWarnings(m: AnkiModel): string[] {
  const all = m.templates.map((t) => `${t.front}\n${t.back}`).join('\n');
  const found: string[] = [];
  if (/<script\b/i.test(all)) found.push('uses JavaScript, which does not run here');
  if (/\{\{[^}]*type:/i.test(all)) found.push('uses type-in-the-answer, which is shown as a normal card');
  const filters = new Set<string>();
  for (const x of all.matchAll(/\{\{\s*([^{}#^/]+?):[^{}]*\}\}/g)) {
    for (const f of x[1]!.split(':').map((s) => s.trim())) if (!/^(text|cloze|hint|type|type-.*)$/.test(f)) filters.add(f);
  }
  if (filters.size) found.push(`uses template filters that are ignored (${[...filters].join(', ')})`);
  if (/\[latex\]|\[\$\]|\\\(|\\\[/.test(all)) found.push('uses LaTeX or MathJax, which is shown as plain text');
  return found.map((f) => `Note type "${m.name}" ${f}.`);
}

/** FSRS difficulty (1 easiest, 10 hardest) from SM-2 ease: 130% maps to 10, 250% to 5, 350% and up to 1. */
function difficultyFromEase(factor: number): number {
  if (!factor) return 5;
  return Math.min(10, Math.max(1, 10 - ((factor - 1300) / 1200) * 5));
}

/** One import run. Create it, then feed it models and decks, notes, cards and reviews, in that order. */
export class AnkiImport {
  readonly summary: AnkiImportSummary = {
    noteTypesCreated: [],
    noteTypesReused: [],
    decks: [],
    notesAdded: 0,
    notesUpdated: 0,
    notesSkipped: 0,
    cardsAdded: 0,
    cardsKept: 0,
    scheduledFromFsrs: 0,
    scheduledFromSm2: 0,
    resetToNew: 0,
    suspended: 0,
    reviews: 0,
    media: 0,
    warnings: [],
  };
  private models = new Map<string, { noteTypeId: string; kind: 'standard' | 'cloze'; fieldCount: number }>();
  private deckNames = new Map<string, string>();
  private deckIds = new Map<string, string>();
  private noteModel = new Map<string, string>();
  /** Anki note id → our note id. */
  private noteIds = new Map<string, string>();
  /** Anki card id → our card id, for cards created by this run (only those get review history). */
  private newCards = new Map<string, string>();
  private reviewed = new Set<string>();

  constructor(private opts: AnkiImportOptions) {}

  async addModels(ctx: Ctx, models: AnkiModel[], decks: AnkiDeck[]): Promise<void> {
    for (const d of decks) this.deckNames.set(d.id, d.name);
    const existing = await listNoteTypes(ctx.tx);
    for (const m of models) {
      this.summary.warnings.push(...templateWarnings(m));
      const id = `anki-nt-${m.id}`;
      // Reuse a note type that is the same in every way that matters (typically the built-in ones).
      const twin = existing.find(
        (t) =>
          t.kind === m.kind &&
          t.fields.join('\u001f') === m.fields.join('\u001f') &&
          t.templates.length === m.templates.length &&
          t.templates.every((tt) => m.templates.some((mt) => mt.ord === tt.ordinal && same(mt.front, tt.front) && same(mt.back, tt.back))),
      );
      if (twin) {
        this.models.set(m.id, { noteTypeId: twin.id, kind: m.kind, fieldCount: m.fields.length });
        this.summary.noteTypesReused.push(twin.name);
        continue;
      }
      const taken = existing.some((t) => t.id !== id && t.name.toLowerCase() === m.name.toLowerCase());
      const name = taken ? `${m.name} (imported)` : m.name;
      const prior = existing.find((t) => t.id === id);
      await put(ctx, 'note_types', { ...prior, id, deletedAt: null, name: prior?.name ?? name, kind: m.kind, fields: m.fields, css: m.css });
      for (const t of m.templates) {
        const tid = `anki-t-${m.id}-${t.ord}`;
        const old = prior?.templates.find((x) => x.id === tid);
        await put(ctx, 'templates', { ...old, id: tid, deletedAt: null, noteTypeId: id, name: t.name, front: t.front, back: t.back, ordinal: t.ord });
      }
      this.models.set(m.id, { noteTypeId: id, kind: m.kind, fieldCount: m.fields.length });
      this.summary.noteTypesCreated.push(prior?.name ?? name);
    }
  }

  async addNotes(ctx: Ctx, batch: AnkiNote[]): Promise<void> {
    const ids = batch.map((n) => `anki-n-${n.guid}`);
    const existing = new Map<string, typeof notes.$inferSelect>();
    for (const part of chunk(ids)) for (const row of await ctx.tx.select().from(notes).where(inArray(notes.id, part))) existing.set(row.id, row);
    for (const n of batch) {
      const model = this.models.get(n.modelId);
      if (!model) {
        this.summary.notesSkipped++;
        continue;
      }
      this.noteModel.set(n.id, n.modelId);
      this.noteIds.set(n.id, `anki-n-${n.guid}`);
      const id = `anki-n-${n.guid}`;
      const fields = Array.from({ length: model.fieldCount }, (_, i) => n.fields[i] ?? '');
      const tags = normaliseTags(n.tags.split(/\s+/));
      const old = existing.get(id);
      if (old && old.deletedAt === null && old.fields.join('\u001f') === fields.join('\u001f') && old.tags.join(' ') === tags.join(' ')) continue;
      await put(ctx, 'notes', { ...old, id, deletedAt: null, noteTypeId: model.noteTypeId, fields, tags, batchId: old?.batchId ?? null });
      if (old) this.summary.notesUpdated++;
      else this.summary.notesAdded++;
    }
  }

  private async deckFor(ctx: Ctx, ankiDeckId: string): Promise<string> {
    let id = this.deckIds.get(ankiDeckId);
    if (!id) {
      // Decks are created only when a card needs them, so Anki's empty "Default" deck is not imported.
      const path = (this.deckNames.get(ankiDeckId) ?? 'Imported').split('::').map((p) => p.trim()).filter(Boolean).join('::') || 'Imported';
      id = (await ensureDeckPath(ctx, path)).id;
      this.deckIds.set(ankiDeckId, id);
      this.summary.decks.push(path);
    }
    return id;
  }

  private schedule(ctx: Ctx, c: AnkiCard): CardSched {
    const fresh = newCardSched(ctx.now);
    if (!this.opts.keepScheduling || c.type === 0) return fresh;
    if (c.type !== 2) {
      this.summary.resetToNew++;
      return fresh;
    }
    let memory: { s?: number; d?: number } = {};
    try {
      memory = c.data ? (JSON.parse(c.data) as typeof memory) : {};
    } catch {
      // Not JSON: no FSRS state.
    }
    const ivl = Math.max(1, c.ivl);
    const due = (this.opts.crt + c.due * 86_400) * 1000;
    const hasFsrs = typeof memory.s === 'number' && memory.s > 0 && typeof memory.d === 'number';
    if (hasFsrs) this.summary.scheduledFromFsrs++;
    else this.summary.scheduledFromSm2++;
    return {
      due,
      // FSRS stability is the interval at which recall is 90%, so an SM-2 interval is a fair stand-in.
      stability: hasFsrs ? memory.s! : ivl,
      difficulty: hasFsrs ? Math.min(10, Math.max(1, memory.d!)) : difficultyFromEase(c.factor),
      elapsedDays: 0,
      scheduledDays: ivl,
      learningSteps: 0,
      reps: c.reps,
      lapses: c.lapses,
      state: State.Review,
      lastReview: due - ivl * DAY_MS,
    };
  }

  async addCards(ctx: Ctx, batch: AnkiCard[]): Promise<void> {
    const existingIds = new Set<string>();
    const ids = batch.map((c) => `anki-c-${c.id}`);
    for (const part of chunk(ids)) for (const row of await ctx.tx.select({ id: cards.id }).from(cards).where(inArray(cards.id, part))) existingIds.add(row.id);
    for (const c of batch) {
      const modelId = this.noteModel.get(c.noteId);
      const model = modelId ? this.models.get(modelId) : undefined;
      const ourNoteId = this.noteIds.get(c.noteId);
      if (!model || !ourNoteId) continue;
      const id = `anki-c-${c.id}`;
      if (existingIds.has(id)) {
        this.summary.cardsKept++;
        continue;
      }
      const suspended = c.queue === -1;
      if (suspended) this.summary.suspended++;
      await put(ctx, 'cards', {
        id,
        deletedAt: null,
        noteId: ourNoteId,
        // Anki numbers cloze cards from 0; here the ordinal is the cloze number itself.
        ordinal: model.kind === 'cloze' ? c.ord + 1 : c.ord,
        deckId: await this.deckFor(ctx, c.deckId),
        ...this.schedule(ctx, c),
        suspended,
      });
      this.newCards.set(c.id, id);
      this.summary.cardsAdded++;
    }
  }

  async addReviews(ctx: Ctx, batch: AnkiReview[]): Promise<void> {
    if (!this.opts.keepScheduling) return;
    for (const r of batch) {
      const cardId = this.newCards.get(r.cardId);
      // Ease 0 and type 4 are manual reschedules, not answers.
      if (!cardId || r.ease < 1 || r.ease > 4 || r.type === 4) continue;
      const first = !this.reviewed.has(r.cardId);
      this.reviewed.add(r.cardId);
      const state = first && r.type === 0 ? State.New : r.type === 1 ? State.Review : r.type === 2 ? State.Relearning : State.Learning;
      const days = (n: number) => (n < 0 ? -n / 86_400 : n); // Negative intervals are seconds.
      await put(ctx, 'review_log', {
        id: `anki-r-${r.id}`,
        deletedAt: null,
        cardId,
        rating: r.ease,
        reviewedAt: r.id,
        stateBefore: { ...newCardSched(r.id), state, scheduledDays: days(r.lastIvl) },
        elapsedDays: days(r.lastIvl),
        scheduledDays: days(r.ivl),
        durationMs: Math.max(0, r.time),
        deviceId: 'anki-import',
      });
      this.summary.reviews++;
    }
  }

  /** Call last. */
  finish(): AnkiImportSummary {
    this.summary.decks.sort();
    this.summary.warnings = [...new Set(this.summary.warnings)];
    return this.summary;
  }
}
