import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Columns every synced table carries (see docs/IMPLEMENTATION_PLAN.md §3, "Data model"). */
const synced = {
  id: text('id').primaryKey(),
  modifiedAt: integer('modified_at').notNull(),
  deletedAt: integer('deleted_at'),
  serverVersion: integer('server_version'),
};

export const decks = sqliteTable('decks', {
  ...synced,
  name: text('name').notNull(),
  parentId: text('parent_id'),
  newPerDay: integer('new_per_day').notNull().default(20),
  reviewsPerDay: integer('reviews_per_day').notNull().default(200),
  desiredRetention: real('desired_retention').notNull().default(0.9),
});

export const noteTypes = sqliteTable('note_types', {
  ...synced,
  name: text('name').notNull(),
  kind: text('kind').$type<'standard' | 'cloze'>().notNull(),
  fields: text('fields', { mode: 'json' }).$type<string[]>().notNull(),
  css: text('css').notNull().default(''),
});

export const templates = sqliteTable(
  'templates',
  {
    ...synced,
    noteTypeId: text('note_type_id').notNull(),
    name: text('name').notNull(),
    front: text('front').notNull(),
    back: text('back').notNull(),
    ordinal: integer('ordinal').notNull(),
  },
  (t) => [index('templates_note_type').on(t.noteTypeId)],
);

export const notes = sqliteTable(
  'notes',
  {
    ...synced,
    noteTypeId: text('note_type_id').notNull(),
    fields: text('fields', { mode: 'json' }).$type<string[]>().notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    batchId: text('batch_id'),
  },
  (t) => [index('notes_note_type').on(t.noteTypeId)],
);

export const cards = sqliteTable(
  'cards',
  {
    ...synced,
    noteId: text('note_id').notNull(),
    /** Template ordinal for standard note types; cloze index (1-based) for cloze. */
    ordinal: integer('ordinal').notNull(),
    deckId: text('deck_id').notNull(),
    due: integer('due').notNull(),
    stability: real('stability').notNull().default(0),
    difficulty: real('difficulty').notNull().default(0),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    /** 0 new, 1 learning, 2 review, 3 relearning (ts-fsrs State). */
    state: integer('state').notNull().default(0),
    lastReview: integer('last_review'),
    suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('cards_note').on(t.noteId), index('cards_deck_due').on(t.deckId, t.state, t.due)],
);

/** Scheduling fields of a card, as stored. */
export interface CardSched {
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: number | null;
}

/**
 * Insert-only: a row's content never changes after insert. The one permitted
 * change is setting `deleted_at` (undo), which only ever moves from null to set.
 */
export const reviewLog = sqliteTable(
  'review_log',
  {
    ...synced,
    cardId: text('card_id').notNull(),
    rating: integer('rating').notNull(),
    reviewedAt: integer('reviewed_at').notNull(),
    stateBefore: text('state_before', { mode: 'json' }).$type<CardSched>().notNull(),
    elapsedDays: real('elapsed_days').notNull(),
    scheduledDays: real('scheduled_days').notNull(),
    durationMs: integer('duration_ms').notNull(),
    deviceId: text('device_id').notNull(),
  },
  (t) => [index('review_log_card').on(t.cardId), index('review_log_time').on(t.reviewedAt)],
);

/** `id` is the sha256 of the content, hex. */
export const media = sqliteTable('media', {
  ...synced,
  filename: text('filename').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
});

export const agentBatches = sqliteTable('agent_batches', {
  ...synced,
  createdAt: integer('created_at').notNull(),
  description: text('description').notNull(),
});

/** Local-only: changes waiting to be pushed. Written in the same transaction as the change. */
export const outbox = sqliteTable('outbox', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  rowId: text('row_id').notNull(),
});

/** Local-only key/value store (device id, sync cursor, server version counter). */
export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const syncedTables = {
  decks,
  note_types: noteTypes,
  templates,
  notes,
  cards,
  review_log: reviewLog,
  media,
  agent_batches: agentBatches,
} as const;
export type SyncedTableName = keyof typeof syncedTables;
export const syncedTableNames = Object.keys(syncedTables) as SyncedTableName[];

export type Deck = typeof decks.$inferSelect;
export type NoteType = typeof noteTypes.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type ReviewLogEntry = typeof reviewLog.$inferSelect;
export type Media = typeof media.$inferSelect;
export type AgentBatch = typeof agentBatches.$inferSelect;
