import { describe, expect, it } from 'vitest';
import { BASIC_ID, BASIC_REVERSED_ID, CLOZE_ID, DAY_MS, State, outbox } from '../src';
import { T0, testCollection } from './helpers';

const HOUR = 3_600_000;

async function seed(n: number, deckName = 'Deck') {
  const t = await testCollection();
  const deck = await t.col.createDeck({ name: deckName });
  for (let i = 0; i < n; i++) {
    await t.col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: [`q${i}`, `a${i}`] });
  }
  return { ...t, deck };
}

describe('decks', () => {
  it('nests decks and reports full paths', async () => {
    const { col } = await testCollection();
    const lang = await col.createDeck({ name: 'Languages' });
    const es = await col.createDeck({ name: 'Spanish', parentId: lang.id });
    await col.createDeck({ name: 'Verbs', parentId: es.id });
    const tree = await col.deckTree();
    expect(tree.map((n) => [n.path, n.depth])).toEqual([
      ['Languages', 0],
      ['Languages::Spanish', 1],
      ['Languages::Spanish::Verbs', 2],
    ]);
    expect(tree[0]!.hasChildren).toBe(true);
  });

  it('creates missing parents from a path and reuses existing ones', async () => {
    const { col } = await testCollection();
    const a = await col.ensureDeckPath('A::B::C');
    const b = await col.ensureDeckPath('a::b::D');
    expect(a.parentId).toBe(b.parentId);
    expect((await col.deckTree()).map((n) => n.path)).toEqual(['A', 'A::B', 'A::B::C', 'A::B::D']);
  });

  it('rejects duplicate siblings, bad names and moving a deck into itself', async () => {
    const { col } = await testCollection();
    const a = await col.createDeck({ name: 'A' });
    const b = await col.createDeck({ name: 'B', parentId: a.id });
    await expect(col.createDeck({ name: 'a' })).rejects.toThrow(/already exists/);
    await expect(col.createDeck({ name: ' ' })).rejects.toThrow(/needs a name/);
    await expect(col.createDeck({ name: 'x::y' })).rejects.toThrow(/::/);
    await expect(col.updateDeck(a.id, { parentId: b.id })).rejects.toThrow(/inside itself/);
    await expect(col.updateDeck(a.id, { desiredRetention: 0.5 })).rejects.toThrow(/retention/);
  });

  it('deleting a deck deletes its sub-decks, cards and notes', async () => {
    const { col } = await testCollection();
    const a = await col.createDeck({ name: 'A' });
    const b = await col.createDeck({ name: 'B', parentId: a.id });
    const keep = await col.createDeck({ name: 'Keep' });
    await col.addNote({ noteTypeId: BASIC_ID, deckId: b.id, fields: ['q', 'a'] });
    await col.addNote({ noteTypeId: BASIC_ID, deckId: keep.id, fields: ['q2', 'a2'] });
    expect(await col.deleteDeck(a.id)).toEqual({ decks: 2, cards: 1, notes: 1 });
    expect((await col.deckTree()).map((n) => n.path)).toEqual(['Keep']);
    expect((await col.searchCards('')).total).toBe(1);
  });

  it('keeps a note whose other card lives in a surviving deck', async () => {
    const { col } = await testCollection();
    const a = await col.createDeck({ name: 'A' });
    const b = await col.createDeck({ name: 'B' });
    const { note, cards } = await col.addNote({ noteTypeId: BASIC_REVERSED_ID, deckId: a.id, fields: ['q', 'a'] });
    await col.moveCards([cards[1]!.id], b.id);
    expect((await col.deleteDeck(a.id)).notes).toBe(0);
    expect((await col.getNote(note.id)).cards).toHaveLength(1);
  });
});

