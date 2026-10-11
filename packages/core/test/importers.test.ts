import { describe, expect, it } from 'vitest';
import { AnkiImport, BASIC_ID, CLOZE_ID, DAY_MS, parseDelimited, reviewLog, State, type AnkiCard, type AnkiModel, type AnkiNote } from '../src';
import { T0, testCollection } from './helpers';

describe('CSV and TSV parsing', () => {
  it('detects the delimiter', () => {
    expect(parseDelimited('a,b\nc,d')).toMatchObject({ delimiter: ',', rows: [['a', 'b'], ['c', 'd']], columns: 2 });
    expect(parseDelimited('a\tb, c\nd\te').rows).toEqual([['a', 'b, c'], ['d', 'e']]);
    expect(parseDelimited('a;b;c\n1;2;3').delimiter).toBe(';');
  });

  it('handles quotes, doubled quotes, line breaks in fields, CRLF and a BOM', () => {
    const t = parseDelimited('﻿"hello, world","say ""hi"""\r\n"two\nlines",plain\r\n');
    expect(t.rows).toEqual([
      ['hello, world', 'say "hi"'],
      ['two\nlines', 'plain'],
    ]);
  });

  it('skips blank lines and Anki header lines, honouring #separator', () => {
    const t = parseDelimited('#separator:tab\n#html:true\nq\ta,b\n\n\nq2\ta2\n');
    expect(t.delimiter).toBe('\t');
    expect(t.rows).toEqual([['q', 'a,b'], ['q2', 'a2']]);
  });

  it('keeps ragged rows and reports the widest', () => {
    expect(parseDelimited('a,b,c\nd')).toMatchObject({ rows: [['a', 'b', 'c'], ['d']], columns: 3 });
  });
});

describe('row import', () => {
  it('maps columns to fields, tags and decks', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'Inbox' });
    const rows = [
      ['Front', 'Back', 'Tags', 'Deck'],
      ['perro', 'dog', 'animal noun', ''],
      ['gato', 'cat', '', 'Languages::Spanish'],
      ['a < b', 'line one\nline two', '', ''],
    ];
    const r = await col.importRows(rows, {
      noteTypeId: BASIC_ID,
      deckId: deck.id,
      mapping: [{ field: 0 }, { field: 1 }, 'tags', 'deck'],
      skipFirstRow: true,
      tags: ['imported'],
    });
    expect(r).toEqual({ added: 3, cards: 3, duplicates: 0, errors: [] });
    expect((await col.deckTree()).map((n) => [n.path, n.total])).toEqual([['Inbox', 2], ['Languages', 1], ['Languages::Spanish', 1]]);
    const found = await col.searchCards('tag:noun');
    expect(found.rows[0]!.note.tags).toEqual(['animal', 'imported', 'noun']);
    // Plain text is escaped and its line breaks kept.
    const special = (await col.searchCards('line')).rows[0]!.note.fields;
    expect(special).toEqual(['a &lt; b', 'line one<br>line two']);
  });

  it('skips duplicates and reports bad rows without stopping', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    await col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['perro', 'dog'] });
    const opts = { noteTypeId: BASIC_ID, deckId: deck.id, mapping: [{ field: 0 }, { field: 1 }] as const };
    const r = await col.importRows([['perro', 'hound'], ['gato', 'cat'], ['', 'no front'], ['gato', 'again']], { ...opts, mapping: [...opts.mapping] });
    expect(r).toEqual({ added: 1, cards: 1, duplicates: 2, errors: [{ row: 3, message: 'The first field (Front) is empty.' }] });
    const again = await col.importRows([['perro', 'hound']], { ...opts, mapping: [...opts.mapping], allowDuplicates: true });
    expect(again.added).toBe(1);
  });

  it('imports cloze rows and keeps HTML as HTML', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    const r = await col.importRows([['<b>{{c1::Paris}}</b> and {{c2::Rome}}']], { noteTypeId: CLOZE_ID, deckId: deck.id, mapping: [{ field: 0 }] });
    expect(r).toMatchObject({ added: 1, cards: 2 });
    expect((await col.searchCards('')).rows[0]!.note.fields[0]).toBe('<b>{{c1::Paris}}</b> and {{c2::Rome}}');
  });

  it('insists on a column for the first field', async () => {
    const { col } = await testCollection();
    const deck = await col.createDeck({ name: 'D' });
    await expect(col.importRows([['x']], { noteTypeId: BASIC_ID, deckId: deck.id, mapping: [{ field: 1 }] })).rejects.toThrow(/which column holds "Front"/);
  });
});

