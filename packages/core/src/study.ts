import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { ancestry, deckPath, DkError, loadDecks, subtree, type DeckIndex } from './decks';
import type { DbOrTx } from './driver';
import { uuidv7 } from './ids';
import { requireNoteType } from './notes';
import { renderCard } from './render';
import { DAY_MS, LEARN_AHEAD_MS, previewDue, schedOf, schedule, State, studyDayStart, type Rating } from './scheduler';
import { cards, notes, reviewLog, type Card, type Deck } from './schema';
import { put, type Ctx } from './store';

export interface Counts {
  new: number;
  learning: number;
  review: number;
}

export interface DeckNode {
  deck: Deck;
  path: string;
  depth: number;
  /** What is available to study today in this deck and beneath it, after daily limits. */
  due: Counts;
  /** All live cards in this deck and beneath it. */
  total: number;
  hasChildren: boolean;
}

interface StudyState {
  index: DeckIndex;
  /** Cards available today in each deck itself, before limits. */
  own: Map<string, Counts>;
  totals: Map<string, number>;
  /** Remaining daily allowance per deck, counting what was studied today in its subtree. */
  budget: Map<string, { new: number; review: number }>;
  dayEnd: number;
}

async function loadStudyState(ctx: Ctx): Promise<StudyState> {
  const tx = ctx.tx;
  const index = await loadDecks(tx);
  const dayStart = studyDayStart(ctx.now, ctx.tzOffsetMinutes);
  const dayEnd = dayStart + DAY_MS;

  const avail = await tx
    .select({
      deckId: cards.deckId,
      total: sql<number>`count(*)`,
      new: sql<number>`sum(${cards.suspended} = 0 AND ${cards.state} = ${State.New})`,
      learning: sql<number>`sum(${cards.suspended} = 0 AND ${cards.state} IN (${State.Learning}, ${State.Relearning}) AND ${cards.due} < ${dayEnd})`,
      review: sql<number>`sum(${cards.suspended} = 0 AND ${cards.state} = ${State.Review} AND ${cards.due} < ${dayEnd})`,
    })
    .from(cards)
    .where(isNull(cards.deletedAt))
    .groupBy(cards.deckId);

  const done = await tx
    .select({
      deckId: cards.deckId,
      new: sql<number>`sum(json_extract(${reviewLog.stateBefore}, '$.state') = ${State.New})`,
      review: sql<number>`sum(json_extract(${reviewLog.stateBefore}, '$.state') = ${State.Review})`,
    })
    .from(reviewLog)
    .innerJoin(cards, eq(cards.id, reviewLog.cardId))
    .where(and(isNull(reviewLog.deletedAt), sql`${reviewLog.reviewedAt} >= ${dayStart}`))
    .groupBy(cards.deckId);

  const own = new Map<string, Counts>();
  const totals = new Map<string, number>();
  for (const r of avail) {
    own.set(r.deckId, { new: Number(r.new ?? 0), learning: Number(r.learning ?? 0), review: Number(r.review ?? 0) });
    totals.set(r.deckId, Number(r.total));
  }
  const doneOwn = new Map(done.map((r) => [r.deckId, { new: Number(r.new ?? 0), review: Number(r.review ?? 0) }]));

  const budget = new Map<string, { new: number; review: number }>();
  for (const d of index.byId.values()) {
    let n = 0;
    let r = 0;
    for (const s of subtree(index, d.id)) {
      n += doneOwn.get(s.id)?.new ?? 0;
      r += doneOwn.get(s.id)?.review ?? 0;
    }
    budget.set(d.id, { new: Math.max(0, d.newPerDay - n), review: Math.max(0, d.reviewsPerDay - r) });
  }
  return { index, own, totals, budget, dayEnd };
}

/** Counts for a deck's subtree, each level capped by its own remaining allowance. */
function cappedCounts(s: StudyState, deckId: string): Counts & { total: number } {
  const own = s.own.get(deckId) ?? { new: 0, learning: 0, review: 0 };
  const sum = { ...own, total: s.totals.get(deckId) ?? 0 };
  for (const c of s.index.children.get(deckId) ?? []) {
    const k = cappedCounts(s, c.id);
    sum.new += k.new;
    sum.learning += k.learning;
    sum.review += k.review;
    sum.total += k.total;
  }
  const b = s.budget.get(deckId)!;
  sum.new = Math.min(sum.new, b.new);
  sum.review = Math.min(sum.review, b.review);
  return sum;
}