describe('notes and cards', () => {
  it('seeds the three built-in note types', async () => {
    const { col } = await testCollection();
    const types = await col.listNoteTypes();
    expect(types.map((t) => t.name)).toEqual(['Basic', 'Basic (and reversed card)', 'Cloze']);
    expect(types.map((t) => t.templates.length)).toEqual([1, 2, 1]);
  });

  it('generates cards per note type', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    const basic = await col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['q', 'a'] });
    const reversed = await col.addNote({ noteTypeId: BASIC_REVERSED_ID, deckId: deck.id, fields: { Front: 'q', Back: 'a' } });
    const cloze = await col.addNote({ noteTypeId: CLOZE_ID, deckId: deck.id, fields: ['{{c1::a}} {{c2::b}} {{c3::c}}'] });
    expect(basic.cards.map((c) => c.ordinal)).toEqual([0]);
    expect(reversed.cards.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(cloze.cards.map((c) => c.ordinal)).toEqual([1, 2, 3]);
    expect(basic.cards[0]!.state).toBe(State.New);
  });

  it('rejects an empty first field and unknown field names', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    await expect(col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['<br>', 'a'] })).rejects.toThrow(/empty/);
    await expect(col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: { Question: 'q' } })).rejects.toThrow(/Unknown field/);
  });

  it('reconciles cards when a note is edited, keeping the schedule of survivors', async () => {
    const { col, clock } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    const { note, cards } = await col.addNote({ noteTypeId: CLOZE_ID, deckId: deck.id, fields: ['{{c1::a}} {{c2::b}}'] });
    await col.answerCard(cards[0]!.id, 4, 1000);
    clock.advance(1000);
    const edited = await col.updateNote(note.id, { fields: { Text: '{{c1::a}} {{c3::c}}' } });
    expect(edited.cards.map((c) => c.ordinal)).toEqual([1, 3]);
    expect(edited.cards[0]!.id).toBe(cards[0]!.id);
    expect(edited.cards[0]!.state).toBe(State.Review);
    expect(edited.cards[1]!.state).toBe(State.New);
  });

  it('normalises and bulk-edits tags', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    const a = await col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['q1', 'a'], tags: ['Verb', 'verb', 'two words'] });
    const b = await col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['q2', 'a'] });
    expect(a.note.tags).toEqual(['two_words', 'Verb']);
    expect(await col.changeTags([a.note.id, b.note.id], ['hard'], ['VERB'])).toBe(2);
    expect(await col.listTags()).toEqual([
      { tag: 'hard', count: 2 },
      { tag: 'two_words', count: 1 },
    ]);
  });

  it('finds duplicates by first-field text within a deck', async () => {
    const { col } = await testCollection();
    const d1 = await col.createDeck({ name: 'D1' });
    const d2 = await col.createDeck({ name: 'D2' });
    await col.addNote({ noteTypeId: BASIC_ID, deckId: d1.id, fields: ['<b>Hola</b>', 'hello'] });
    expect(await col.findDuplicate(d1.id, BASIC_ID, 'hola')).not.toBeNull();
    expect(await col.findDuplicate(d2.id, BASIC_ID, 'hola')).toBeNull();
    expect(await col.findDuplicate(d1.id, BASIC_ID, 'adios')).toBeNull();
  });

  it('deleting a card deletes its note and siblings', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    const { cards } = await col.addNote({ noteTypeId: BASIC_REVERSED_ID, deckId: deck.id, fields: ['q', 'a'] });
    expect(await col.deleteCards([cards[0]!.id])).toBe(1);
    expect((await col.searchCards('')).total).toBe(0);
  });

  it('queues every write in the outbox', async () => {
    const { col } = await testCollection();
    const before = (await col.db.select().from(outbox)).length;
    const deck = await col.createDeck({ name: 'D' });
    await col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['q', 'a'] });
    const rows = (await col.db.select().from(outbox)).slice(before);
    expect(rows.map((r) => r.tableName)).toEqual(['decks', 'notes', 'cards']);
  });

  it('rolls back the whole operation when part of it fails', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    await expect(
      col.run(async (ctx) => {
        const { addNote } = await import('../src/notes');
        await addNote(ctx, { noteTypeId: BASIC_ID, deckId: deck.id, fields: ['q', 'a'] });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await col.searchCards('')).total).toBe(0);
    // The collection is still usable afterwards.
    await col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['q', 'a'] });
    expect((await col.searchCards('')).total).toBe(1);
  });
});

