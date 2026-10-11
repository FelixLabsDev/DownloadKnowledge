import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/cli';
import { makeClient, makeServer } from './harness';

async function setup() {
  const server = await makeServer();
  const dk = (args: string[], stdin?: unknown) =>
    runCommand(server.col, args, async () => {
      if (stdin === undefined) throw new Error('unexpected stdin read');
      return stdin;
    }) as Promise<never>;
  return { server, dk };
}

const NOTES = [
  { fields: { Front: 'la casa', Back: 'the house' } },
  { fields: { Front: 'el perro', Back: 'the dog' }, tags: ['animal'] },
  { type: 'Cloze', fields: { Text: 'Madrid is the capital of {{c1::Spain}}' }, deck: 'Geography' },
];

describe('dk CLI', () => {
  it('manages decks', async () => {
    const { dk } = await setup();
    const made: { path: string; id: string } = await dk(['decks', 'create', 'Languages::Spanish']);
    expect(made.path).toBe('Languages::Spanish');
    await dk(['decks', 'create', 'Archive']);
    await dk(['decks', 'rename', 'Languages::Spanish', 'Español']);
    await dk(['decks', 'move', 'Languages::Español', 'Archive']);
    const paths = async () => ((await dk(['decks', 'list'])) as { path: string }[]).map((d) => d.path);
    expect(await paths()).toEqual(['Archive', 'Archive::Español', 'Languages']);
    await dk(['decks', 'move', made.id, '--top']);
    expect(await paths()).toEqual(['Archive', 'Español', 'Languages']);
    expect(await dk(['decks', 'delete', 'Languages'])).toMatchObject({ deleted: 'Languages', decks: 1 });
    await expect(dk(['decks', 'delete', 'Nope'])).rejects.toThrow(/No deck "Nope"/);
  });

  it('adds notes in bulk as a recorded batch, tagged for review', async () => {
    const { dk } = await setup();
    const r: { batchId: string; added: { cards: number; deck: string }[]; skipped: unknown[] } = await dk(
      ['notes', 'add', '--deck', 'Languages::Spanish', '--description', 'Spanish basics', '--tags', 'ch1'],
      NOTES,
    );
    expect(r.added.map((a) => [a.deck, a.cards])).toEqual([
      ['Languages::Spanish', 1],
      ['Languages::Spanish', 1],
      ['Geography', 1],
    ]);
    expect(r.skipped).toEqual([]);

    const found: { total: number; cards: { tags: string[]; fields: Record<string, string>; batchId: string; state: string }[] } = await dk(['cards', 'search', 'tag:agent']);
    expect(found.total).toBe(3);
    expect(found.cards[1]).toMatchObject({ tags: ['agent', 'animal', 'ch1'], fields: { Front: 'el perro', Back: 'the dog' }, batchId: r.batchId, state: 'new' });

    const batches: { id: string; description: string; notes: number; decks: string[] }[] = await dk(['batches', 'list']);
    expect(batches).toMatchObject([{ id: r.batchId, description: 'Spanish basics', notes: 3, decks: ['Geography', 'Languages::Spanish'] }]);
  });

  it('skips duplicates unless told otherwise', async () => {
    const { dk } = await setup();
    const add = (extra: string[] = []) => dk(['notes', 'add', '--deck', 'D', '--description', 'x', ...extra], [NOTES[0], NOTES[0], NOTES[1]]) as Promise<{ batchId: string | null; added: unknown[]; skipped: { index: number }[] }>;
    const first = await add();
    expect(first.added).toHaveLength(2);
    expect(first.skipped.map((s) => s.index)).toEqual([1]);
    const second = await add();
    expect(second).toMatchObject({ batchId: null, added: [] });
    expect(second.skipped).toHaveLength(3);
    expect((await add(['--allow-duplicates'])).added).toHaveLength(3);
  });

  it('rejects a bad batch as a whole, naming the offending note', async () => {
    const { dk } = await setup();
    await expect(dk(['notes', 'add', '--deck', 'D', '--description', 'x'], [NOTES[0], { fields: { Question: 'q' } }])).rejects.toThrow(/Note 2: Unknown field/);
    await expect(dk(['notes', 'add', '--deck', 'D', '--description', 'x'], [{ type: 'Fancy', fields: {} }])).rejects.toThrow(/Note 1: unknown note type "Fancy"/);
    await expect(dk(['notes', 'add', '--deck', 'D'], NOTES)).rejects.toThrow(/--description/);
    expect(await dk(['decks', 'list'])).toEqual([]); // Nothing was left behind, not even the deck.
  });

  it('undoes a batch without touching anything else', async () => {
    const { dk } = await setup();
    await dk(['notes', 'add', '--deck', 'D', '--description', 'keep'], [NOTES[0]]);
    const bad: { batchId: string } = await dk(['notes', 'add', '--deck', 'D', '--description', 'oops'], [NOTES[1]]);
    expect(await dk(['batch', 'undo', bad.batchId])).toEqual({ batchId: bad.batchId, notesDeleted: 1 });
    const left: { total: number; cards: { fields: Record<string, string> }[] } = await dk(['cards', 'search', 'deck:D']);
    expect(left.cards.map((c) => c.fields.Front)).toEqual(['la casa']);
    expect(((await dk(['batches', 'list'])) as { description: string }[]).map((b) => b.description)).toEqual(['keep']);
  });

  it('edits, moves, suspends and deletes', async () => {
    const { dk } = await setup();
    await dk(['notes', 'add', '--deck', 'D', '--description', 'x'], NOTES.slice(0, 2));
    await dk(['decks', 'create', 'Other']);
    const search = async (q: string) => (await dk(['cards', 'search', q])) as { total: number; cards: { cardId: string; noteId: string; deck: string; suspended: boolean; fields: Record<string, string> }[] };
    const [a, b] = (await search('')).cards;

    await dk(['notes', 'edit', a!.noteId], { fields: { Back: 'the home' }, tags: ['edited'] });
    expect((await search('tag:edited')).cards[0]!.fields).toEqual({ Front: 'la casa', Back: 'the home' });

    expect(await dk(['cards', 'move', '--deck', 'Other', a!.cardId])).toEqual({ moved: 1, deck: 'Other' });
    expect((await search('deck:Other')).total).toBe(1);
    expect(await dk(['cards', 'suspend', b!.cardId])).toEqual({ suspended: 1 });
    expect((await search('is:suspended')).cards[0]!.cardId).toBe(b!.cardId);
    expect(await dk(['cards', 'unsuspend', b!.cardId])).toEqual({ unsuspended: 1 });
    expect(await dk(['notes', 'delete', a!.noteId, b!.noteId])).toEqual({ notesDeleted: 2 });
    expect((await search('')).total).toBe(0);
  });

  it('reports usage errors', async () => {
    const { dk } = await setup();
    await expect(dk(['decks', 'frobnicate'])).rejects.toThrow(/Unknown command/);
    await expect(dk(['cards', 'move', 'x'])).rejects.toThrow(/--deck/);
    await expect(dk(['notes', 'delete'])).rejects.toThrow(/Missing note ids/);
  });

  it('what the CLI writes reaches a device on its next sync, and an undo follows', async () => {
    const { server, dk } = await setup();
    const phone = await makeClient();
    const batch: { batchId: string } = await dk(['notes', 'add', '--deck', 'Agent deck', '--description', 'from the agent'], NOTES.slice(0, 2));
    await phone.col.sync(server.transport);
    expect((await phone.col.deckTree()).map((n) => [n.path, n.due.new])).toEqual([['Agent deck', 2]]);
    expect((await phone.col.listTags()).map((t) => t.tag)).toEqual(['agent', 'animal']);

    await dk(['batch', 'undo', batch.batchId]);
    await phone.col.sync(server.transport);
    expect((await phone.col.searchCards('')).total).toBe(0);
  });
});
