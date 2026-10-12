import { and, desc, eq, isNull } from 'drizzle-orm';
import * as B from './batches';
import * as D from './decks';
import { exportBackup, exportNotesCsv } from './importers/backup';
import { importRows, type RowImportOptions } from './importers/csv';
import { migrate, openDb, type Db, type SqlDriver } from './driver';
import { uuidv7 } from './ids';
import * as N from './notes';
import type { Rating } from './scheduler';
import { cards, media, type Card, type Deck, type Media, type Note } from './schema';
import { getMeta, put, setMeta, type Ctx } from './store';
import { computeStats } from './stats';
import * as S from './study';
import * as Y from './sync';

export interface CollectionOptions {
  /** `client` (default) queues writes for sync; `server` stamps server versions. */
  role?: 'client' | 'server';
  /** Clock, ms since epoch. Injectable so tests can simulate days passing. */
  now?: () => number;
  /** `Date#getTimezoneOffset()` of the user. */
  tzOffsetMinutes?: () => number;
  /** Interval fuzz for reviews. On by default; tests turn it off. */
  fuzz?: boolean;
  /** Called after any committed change to user data. */
  onChange?: () => void;
  /** Called before a schema migration touches an existing database (the server backs up here). */
  onBeforeMigrate?: () => Promise<void>;
}

/**
 * The application's whole data API: every screen, the server and the CLI go
 * through this. One instance per database connection. Calls are serialised,
 * and each runs in its own transaction.
 */
