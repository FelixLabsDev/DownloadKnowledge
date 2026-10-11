/**
 * dk: the command-line tool for agents (and humans) to manage decks and cards
 * on the server. Runs inside the server container:
 *
 *   ssh linux-machine docker exec -i dk dk <command>
 *
 * It writes through the same code as the API, so every change is stamped with
 * a server version and reaches every device on its next sync. Output is JSON.
 */
import { DkError, type Collection, type DeckNode } from '@dk/core';
import { hashPassword } from './auth';
import { dataPaths, openServerCollection } from './open';

const USAGE = `dk <command>

Decks
  dk decks list
  dk decks create <path>                 e.g. "Languages::Spanish" (creates missing parents)
  dk decks rename <deck> <new name>
  dk decks move <deck> <parent deck>     use --top to move to the top level
  dk decks delete <deck>                 also deletes sub-decks and their cards (soft delete)

Notes and cards
  dk notes add --deck <path> --description <text> [--type <note type>] [--tags a,b] [--allow-duplicates]
                                         reads a JSON array of notes from stdin
  dk notes edit <note id>                reads {"fields": {...}, "tags": [...]} from stdin
  dk notes delete <note id>...
  dk cards search <query> [--limit N] [--offset N]
  dk cards move --deck <path> <card id>...
  dk cards suspend <card id>...
  dk cards unsuspend <card id>...
  dk note-types list

Batches (every "notes add" is one batch)
  dk batches list
  dk batch undo <batch id>

Other
  dk hash-password                       reads a password from stdin, prints its hash
  dk backup <file>                       writes a consistent snapshot of the database

A <deck> is a full path ("A::B") or a deck id. All output is JSON.`;

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['allow-duplicates', 'top', 'help']);

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
    else if (inline !== undefined) flags[name] = inline;
    else {
      const value = argv[++i];
      if (value === undefined) throw new DkError('usage', `--${name} needs a value.`);
      flags[name] = value;
    }
  }
  return { positional, flags };
}

async function stdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) throw new DkError('usage', 'This command reads JSON from stdin. With docker exec, pass -i.');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DkError('invalid', `stdin is not valid JSON: ${(e as Error).message}`);
  }
}

const str = (v: string | true | undefined, name: string): string => {
  if (typeof v !== 'string' || !v) throw new DkError('usage', `Missing --${name}.`);
  return v;
};
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new DkError('usage', `Missing ${what}.`);
  return v;
};
const list = (v: string[], what: string): string[] => {
  if (!v.length) throw new DkError('usage', `Missing ${what}.`);
  return v;
};