describe('backup export', () => {
  it('exports every table as JSON and notes as CSV', async () => {
    const { col } = await testCollection();
    const deck = await col.ensureDeckPath('Languages::Spanish');
    const { cards } = await col.addNote({ noteTypeId: BASIC_ID, deckId: deck.id, fields: ['say "hola"', 'a, b'], tags: ['x', 'y'] });
    await col.answerCard(cards[0]!.id, 3, 100);
    const backup = await col.exportBackup();
    expect(backup).toMatchObject({ format: 'downloadknowledge-backup', version: 1 });
    expect(Object.fromEntries(Object.entries(backup.tables).map(([k, v]) => [k, v.length]))).toEqual({
      decks: 2, note_types: 3, templates: 4, notes: 1, cards: 1, review_log: 1, media: 0, agent_batches: 0,
    });
    expect(JSON.parse(JSON.stringify(backup))).toEqual(backup);

    const csv = await col.exportNotesCsv();
    expect(csv).toBe('deck,note_type,tags,field_1,field_2\r\nLanguages::Spanish,Basic,x y,"say ""hola""","a, b"\r\n');
    // And it reads back.
    expect(parseDelimited(csv).rows[1]).toEqual(['Languages::Spanish', 'Basic', 'x y', 'say "hola"', 'a, b']);
  });
});