export class Collection {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly db: Db,
    readonly deviceId: string,
    private opts: CollectionOptions,
  ) {}

  static async open(driver: SqlDriver, opts: CollectionOptions = {}): Promise<Collection> {
    await migrate(driver, opts.onBeforeMigrate);
    const db = openDb(driver);
    let deviceId = await getMeta(db, 'device_id');
    if (!deviceId) {
      deviceId = uuidv7();
      await setMeta(db, 'device_id', deviceId);
    }
    const col = new Collection(db, deviceId, opts);
    await col.run((ctx) => N.seedBuiltins(ctx));
    return col;
  }

  /** Runs `fn` in a transaction, after any call already in progress. */
  run<T>(fn: (ctx: Ctx) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      let wrote = false;
      const result = await this.db.transaction(
        async (tx) => {
          const ctx: Ctx = {
            tx,
            now: this.opts.now?.() ?? Date.now(),
            role: this.opts.role ?? 'client',
            deviceId: this.deviceId,
            tzOffsetMinutes: this.opts.tzOffsetMinutes?.() ?? new Date().getTimezoneOffset(),
            fuzz: this.opts.fuzz ?? true,
            wrote: false,
          };
          const r = await fn(ctx);
          wrote = ctx.wrote;
          return r;
        },
        { behavior: 'immediate' },
      );
      if (wrote) this.opts.onChange?.();
      return result;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  // Decks
  deckTree = () => this.run((c) => S.deckTree(c));
  createDeck = (input: { name: string; parentId?: string | null }) => this.run((c) => D.createDeck(c, input));
  ensureDeckPath = (path: string) => this.run((c) => D.ensureDeckPath(c, path));
  updateDeck = (id: string, patch: D.DeckPatch) => this.run((c) => D.updateDeck(c, id, patch));
  getDeck = (id: string): Promise<Deck> => this.run((c) => D.requireDeck(c.tx, id));
  deleteDeck = (id: string) =>
    this.run(async (c) => {
      const r = await D.deleteDeck(c, id);
      const notes = await N.deleteOrphanNotes(c, r.noteIds);
      return { decks: r.decks, cards: r.cards, notes };
    });

  // Note types
  listNoteTypes = () => this.run((c) => N.listNoteTypes(c.tx));
  updateNoteType = (id: string, patch: { css?: string }) => this.run((c) => N.updateNoteType(c, id, patch));
  updateTemplate = (id: string, patch: { front?: string; back?: string }) => this.run((c) => N.updateTemplate(c, id, patch));

  // Notes and cards
  addNote = (input: N.AddNoteInput) => this.run((c) => N.addNote(c, input));
  getNote = (id: string): Promise<{ note: Note; cards: Card[] }> =>
    this.run(async (c) => ({ note: await N.requireNote(c.tx, id), cards: await N.cardsOfNote(c.tx, id) }));
  updateNote = (id: string, patch: { fields?: string[] | Record<string, string>; tags?: string[] }) =>
    this.run((c) => N.updateNote(c, id, patch));
  deleteNotes = (ids: string[]) => this.run((c) => N.deleteNotes(c, ids));
  findDuplicate = (deckId: string, noteTypeId: string, firstField: string) =>
    this.run((c) => N.findDuplicate(c.tx, deckId, noteTypeId, firstField));
  searchCards = (query: string, opts?: { limit?: number; offset?: number }) => this.run((c) => N.searchCards(c, query, opts));
  moveCards = (ids: string[], deckId: string) => this.run((c) => N.moveCards(c, ids, deckId));
  setSuspended = (ids: string[], suspended: boolean) => this.run((c) => N.setSuspended(c, ids, suspended));
  deleteCards = (ids: string[]) => this.run((c) => N.deleteCards(c, ids));
  changeTags = (noteIds: string[], add: string[], remove: string[]) => this.run((c) => N.changeTags(c, noteIds, add, remove));
  listTags = () => this.run((c) => N.listTags(c.tx));

  // Import and export
  importRows = (rows: string[][], opts: RowImportOptions) => this.run((c) => importRows(c, rows, opts));
  exportBackup = () => this.run((c) => exportBackup(c));
  exportNotesCsv = () => this.run((c) => exportNotesCsv(c));

  // Dashboard
  stats = () => this.run((c) => computeStats(c));

  // Agent batches (see batches.ts)
  bulkAddNotes = (items: B.BulkNote[], opts: B.BulkAddOptions) => this.run((c) => B.bulkAddNotes(c, items, opts));
  listBatches = () => this.run((c) => B.listBatches(c));
  undoBatch = (id: string) => this.run((c) => B.undoBatch(c, id));

  // Media
  /** Records a media file (id is its sha256). The bytes are stored by the platform, not here. */
  registerMedia = (m: { id: string; filename: string; mime: string; size: number }): Promise<Media> =>
    this.run(async (c) => {
      const existing = (await c.tx.select().from(media).where(eq(media.id, m.id)))[0];
      if (existing && existing.deletedAt === null && existing.filename === m.filename) return existing;
      return put(c, 'media', { ...existing, ...m, deletedAt: null });
    });
  findMedia = (filename: string): Promise<Media | null> =>
    this.run(async (c) => {
      const rows = await c.tx
        .select()
        .from(media)
        .where(and(eq(media.filename, filename), isNull(media.deletedAt)))
        .orderBy(desc(media.modifiedAt))
        .limit(1);
      return rows[0] ?? null;
    });

  listMedia = (): Promise<Media[]> => this.run((c) => c.tx.select().from(media).where(isNull(media.deletedAt)));
  /** Local-only settings and bookkeeping (never synced). */
  getMetaValue = (key: string) => this.run((c) => getMeta(c.tx, key));
  setMetaValue = (key: string, value: string) => this.run((c) => setMeta(c.tx, key, value));

  // Sync (see sync.ts)
  applyPush = (body: Y.PushRequest) => this.run((c) => Y.applyPush(c, body));
  readChanges = (since: number, limit: number) => this.run((c) => Y.readChanges(c, since, limit));
  purgeDeleted = (cutoff: number) => this.run((c) => Y.purgeDeleted(c, cutoff));
  pendingCount = () => this.run((c) => Y.pendingCount(c));
  sync = (transport: Y.SyncTransport) => Y.syncOnce(this, transport);

  // Study
  nextStudyStep = (deckId: string, skip?: string[]) => this.run((c) => S.nextStudyStep(c, deckId, skip));
  answerCard = (cardId: string, rating: Rating, durationMs: number) => this.run((c) => S.answerCard(c, cardId, rating, durationMs));
  undoLastReview = () => this.run((c) => S.undoLastReview(c));
  cramCardIds = (deckId: string) => this.run((c) => S.cramCardIds(c.tx, deckId));
  renderCardById = (cardId: string) =>
    this.run(async (c) => {
      const card = (await c.tx.select().from(cards).where(and(eq(cards.id, cardId), isNull(cards.deletedAt))))[0];
      if (!card) throw new D.DkError('not_found', 'That card does not exist.');
      return S.renderStudyCard(c, card);
    });
}
