import { and, eq, inArray, isNull } from 'drizzle-orm';
import { uuidv7 } from './ids';
import { cards, decks, type Deck } from './schema';
import { chunk, put, softDelete, type Ctx } from './store';
import type { DbOrTx } from './driver';

export class DkError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DeckIndex {
  byId: Map<string, Deck>;
  children: Map<string | null, Deck[]>;
}

export async function loadDecks(tx: DbOrTx): Promise<DeckIndex> {
  const rows = await tx.select().from(decks).where(isNull(decks.deletedAt));
  const byId = new Map(rows.map((d) => [d.id, d]));
  const children = new Map<string | null, Deck[]>();
  for (const d of rows) {
    // A deck whose parent is gone (deleted elsewhere) surfaces at the top level rather than vanishing.
    const parent = d.parentId && byId.has(d.parentId) ? d.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(d);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return { byId, children };
}

/** The deck and everything beneath it, parents before children. */
export function subtree(index: DeckIndex, deckId: string): Deck[] {
  const root = index.byId.get(deckId);
  if (!root) return [];
  const out: Deck[] = [];
  const walk = (d: Deck) => {
    out.push(d);
    for (const c of index.children.get(d.id) ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** The deck, then its parent, up to the top. */
export function ancestry(index: DeckIndex, deckId: string): Deck[] {
  const out: Deck[] = [];
  const seen = new Set<string>();
  let cur = index.byId.get(deckId);
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.parentId ? index.byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Full path in Anki's notation, e.g. `Languages::Spanish`. */
export function deckPath(index: DeckIndex, deckId: string): string {
  return ancestry(index, deckId)
    .reverse()
    .map((d) => d.name)
    .join('::');
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n) throw new DkError('invalid', 'A deck needs a name.');
  if (n.includes('::')) throw new DkError('invalid', 'A deck name cannot contain "::".');
  return n;
}

async function assertUniqueSibling(ctx: Ctx, name: string, parentId: string | null, selfId?: string) {
  const index = await loadDecks(ctx.tx);
  const clash = (index.children.get(parentId) ?? []).find(
    (d) => d.id !== selfId && d.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new DkError('duplicate', `A deck named "${name}" already exists here.`);
}

export async function createDeck(ctx: Ctx, input: { name: string; parentId?: string | null }): Promise<Deck> {
  const name = cleanName(input.name);
  const parentId = input.parentId ?? null;
  if (parentId) await requireDeck(ctx.tx, parentId);
  await assertUniqueSibling(ctx, name, parentId);
  return put(ctx, 'decks', {
    id: uuidv7(ctx.now),
    deletedAt: null,
    name,
    parentId,
    newPerDay: 20,
    reviewsPerDay: 200,
    desiredRetention: 0.9,
  });
}

/** Finds or creates the deck at a `A::B::C` path, creating missing parents. */
export async function ensureDeckPath(ctx: Ctx, path: string): Promise<Deck> {
  let parentId: string | null = null;
  let deck: Deck | undefined;
  for (const part of path.split('::').map((p) => p.trim()).filter(Boolean)) {
    const index = await loadDecks(ctx.tx);
    deck = (index.children.get(parentId) ?? []).find((d) => d.name.toLowerCase() === part.toLowerCase());
    deck ??= await createDeck(ctx, { name: part, parentId });
    parentId = deck.id;
  }
  if (!deck) throw new DkError('invalid', 'A deck needs a name.');
  return deck;
}

export async function requireDeck(tx: DbOrTx, id: string): Promise<Deck> {
  const rows = await tx.select().from(decks).where(and(eq(decks.id, id), isNull(decks.deletedAt)));
  if (!rows[0]) throw new DkError('not_found', 'That deck does not exist.');
  return rows[0];
}

export interface DeckPatch {
  name?: string;
  parentId?: string | null;
  newPerDay?: number;
  reviewsPerDay?: number;
  desiredRetention?: number;
}

export async function updateDeck(ctx: Ctx, id: string, patch: DeckPatch): Promise<Deck> {
  const deck = await requireDeck(ctx.tx, id);
  const next = { ...deck };
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.parentId !== undefined) {
    if (patch.parentId) {
      const index = await loadDecks(ctx.tx);
      if (!index.byId.has(patch.parentId)) throw new DkError('not_found', 'The target deck does not exist.');
      if (subtree(index, id).some((d) => d.id === patch.parentId)) {
        throw new DkError('invalid', 'A deck cannot be moved inside itself.');
      }
    }
    next.parentId = patch.parentId;
  }
  if (patch.newPerDay !== undefined) next.newPerDay = clampInt(patch.newPerDay, 0, 9999);
  if (patch.reviewsPerDay !== undefined) next.reviewsPerDay = clampInt(patch.reviewsPerDay, 0, 9999);
  if (patch.desiredRetention !== undefined) {
    if (!(patch.desiredRetention >= 0.7 && patch.desiredRetention <= 0.99)) {
      throw new DkError('invalid', 'Desired retention must be between 70% and 99%.');
    }
    next.desiredRetention = patch.desiredRetention;
  }
  if (next.name !== deck.name || next.parentId !== deck.parentId) {
    await assertUniqueSibling(ctx, next.name, next.parentId, id);
  }
  return put(ctx, 'decks', next);
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) throw new DkError('invalid', 'Expected a number.');
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Soft-deletes the deck, everything beneath it, and the cards they hold. Returns ids of affected notes. */
export async function deleteDeck(ctx: Ctx, id: string): Promise<{ decks: number; cards: number; noteIds: string[] }> {
  const index = await loadDecks(ctx.tx);
  const doomed = subtree(index, id);
  if (!doomed.length) throw new DkError('not_found', 'That deck does not exist.');
  const noteIds = new Set<string>();
  let cardCount = 0;
  for (const ids of chunk(doomed.map((d) => d.id))) {
    const rows = await ctx.tx
      .select()
      .from(cards)
      .where(and(inArray(cards.deckId, ids), isNull(cards.deletedAt)));
    for (const c of rows) {
      await softDelete(ctx, 'cards', c);
      noteIds.add(c.noteId);
      cardCount++;
    }
  }
  for (const d of doomed) await softDelete(ctx, 'decks', d);
  return { decks: doomed.length, cards: cardCount, noteIds: [...noteIds] };
}