describe('Anki import', () => {
  const CRT = Math.floor(T0 / 1000) - 100 * 86_400; // The collection was created 100 days ago.
  const models: AnkiModel[] = [
    { id: '1', name: 'Basic', kind: 'standard', fields: ['Front', 'Back'], css: '.card{}', templates: [{ ord: 0, name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}<hr id="answer">{{Back}}' }] },
    {
      id: '2', name: 'Vocab', kind: 'standard', fields: ['Word', 'Meaning', 'Audio'], css: '.card { color: navy; }',
      templates: [
        { ord: 0, name: 'Recognise', front: '{{Word}}<script>go()</script>', back: '{{FrontSide}}<hr>{{Meaning}}{{furigana:Word}}' },
        { ord: 1, name: 'Recall', front: '{{Meaning}} {{type:Word}}', back: '{{Word}}' },
      ],
    },
    { id: '3', name: 'Cloze', kind: 'cloze', fields: ['Text', 'Back Extra'], css: '', templates: [{ ord: 0, name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}<br>{{Back Extra}}' }] },
  ];
  const decks = [{ id: '1', name: 'Default' }, { id: '10', name: 'Japanese::Core' }, { id: '11', name: 'Geo' }];
  const ankiNotes: AnkiNote[] = [
    { id: '100', guid: 'gA', modelId: '2', fields: ['犬', 'dog', '[sound:inu.mp3]'], tags: ' animal  n5 ' },
    { id: '101', guid: 'gB', modelId: '3', fields: ['{{c1::Tokyo}} is in {{c2::Japan}}', ''], tags: '' },
    { id: '102', guid: 'gC', modelId: '1', fields: ['front', 'back'], tags: '' },
    { id: '103', guid: 'gD', modelId: '99', fields: ['orphan'], tags: '' },
  ];
  const card = (c: Partial<AnkiCard> & Pick<AnkiCard, 'id' | 'noteId'>): AnkiCard => ({ deckId: '10', ord: 0, type: 0, queue: 0, due: 0, ivl: 0, factor: 0, reps: 0, lapses: 0, data: '', ...c });
  const ankiCards: AnkiCard[] = [
    card({ id: '1000', noteId: '100', ord: 0, type: 2, queue: 2, due: 110, ivl: 30, factor: 2500, reps: 8, lapses: 1 }), // SM-2 review, due in 10 days
    card({ id: '1001', noteId: '100', ord: 1, type: 2, queue: -1, due: 95, ivl: 12, factor: 2100, reps: 5, data: '{"s":14.5,"d":6.2}' }), // FSRS, overdue, suspended
    card({ id: '1002', noteId: '101', ord: 0, deckId: '11', type: 1, queue: 1, due: 1_700_000_000, reps: 1 }), // mid-learning
    card({ id: '1003', noteId: '101', ord: 1, deckId: '11' }), // new
    card({ id: '1004', noteId: '102', ord: 0 }),
    card({ id: '1005', noteId: '103', ord: 0 }), // its note was skipped
  ];
  const reviews = [
    { id: T0 - 40 * DAY_MS, cardId: '1000', ease: 3, type: 0, ivl: -600, lastIvl: -60, time: 7000 },
    { id: T0 - 39 * DAY_MS, cardId: '1000', ease: 3, type: 0, ivl: 1, lastIvl: -600, time: 5000 },
    { id: T0 - 20 * DAY_MS, cardId: '1000', ease: 1, type: 1, ivl: -600, lastIvl: 19, time: 9000 },
    { id: T0 - 19 * DAY_MS, cardId: '1000', ease: 0, type: 4, ivl: 30, lastIvl: 1, time: 0 }, // manual reschedule
    { id: T0 - 5 * DAY_MS, cardId: '9999', ease: 3, type: 1, ivl: 5, lastIvl: 2, time: 1 }, // unknown card
  ];

  async function run(keepScheduling: boolean, t?: Awaited<ReturnType<typeof testCollection>>) {
    t ??= await testCollection();
    const imp = new AnkiImport({ keepScheduling, crt: CRT });
    await t.col.run((c) => imp.addModels(c, models, decks));
    await t.col.run((c) => imp.addNotes(c, ankiNotes));
    await t.col.run((c) => imp.addCards(c, ankiCards));
    await t.col.run((c) => imp.addReviews(c, reviews));
    return { ...t, summary: imp.finish() };
  }

  it('maps note types, decks, notes, cards and tags', async () => {
    const { col, summary } = await run(false);
    expect(summary).toMatchObject({
      decks: ['Geo', 'Japanese::Core'],
      notesAdded: 3, notesSkipped: 1, cardsAdded: 5, cardsKept: 0, reviews: 0, suspended: 1,
    });
    // Anki's empty Default deck is not created; "::" becomes nesting.
    expect((await col.deckTree()).map((n) => [n.path, n.total])).toEqual([['Geo', 2], ['Japanese', 3], ['Japanese::Core', 3]]);
    const rows = (await col.searchCards('', { limit: 50 })).rows;
    expect(rows.every((r) => r.card.state === State.New)).toBe(true);
    const vocab = rows.filter((r) => r.noteTypeName === 'Vocab');
    expect(vocab.map((r) => r.templateName)).toEqual(['Recognise', 'Recall']);
    expect(vocab[0]!.note.tags).toEqual(['animal', 'n5']);
    expect(vocab[0]!.note.fields).toEqual(['犬', 'dog', '[sound:inu.mp3]']);
    // Cloze ordinals are the cloze numbers.
    expect(rows.filter((r) => r.noteTypeName === 'Cloze').map((r) => r.templateName)).toEqual(['Cloze 1', 'Cloze 2']);
    const shown = await col.renderCardById(rows.find((r) => r.templateName === 'Cloze 2')!.card.id);
    expect(shown.front).toBe('Tokyo is in <span class="cloze">[...]</span>');
  });

  it('reuses a built-in note type only when it is really the same', async () => {
    const { col, summary } = await run(false);
    // Anki's stock Basic and Cloze match ours exactly, so no copies are made.
    expect(summary.noteTypesReused).toEqual(['Basic', 'Cloze']);
    expect(summary.noteTypesCreated).toEqual(['Vocab']);
    expect((await col.listNoteTypes()).map((t) => t.name)).toEqual(['Basic', 'Basic (and reversed card)', 'Cloze', 'Vocab']);
  });

  it('a note type with the same name but different templates is imported beside ours', async () => {
    const t = await testCollection();
    const imp = new AnkiImport({ keepScheduling: false, crt: CRT });
    await t.col.run((c) => imp.addModels(c, [{ ...models[0]!, templates: [{ ord: 0, name: 'Card 1', front: '<h1>{{Front}}</h1>', back: '{{Back}}' }] }], decks));
    expect(imp.finish().noteTypesCreated).toEqual(['Basic (imported)']);
  });

  it('says which template features will not work', async () => {
    const { summary, col } = await run(false);
    expect(summary.warnings).toEqual([
      'Note type "Vocab" uses JavaScript, which does not run here.',
      'Note type "Vocab" uses type-in-the-answer, which is shown as a normal card.',
      'Note type "Vocab" uses template filters that are ignored (furigana).',
    ]);
    const recall = (await col.searchCards('', { limit: 50 })).rows.find((r) => r.templateName === 'Recall')!;
    const shown = await col.renderCardById(recall.card.id);
    expect(shown.front).toContain('type-in-the-answer is not supported');
    expect(shown.warnings.length).toBeGreaterThan(0);
  });

  it('keeps scheduling when asked: FSRS state as-is, SM-2 converted, learning cards reset', async () => {
    const { col, summary } = await run(true);
    expect(summary).toMatchObject({ scheduledFromSm2: 1, scheduledFromFsrs: 1, resetToNew: 1, reviews: 3 });
    const byId = new Map((await col.searchCards('', { limit: 50 })).rows.map((r) => [r.card.id, r.card]));

    const sm2 = byId.get('anki-c-1000')!;
    expect(sm2).toMatchObject({ state: State.Review, scheduledDays: 30, stability: 30, difficulty: 5, reps: 8, lapses: 1, suspended: false });
    expect(sm2.due).toBe((CRT + 110 * 86_400) * 1000);
    expect(sm2.lastReview).toBe(sm2.due - 30 * DAY_MS);

    const fsrs = byId.get('anki-c-1001')!;
    expect(fsrs).toMatchObject({ state: State.Review, stability: 14.5, difficulty: 6.2, suspended: true });
    expect(byId.get('anki-c-1002')!.state).toBe(State.New);

    // The converted card can be reviewed normally from here.
    const next = await col.answerCard('anki-c-1000', 3, 0);
    expect(next.state).toBe(State.Review);
    expect(next.due).toBeGreaterThan(T0 + 30 * DAY_MS);

    // History: answers only, in order, with the first one marked as a new card.
    const log = (await col.db.select().from(reviewLog)).filter((l) => l.deviceId === 'anki-import').sort((a, b) => a.reviewedAt - b.reviewedAt);
    expect(log.map((l) => [l.rating, l.stateBefore.state])).toEqual([[3, State.New], [3, State.Learning], [1, State.Review]]);
    const stats = await col.stats();
    expect(stats.totalReviews).toBe(4);
    expect(stats.forecast[0]).toBe(0); // The overdue card is suspended.
  });

  it('importing the same deck again updates notes and never touches progress', async () => {
    const t = await testCollection();
    await run(true, t);
    const reviewed = await t.col.answerCard('anki-c-1004', 4, 0);
    ankiNotes[2] = { ...ankiNotes[2]!, fields: ['front', 'better back'] };
    const { summary, col } = await run(true, t);
    ankiNotes[2] = { ...ankiNotes[2]!, fields: ['front', 'back'] };
    expect(summary).toMatchObject({ notesAdded: 0, notesUpdated: 1, cardsAdded: 0, cardsKept: 5, reviews: 0, noteTypesCreated: [], noteTypesReused: ['Basic', 'Vocab', 'Cloze'] });
    expect((await col.searchCards('', { limit: 50 })).total).toBe(5);
    expect((await col.searchCards('better')).total).toBe(1);
    const still = (await col.searchCards('better')).rows[0]!.card;
    expect(still.due).toBe(reviewed.due);
    expect((await col.listNoteTypes()).map((n) => n.name)).toEqual(['Basic', 'Basic (and reversed card)', 'Cloze', 'Vocab']);
  });
});