describe('search', () => {
  async function fixture() {
    const t = await testCollection();
    const lang = await t.col.createDeck({ name: 'Languages' });
    const es = await t.col.createDeck({ name: 'Spanish', parentId: lang.id });
    const other = await t.col.createDeck({ name: 'Other' });
    await t.col.addNote({ noteTypeId: BASIC_ID, deckId: es.id, fields: ['perro', 'dog'], tags: ['animal'] });
    await t.col.addNote({ noteTypeId: BASIC_ID, deckId: es.id, fields: ['gato', 'cat'], tags: ['animal', 'pet'] });
    await t.col.addNote({ noteTypeId: CLOZE_ID, deckId: other.id, fields: ['100% of {{c1::dogs}} bark'] });
    return t;
  }
  const previews = async (col: Awaited<ReturnType<typeof fixture>>['col'], q: string) =>
    (await col.searchCards(q)).rows.map((r) => r.preview);

  it('matches text in any field', async () => {
    const { col } = await fixture();
    expect(await previews(col, 'dog')).toEqual(['perro', '100% of {{c1::dogs}} bark']);
    expect(await previews(col, 'dog perro')).toEqual(['perro']);
    expect(await previews(col, '100%')).toEqual(['100% of {{c1::dogs}} bark']);
    expect(await previews(col, 'nothing')).toEqual([]);
  });

  it('filters by deck (with sub-decks), tag, note type and state', async () => {
    const { col } = await fixture();
    expect(await previews(col, 'deck:Languages')).toEqual(['perro', 'gato']);
    expect(await previews(col, 'deck:"Languages::Spanish" tag:pet')).toEqual(['gato']);
    expect(await previews(col, 'tag:animal -tag:pet')).toEqual(['perro']);
    expect(await previews(col, 'note:Cloze')).toEqual(['100% of {{c1::dogs}} bark']);
    expect(await previews(col, 'is:new')).toHaveLength(3);
    expect(await previews(col, 'is:review')).toHaveLength(0);
  });

  it('finds suspended and due cards, and pages results', async () => {
    const { col, clock } = await fixture();
    const all = await col.searchCards('');
    await col.setSuspended([all.rows[0]!.card.id], true);
    expect(await previews(col, 'is:suspended')).toEqual(['perro']);
    await col.answerCard(all.rows[1]!.card.id, 4, 0);
    expect(await previews(col, 'is:due')).toEqual([]);
    clock.days(60);
    expect(await previews(col, 'is:due')).toEqual(['gato']);
    const page = await col.searchCards('', { limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => r.preview)).toEqual(['gato']);
  });
});

