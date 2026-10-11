/**
 * Schema migrations, shared by the browser, the server and the CLI. Append
 * only: never edit a migration that has shipped. Each entry runs once, in
 * order; `PRAGMA user_version` records how many have been applied.
 *
 * Migrations must stay backward compatible with the previous client version
 * (add columns with defaults; do not rename or drop).
 */
const SYNCED = `id TEXT PRIMARY KEY NOT NULL, modified_at INTEGER NOT NULL, modified_by TEXT NOT NULL DEFAULT '', deleted_at INTEGER, server_version INTEGER`;

export const migrations: string[][] = [
  [
    `CREATE TABLE decks (${SYNCED}, name TEXT NOT NULL, parent_id TEXT,
      new_per_day INTEGER NOT NULL DEFAULT 20, reviews_per_day INTEGER NOT NULL DEFAULT 200,
      desired_retention REAL NOT NULL DEFAULT 0.9)`,
    `CREATE TABLE note_types (${SYNCED}, name TEXT NOT NULL, kind TEXT NOT NULL, fields TEXT NOT NULL,
      css TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE templates (${SYNCED}, note_type_id TEXT NOT NULL, name TEXT NOT NULL, front TEXT NOT NULL,
      back TEXT NOT NULL, ordinal INTEGER NOT NULL)`,
    `CREATE INDEX templates_note_type ON templates (note_type_id)`,
    `CREATE TABLE notes (${SYNCED}, note_type_id TEXT NOT NULL, fields TEXT NOT NULL, tags TEXT NOT NULL,
      batch_id TEXT)`,
    `CREATE INDEX notes_note_type ON notes (note_type_id)`,
    `CREATE TABLE cards (${SYNCED}, note_id TEXT NOT NULL, ordinal INTEGER NOT NULL, deck_id TEXT NOT NULL,
      due INTEGER NOT NULL, stability REAL NOT NULL DEFAULT 0, difficulty REAL NOT NULL DEFAULT 0,
      elapsed_days INTEGER NOT NULL DEFAULT 0, scheduled_days INTEGER NOT NULL DEFAULT 0,
      learning_steps INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, last_review INTEGER,
      suspended INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX cards_note ON cards (note_id)`,
    `CREATE INDEX cards_deck_due ON cards (deck_id, state, due)`,
    `CREATE TABLE review_log (${SYNCED}, card_id TEXT NOT NULL, rating INTEGER NOT NULL,
      reviewed_at INTEGER NOT NULL, state_before TEXT NOT NULL, elapsed_days REAL NOT NULL,
      scheduled_days REAL NOT NULL, duration_ms INTEGER NOT NULL, device_id TEXT NOT NULL)`,
    `CREATE INDEX review_log_card ON review_log (card_id)`,
    `CREATE INDEX review_log_time ON review_log (reviewed_at)`,
    `CREATE TABLE media (${SYNCED}, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL)`,
    `CREATE TABLE agent_batches (${SYNCED}, created_at INTEGER NOT NULL, description TEXT NOT NULL)`,
    `CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL)`,
    `CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
    `CREATE TABLE purges (server_version INTEGER PRIMARY KEY, table_name TEXT NOT NULL, row_id TEXT NOT NULL)`,
    `CREATE INDEX purges_row ON purges (table_name, row_id)`,
    ...['decks', 'note_types', 'templates', 'notes', 'cards', 'review_log', 'media', 'agent_batches'].map(
      (t) => `CREATE INDEX ${t}_server_version ON ${t} (server_version)`,
    ),
  ],
];