async function findDeck(col: Collection, ref: string): Promise<DeckNode> {
  const tree = await col.deckTree();
  const hit = tree.find((n) => n.deck.id === ref) ?? tree.find((n) => n.path.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new DkError('not_found', `No deck "${ref}". Run "dk decks list" to see deck paths.`);
  return hit;
}

const deckOut = (n: DeckNode) => ({
  id: n.deck.id,
  path: n.path,
  cards: n.total,
  dueToday: n.due,
  newPerDay: n.deck.newPerDay,
  reviewsPerDay: n.deck.reviewsPerDay,
  desiredRetention: n.deck.desiredRetention,
});

export async function runCommand(col: Collection, argv: string[], readStdin: () => Promise<unknown> = stdinJson): Promise<unknown> {
  const { positional, flags } = parse(argv);
  const [group, action, ...rest] = positional;
  const key = `${group ?? ''} ${action ?? ''}`.trim();

  switch (key) {
    case 'decks list':
      return (await col.deckTree()).map(deckOut);
    case 'decks create': {
      const deck = await col.ensureDeckPath(need(rest[0], 'the deck path'));
      return deckOut(await findDeck(col, deck.id));
    }
    case 'decks rename': {
      const deck = await findDeck(col, need(rest[0], 'the deck'));
      await col.updateDeck(deck.deck.id, { name: need(rest[1], 'the new name') });
      return deckOut(await findDeck(col, deck.deck.id));
    }
    case 'decks move': {
      const deck = await findDeck(col, need(rest[0], 'the deck'));
      const parent = flags.top ? null : (await findDeck(col, need(rest[1], 'the parent deck (or --top)'))).deck.id;
      await col.updateDeck(deck.deck.id, { parentId: parent });
      return deckOut(await findDeck(col, deck.deck.id));
    }
    case 'decks delete': {
      const deck = await findDeck(col, need(rest[0], 'the deck'));
      return { deleted: deck.path, ...(await col.deleteDeck(deck.deck.id)) };
    }
    case 'note-types list':
      return (await col.listNoteTypes()).map((t) => ({ name: t.name, kind: t.kind, fields: t.fields, cardsPerNote: t.kind === 'cloze' ? 'one per cloze number' : t.templates.length }));
    case 'notes add':
      return col.bulkAddNotes((await readStdin()) as never, {
        deck: typeof flags.deck === 'string' ? flags.deck : undefined,
        type: typeof flags.type === 'string' ? flags.type : undefined,
        tags: typeof flags.tags === 'string' ? flags.tags.split(',').filter(Boolean) : undefined,
        description: str(flags.description, 'description'),
        allowDuplicates: flags['allow-duplicates'] === true,
      });
    case 'notes edit': {
      const body = (await readStdin()) as { fields?: Record<string, string>; tags?: string[] };
      const r = await col.updateNote(need(rest[0], 'the note id'), { fields: body.fields, tags: body.tags });
      return { noteId: r.note.id, tags: r.note.tags, cards: r.cards.map((c) => c.id) };
    }
    case 'notes delete':
      return { notesDeleted: await col.deleteNotes(list(rest, 'note ids')) };
    case 'cards search': {
      const limit = Number(flags.limit ?? 50);
      const r = await col.searchCards(rest.join(' '), { limit, offset: Number(flags.offset ?? 0) });
      const types = await col.listNoteTypes();
      return {
        total: r.total,
        returned: r.rows.length,
        cards: r.rows.map((row) => {
          const names = types.find((t) => t.id === row.note.noteTypeId)?.fields ?? [];
          return {
            cardId: row.card.id,
            noteId: row.note.id,
            deck: row.deckPath,
            type: row.noteTypeName,
            card: row.templateName,
            fields: Object.fromEntries(names.map((n, i) => [n, row.note.fields[i] ?? ''])),
            tags: row.note.tags,
            state: ['new', 'learning', 'review', 'relearning'][row.card.state],
            due: new Date(row.card.due).toISOString(),
            suspended: row.card.suspended,
            batchId: row.note.batchId,
          };
        }),
      };
    }
    case 'cards move': {
      const deck = await findDeck(col, str(flags.deck, 'deck'));
      return { moved: await col.moveCards(list(rest, 'card ids'), deck.deck.id), deck: deck.path };
    }
    case 'cards suspend':
      return { suspended: await col.setSuspended(list(rest, 'card ids'), true) };
    case 'cards unsuspend':
      return { unsuspended: await col.setSuspended(list(rest, 'card ids'), false) };
    case 'batches list':
      return (await col.listBatches()).map((b) => ({
        id: b.id,
        createdAt: new Date(b.createdAt).toISOString(),
        description: b.description,
        notes: b.notes,
        decks: b.decks,
      }));
    case 'batch undo':
      return { batchId: rest[0], ...(await col.undoBatch(need(rest[0], 'the batch id'))) };
    default:
      throw new DkError('usage', key ? `Unknown command "${key}".` : 'No command given.');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') {
    console.log(USAGE);
    return;
  }
  if (argv[0] === 'hash-password') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    const password = text.trim();
    if (password.length < 8) throw new DkError('invalid', 'Use at least 8 characters.');
    console.log(hashPassword(password));
    return;
  }
  const { col, driver } = await openServerCollection(dataPaths());
  try {
    if (argv[0] === 'backup') {
      // VACUUM INTO takes a consistent snapshot of a live database; a plain file copy would not.
      const target = need(argv[1], 'the file to write');
      await driver.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`, []);
      console.log(JSON.stringify({ backup: target }, null, 2));
      return;
    }
    console.log(JSON.stringify(await runCommand(col, argv), null, 2));
  } finally {
    driver.close();
  }
}

// Only run when executed, not when imported by tests.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => {
    const usage = e instanceof DkError && e.code === 'usage';
    console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: e instanceof DkError ? e.code : 'error' }, null, 2));
    if (usage) console.error(`\n${USAGE}`);
    process.exit(usage ? 2 : 1);
  });
}