/** What studying `deckId` offers today: its capped counts, further capped by every ancestor. */
function countsFor(s: StudyState, deckId: string): Counts & { total: number } {
  const c = cappedCounts(s, deckId);
  for (const a of ancestry(s.index, deckId).slice(1)) {
    const b = s.budget.get(a.id)!;
    c.new = Math.min(c.new, b.new);
    c.review = Math.min(c.review, b.review);
  }
  return c;
}

export async function deckTree(ctx: Ctx): Promise<DeckNode[]> {
  const s = await loadStudyState(ctx);
  const out: DeckNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const deck of s.index.children.get(parent) ?? []) {
      const { total, ...due } = countsFor(s, deck.id);
      out.push({
        deck,
        path: deckPath(s.index, deck.id),
        depth,
        due,
        total,
        hasChildren: (s.index.children.get(deck.id) ?? []).length > 0,
      });
      walk(deck.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export interface StudyCard {
  card: Card;
  noteId: string;
  deckPath: string;
  front: string;
  back: string;
  css: string;
  warnings: string[];
  /** When the card would next be due for each rating (1 Again … 4 Easy). */
  nextDue: Record<Rating, number>;
}

export interface StudyStep {
  counts: Counts;
  card: StudyCard | null;
  /** If nothing is ready now but a learning card comes due later today, when. */
  waitUntil: number | null;
}

export async function renderStudyCard(ctx: Ctx, card: Card, index?: DeckIndex): Promise<StudyCard> {
  const tx = ctx.tx;
  index ??= await loadDecks(tx);
  const note = (await tx.select().from(notes).where(eq(notes.id, card.noteId)))[0];
  if (!note) throw new DkError('not_found', 'The note for this card is missing.');
  const nt = await requireNoteType(tx, note.noteTypeId);
  const tpl = nt.kind === 'cloze' ? nt.templates[0] : nt.templates.find((t) => t.ordinal === card.ordinal);
  if (!tpl) throw new DkError('not_found', 'The template for this card is missing.');
  const path = deckPath(index, card.deckId);
  const r = renderCard({
    kind: nt.kind,
    fieldNames: nt.fields,
    fieldValues: note.fields,
    front: tpl.front,
    back: tpl.back,
    ordinal: card.ordinal,
    templateName: tpl.name,
    noteTypeName: nt.name,
    deckName: path,
    tags: note.tags,
  });
  const retention = index.byId.get(card.deckId)?.desiredRetention ?? 0.9;
  return {
    card,
    noteId: note.id,
    deckPath: path,
    front: r.front,
    back: r.back,
    css: nt.css,
    warnings: r.warnings,
    nextDue: previewDue(schedOf(card), ctx.now, { retention, fuzz: false }),
  };
}

/**
 * The next card to study in a deck (and everything beneath it), honouring daily limits.
 * Cards in `skip` are passed over; they still count as due.
 */
export async function nextStudyStep(ctx: Ctx, deckId: string, skip: string[] = []): Promise<StudyStep> {
  const tx = ctx.tx;
  const s = await loadStudyState(ctx);
  if (!s.index.byId.has(deckId)) throw new DkError('not_found', 'That deck does not exist.');
  const { total: _total, ...counts } = countsFor(s, deckId);
  const tree = subtree(s.index, deckId);
  const ids = tree.map((d) => d.id);
  const open = (kind: 'new' | 'review') =>
    tree.filter((d) => ancestry(s.index, d.id).every((a) => s.budget.get(a.id)![kind] > 0)).map((d) => d.id);
  const live = and(isNull(cards.deletedAt), eq(cards.suspended, false), skip.length ? notInArray(cards.id, skip) : undefined);
  const first = async (where: ReturnType<typeof and>, order: 'due' | 'id'): Promise<Card | undefined> =>
    (
      await tx
        .select()
        .from(cards)
        .where(and(live, where))
        .orderBy(order === 'due' ? asc(cards.due) : asc(cards.id))
        .limit(1)
    )[0];

  const learning = sql`${cards.state} IN (${State.Learning}, ${State.Relearning})`;
  let pick = await first(and(inArray(cards.deckId, ids), learning, sql`${cards.due} <= ${ctx.now}`), 'due');
  const reviewDecks = open('review');
  if (!pick && reviewDecks.length) {
    pick = await first(
      and(inArray(cards.deckId, reviewDecks), eq(cards.state, State.Review), sql`${cards.due} < ${s.dayEnd}`),
      'due',
    );
  }
  const newDecks = open('new');
  if (!pick && newDecks.length) pick = await first(and(inArray(cards.deckId, newDecks), eq(cards.state, State.New)), 'id');

  let waitUntil: number | null = null;
  if (!pick) {
    const later = await first(and(inArray(cards.deckId, ids), learning, sql`${cards.due} < ${s.dayEnd}`), 'due');
    if (later && later.due <= ctx.now + LEARN_AHEAD_MS) pick = later;
    else if (later) waitUntil = later.due;
  }
  return { counts, card: pick ? await renderStudyCard(ctx, pick, s.index) : null, waitUntil };
}

/** Records an answer: reschedules the card and appends to the review log. */
export async function answerCard(ctx: Ctx, cardId: string, rating: Rating, durationMs: number): Promise<Card> {
  const card = (await ctx.tx.select().from(cards).where(and(eq(cards.id, cardId), isNull(cards.deletedAt))))[0];
  if (!card) throw new DkError('not_found', 'That card does not exist.');
  if (![1, 2, 3, 4].includes(rating)) throw new DkError('invalid', 'Rating must be 1–4.');
  const index = await loadDecks(ctx.tx);
  const retention = index.byId.get(card.deckId)?.desiredRetention ?? 0.9;
  const before = schedOf(card);
  const after = schedule(before, rating, ctx.now, { retention, fuzz: ctx.fuzz });
  const saved = await put(ctx, 'cards', { ...card, ...after });
  await put(ctx, 'review_log', {
    id: uuidv7(ctx.now),
    deletedAt: null,
    cardId,
    rating,
    reviewedAt: ctx.now,
    stateBefore: before,
    elapsedDays: before.lastReview === null ? 0 : (ctx.now - before.lastReview) / DAY_MS,
    scheduledDays: (after.due - ctx.now) / DAY_MS,
    durationMs: Math.max(0, Math.min(Math.round(durationMs), 10 * 60_000)),
    deviceId: ctx.deviceId,
  });
  return saved;
}

/**
 * Undoes this device's most recent review: the card returns to its prior
 * scheduling state and the log entry is marked deleted. Returns the card, or
 * null if there is nothing to undo.
 */
export async function undoLastReview(ctx: Ctx): Promise<Card | null> {
  const last = (
    await ctx.tx
      .select()
      .from(reviewLog)
      .where(and(isNull(reviewLog.deletedAt), eq(reviewLog.deviceId, ctx.deviceId)))
      .orderBy(desc(reviewLog.reviewedAt), desc(reviewLog.id))
      .limit(1)
  )[0];
  if (!last) return null;
  await put(ctx, 'review_log', { ...last, deletedAt: ctx.now });
  const card = (await ctx.tx.select().from(cards).where(eq(cards.id, last.cardId)))[0];
  if (!card || card.deletedAt !== null) return null;
  return put(ctx, 'cards', { ...card, ...last.stateBefore });
}

/** Cram: every unsuspended card in the deck and beneath it, regardless of schedule. Changes nothing. */
export async function cramCardIds(tx: DbOrTx, deckId: string): Promise<string[]> {
  const index = await loadDecks(tx);
  const ids = subtree(index, deckId).map((d) => d.id);
  if (!ids.length) throw new DkError('not_found', 'That deck does not exist.');
  const rows = await tx
    .select({ id: cards.id })
    .from(cards)
    .where(and(inArray(cards.deckId, ids), isNull(cards.deletedAt), eq(cards.suspended, false)))
    .orderBy(asc(cards.id));
  return rows.map((r) => r.id);
}