describe('study', () => {
  it('offers new cards in creation order and renders both sides', async () => {
    const { col, deck } = await seed(3);
    const step = await col.nextStudyStep(deck.id);
    expect(step.counts).toEqual({ new: 3, learning: 0, review: 0 });
    expect(step.card!.front).toBe('q0');
    expect(step.card!.back).toContain('a0');
    expect(step.card!.nextDue[4]).toBeGreaterThan(step.card!.nextDue[1]);
  });

  it('caps new cards at the daily limit and resets at the 04:00 rollover', async () => {
    const { col, clock, deck } = await seed(5);
    await col.updateDeck(deck.id, { newPerDay: 2 });
    expect((await col.nextStudyStep(deck.id)).counts.new).toBe(2);
    for (let i = 0; i < 2; i++) {
      const step = await col.nextStudyStep(deck.id);
      await col.answerCard(step.card!.card.id, 4, 1000);
      clock.advance(1000);
    }
    const done = await col.nextStudyStep(deck.id);
    expect(done.card).toBeNull();
    expect(done.counts).toEqual({ new: 0, learning: 0, review: 0 });

    // 03:59 the next morning is still the same study day.
    clock.now = T0 + DAY_MS - 8 * HOUR - 60_000;
    expect((await col.nextStudyStep(deck.id)).counts.new).toBe(0);
    // 04:00 starts a new one.
    clock.now = T0 + DAY_MS - 8 * HOUR;
    const next = await col.nextStudyStep(deck.id);
    expect(next.counts.new).toBe(2);
    expect(next.card!.front).toBe('q2');
  });

  it('caps a child deck by its parent’s limit', async () => {
    const { col } = await testCollection();
    const parent = await col.createDeck({ name: 'P' });
    const a = await col.createDeck({ name: 'A', parentId: parent.id });
    const b = await col.createDeck({ name: 'B', parentId: parent.id });
    for (let i = 0; i < 4; i++) {
      await col.addNote({ noteTypeId: BASIC_ID, deckId: a.id, fields: [`a${i}`, 'x'] });
      await col.addNote({ noteTypeId: BASIC_ID, deckId: b.id, fields: [`b${i}`, 'x'] });
    }
    await col.updateDeck(parent.id, { newPerDay: 3 });
    const tree = async () => Object.fromEntries((await col.deckTree()).map((n) => [n.deck.name, n.due.new]));
    expect(await tree()).toEqual({ P: 3, A: 3, B: 3 });

    // Studying the child spends the parent's allowance too.
    for (let i = 0; i < 2; i++) {
      const step = await col.nextStudyStep(a.id);
      await col.answerCard(step.card!.card.id, 4, 0);
    }
    expect(await tree()).toEqual({ P: 1, A: 1, B: 1 });
    const viaParent = await col.nextStudyStep(parent.id);
    await col.answerCard(viaParent.card!.card.id, 4, 0);
    expect(await tree()).toEqual({ P: 0, A: 0, B: 0 });
    expect((await col.nextStudyStep(b.id)).card).toBeNull();
  });

  it('studying a folder includes cards from every deck beneath it', async () => {
    const { col } = await testCollection();
    const parent = await col.createDeck({ name: 'P' });
    const child = await col.createDeck({ name: 'C', parentId: parent.id });
    const grand = await col.createDeck({ name: 'G', parentId: child.id });
    await col.addNote({ noteTypeId: BASIC_ID, deckId: grand.id, fields: ['deep', 'x'] });
    const step = await col.nextStudyStep(parent.id);
    expect(step.counts.new).toBe(1);
    expect(step.card!.front).toBe('deep');
    expect(step.card!.deckPath).toBe('P::C::G');
  });

  it('shows learning cards again within the session, then reviews on later days', async () => {
    const { col, clock, deck } = await seed(1);
    const first = await col.nextStudyStep(deck.id);
    await col.answerCard(first.card!.card.id, 3, 1000);

    // Still learning: comes back the same day (learn-ahead), not counted as new.
    const again = await col.nextStudyStep(deck.id);
    expect(again.counts).toEqual({ new: 0, learning: 1, review: 0 });
    expect(again.card!.card.state).toBe(State.Learning);

    clock.advance(15 * 60_000);
    const graduated = await col.answerCard(again.card!.card.id, 3, 1000);
    expect(graduated.state).toBe(State.Review);
    expect((await col.nextStudyStep(deck.id)).card).toBeNull();

    // On the day it falls due it is offered as a review.
    clock.now = graduated.due;
    const due = await col.nextStudyStep(deck.id);
    expect(due.counts).toEqual({ new: 0, learning: 0, review: 1 });
    expect(due.card!.card.id).toBe(first.card!.card.id);
  });

  it('reports when the next learning card is due if it is more than 20 minutes away', async () => {
    const { col, clock, deck } = await seed(1);
    const step = await col.nextStudyStep(deck.id);
    const review = await col.answerCard(step.card!.card.id, 4, 0);
    clock.now = review.due;
    const lapsed = await col.answerCard(review.id, 1, 0);
    expect(lapsed.state).toBe(State.Relearning);
    await col.run(async (ctx) => {
      const { put } = await import('../src/store');
      await put(ctx, 'cards', { ...lapsed, due: clock.now + HOUR });
    });
    const waiting = await col.nextStudyStep(deck.id);
    expect(waiting.card).toBeNull();
    expect(waiting.waitUntil).toBe(clock.now + HOUR);
  });

  it('simulates a fortnight of daily study', async () => {
    const { col, clock, deck } = await seed(30);
    await col.updateDeck(deck.id, { newPerDay: 10 });
    const perDay: number[] = [];
    for (let day = 0; day < 14; day++) {
      clock.now = T0 + day * DAY_MS;
      let answered = 0;
      for (let guard = 0; guard < 500; guard++) {
        const step = await col.nextStudyStep(deck.id);
        if (!step.card) {
          if (step.waitUntil === null) break;
          clock.now = step.waitUntil;
          continue;
        }
        await col.answerCard(step.card.card.id, 3, 2000);
        clock.advance(10_000);
        answered++;
      }
      perDay.push(answered);
    }
    // 10 new cards a day for three days, each seen twice (learning step, then graduation).
    expect(perDay.slice(0, 3).every((n) => n >= 20)).toBe(true);
    const all = await col.searchCards('', { limit: 100 });
    expect(all.rows.every((r) => r.card.state === State.Review)).toBe(true);
    expect(all.rows.every((r) => r.card.due > clock.now)).toBe(true);
    // Reviews keep arriving on later days.
    expect(perDay.slice(3).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(30);
  });

  it('undoes the last review, restoring the schedule and the daily allowance', async () => {
    const { col, deck } = await seed(2);
    await col.updateDeck(deck.id, { newPerDay: 1 });
    const step = await col.nextStudyStep(deck.id);
    await col.answerCard(step.card!.card.id, 4, 0);
    expect((await col.nextStudyStep(deck.id)).card).toBeNull();

    const undone = await col.undoLastReview();
    expect(undone!.id).toBe(step.card!.card.id);
    expect(undone!.state).toBe(State.New);
    expect(undone!.reps).toBe(0);
    const back = await col.nextStudyStep(deck.id);
    expect(back.counts.new).toBe(1);
    expect(back.card!.card.id).toBe(step.card!.card.id);
    expect(await col.undoLastReview()).toBeNull();
  });

  it('skips suspended cards until they are unsuspended', async () => {
    const { col, deck } = await seed(2);
    const first = (await col.nextStudyStep(deck.id)).card!;
    await col.setSuspended([first.card.id], true);
    const step = await col.nextStudyStep(deck.id);
    expect(step.counts.new).toBe(1);
    expect(step.card!.front).toBe('q1');
    await col.setSuspended([first.card.id], false);
    expect((await col.nextStudyStep(deck.id)).card!.front).toBe('q0');
  });

  it('cram lists every card regardless of schedule and changes nothing', async () => {
    const { col, deck } = await seed(3);
    await col.updateDeck(deck.id, { newPerDay: 0 });
    const step = await col.nextStudyStep(deck.id);
    expect(step.card).toBeNull();
    const ids = await col.cramCardIds(deck.id);
    expect(ids).toHaveLength(3);
    const shown = await col.renderCardById(ids[0]!);
    expect(shown.front).toBe('q0');
    const after = await col.searchCards('');
    expect(after.rows.every((r) => r.card.state === State.New && r.card.reps === 0)).toBe(true);
  });

  it('uses each deck’s desired retention', async () => {
    const { col } = await testCollection();
    const relaxed = await col.createDeck({ name: 'Relaxed' });
    const strict = await col.createDeck({ name: 'Strict' });
    await col.updateDeck(relaxed.id, { desiredRetention: 0.8 });
    await col.updateDeck(strict.id, { desiredRetention: 0.95 });
    const a = await col.addNote({ noteTypeId: BASIC_ID, deckId: relaxed.id, fields: ['q', 'a'] });
    const b = await col.addNote({ noteTypeId: BASIC_ID, deckId: strict.id, fields: ['q', 'a'] });
    const ra = await col.answerCard(a.cards[0]!.id, 4, 0);
    const rb = await col.answerCard(b.cards[0]!.id, 4, 0);
    expect(rb.due).toBeLessThan(ra.due);
  });
});
