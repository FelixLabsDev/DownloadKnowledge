import { and, asc, eq, getTableColumns, gt, inArray, isNotNull, lt, lte } from 'drizzle-orm';
import type { Collection } from './collection';
import { outbox, purges, syncedTableNames, syncedTables, type SyncedTableName } from './schema';
import { chunk, getMeta, nextServerVersion, setMeta, type Ctx } from './store';

/** A row as it travels between client and server: the table's columns, camelCase. */
export type WireRow = Record<string, unknown> & { id: string; modifiedAt: number; modifiedBy: string; deletedAt: number | null };

export type Change =
  | { table: SyncedTableName; row: WireRow }
  /** The server hard-deleted this row (30 days after it was soft-deleted). */
  | { table: SyncedTableName; id: string; purged: true };

export interface PushRequest {
  deviceId: string;
  changes: { table: SyncedTableName; row: WireRow }[];
}
export interface PushResponse {
  applied: number;
  ignored: number;
}
export interface PullResponse {
  changes: Change[];
  /** Pass as `since` next time. */
  next: number;
  more: boolean;
}

/** How a client reaches the server. The web app uses fetch; tests call the server in-process. */
export interface SyncTransport {
  push(body: PushRequest): Promise<PushResponse>;
  pull(since: number, limit: number): Promise<PullResponse>;
}

export const PUSH_BATCH = 200;
export const PULL_PAGE = 500;
const CURSOR = 'sync_cursor';

const isTable = (t: unknown): t is SyncedTableName => typeof t === 'string' && (syncedTableNames as string[]).includes(t);

/** Keeps only the table's own columns and checks the ones merging depends on. */
function cleanRow(table: SyncedTableName, raw: unknown): WireRow {
  if (typeof raw !== 'object' || raw === null) throw new SyncError('A change has no row.');
  const cols = getTableColumns(syncedTables[table]);
  const out: Record<string, unknown> = {};
  for (const [key, col] of Object.entries(cols)) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined || v === null) {
      if (!col.notNull) out[key] = null;
      else if (!col.hasDefault) throw new SyncError(`${table}.${key} is missing.`);
      continue; // Otherwise the column default applies (a column this sender's version does not know).
    }
    out[key] = v;
  }
  if (typeof out.id !== 'string' || !out.id) throw new SyncError(`${table}: a row has no id.`);
  if (typeof out.modifiedAt !== 'number') throw new SyncError(`${table}: a row has no modifiedAt.`);
  out.modifiedBy = typeof out.modifiedBy === 'string' ? out.modifiedBy : '';
  out.deletedAt = typeof out.deletedAt === 'number' ? out.deletedAt : null;
  return out as WireRow;
}

export class SyncError extends Error {}

/** Later `modifiedAt` wins; a tie goes to the greater device id. */
function isNewer(a: { modifiedAt: number; modifiedBy: string }, b: { modifiedAt: number; modifiedBy: string }): boolean {
  return a.modifiedAt !== b.modifiedAt ? a.modifiedAt > b.modifiedAt : a.modifiedBy > b.modifiedBy;
}

/**
 * Merges one incoming row into this database. The same rule runs on the
 * server (for pushes) and on clients (for pulls), and it is idempotent and
 * order-independent, which is what makes retries and duplicates harmless.
 */
async function mergeRow(ctx: Ctx, table: SyncedTableName, incoming: WireRow): Promise<boolean> {
  const t = syncedTables[table];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = ctx.tx as any;
  const existing = (await tx.select().from(t).where(eq(t.id, incoming.id)))[0] as WireRow | undefined;

  let next: WireRow | null = null;
  if (table === 'review_log') {
    // Insert-only. A duplicate id is ignored, except that a deletion (undo) sticks.
    if (!existing) next = incoming;
    else if (incoming.deletedAt !== null && existing.deletedAt === null) {
      next = { ...existing, deletedAt: incoming.deletedAt, modifiedAt: incoming.modifiedAt, modifiedBy: incoming.modifiedBy };
    }
  } else if (!existing || isNewer(incoming, existing)) {
    next = incoming;
  }
  if (!next) return false;

  const row = {
    ...next,
    serverVersion: ctx.role === 'server' ? await nextServerVersion(ctx.tx) : (incoming.serverVersion ?? null),
  };
  await tx.insert(t).values(row).onConflictDoUpdate({ target: t.id, set: row });
  ctx.wrote = true;
  return true;
}

// ---------------------------------------------------------------------------
// Server side

export async function applyPush(ctx: Ctx, body: PushRequest): Promise<PushResponse> {
  if (!Array.isArray(body?.changes)) throw new SyncError('Expected { changes: [...] }.');
  let applied = 0;
  for (const c of body.changes) {
    if (!isTable(c?.table)) throw new SyncError(`Unknown table: ${String(c?.table)}`);
    const row = cleanRow(c.table, c.row);
    // A row purged here must not be resurrected by a device that was offline for a long time.
    const purged = await ctx.tx.select().from(purges).where(and(eq(purges.tableName, c.table), eq(purges.rowId, row.id))).limit(1);
    if (purged.length) continue;
    if (await mergeRow(ctx, c.table, row)) applied++;
  }
  return { applied, ignored: body.changes.length - applied };
}

export async function readChanges(ctx: Ctx, since: number, limit: number): Promise<PullResponse> {
  limit = Math.max(1, Math.min(limit || PULL_PAGE, 2000));
  const found: { v: number; change: Change }[] = [];
  for (const table of syncedTableNames) {
    const t = syncedTables[table];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (ctx.tx as any).select().from(t).where(gt(t.serverVersion, since)).orderBy(asc(t.serverVersion)).limit(limit + 1)) as WireRow[];
    for (const row of rows) found.push({ v: row.serverVersion as number, change: { table, row } });
  }
  const gone = await ctx.tx.select().from(purges).where(gt(purges.serverVersion, since)).orderBy(asc(purges.serverVersion)).limit(limit + 1);
  for (const p of gone) {
    if (isTable(p.tableName)) found.push({ v: p.serverVersion, change: { table: p.tableName, id: p.rowId, purged: true } });
  }
  found.sort((a, b) => a.v - b.v);
  const page = found.slice(0, limit);
  return { changes: page.map((f) => f.change), next: page.at(-1)?.v ?? since, more: found.length > limit };
}

/** Hard-deletes rows soft-deleted before `cutoff`, and records it so every device follows. */
export async function purgeDeleted(ctx: Ctx, cutoff: number): Promise<number> {
  let n = 0;
  for (const table of syncedTableNames) {
    const t = syncedTables[table];
    const rows = await ctx.tx.select({ id: t.id }).from(t).where(and(isNotNull(t.deletedAt), lt(t.deletedAt, cutoff)));
    for (const ids of chunk(rows.map((r) => r.id))) {
      for (const id of ids) {
        await ctx.tx.insert(purges).values({ serverVersion: await nextServerVersion(ctx.tx), tableName: table, rowId: id });
      }
      await ctx.tx.delete(t).where(inArray(t.id, ids));
      n += ids.length;
    }
  }
  if (n) ctx.wrote = true;
  return n;
}

// ---------------------------------------------------------------------------
// Client side

/** The next batch of local changes to push: the current state of each changed row, oldest change first. */
export async function readOutbox(ctx: Ctx, limit: number): Promise<{ changes: PushRequest['changes']; upToSeq: number }> {
  const entries = await ctx.tx.select().from(outbox).orderBy(asc(outbox.seq)).limit(limit);
  const seen = new Set<string>();
  const changes: PushRequest['changes'] = [];
  for (const e of entries) {
    const key = `${e.tableName}/${e.rowId}`;
    if (seen.has(key) || !isTable(e.tableName)) continue;
    seen.add(key);
    const t = syncedTables[e.tableName];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (await (ctx.tx as any).select().from(t).where(eq(t.id, e.rowId)))[0] as WireRow | undefined;
    if (row) changes.push({ table: e.tableName, row });
  }
  return { changes, upToSeq: entries.at(-1)?.seq ?? 0 };
}

export async function applyPull(ctx: Ctx, res: PullResponse): Promise<number> {
  let applied = 0;
  for (const c of res.changes) {
    if (!isTable(c.table)) continue; // A newer server may know tables this client does not.
    if ('purged' in c) {
      const t = syncedTables[c.table];
      await ctx.tx.delete(t).where(eq(t.id, c.id));
      await ctx.tx.delete(outbox).where(and(eq(outbox.tableName, c.table), eq(outbox.rowId, c.id)));
      ctx.wrote = true;
      applied++;
    } else if (await mergeRow(ctx, c.table, cleanRow(c.table, c.row))) applied++;
  }
  // The cursor moves in the same transaction as the rows, so an interrupted pull resumes cleanly.
  await setMeta(ctx.tx, CURSOR, String(res.next));
  return applied;
}

export async function pendingCount(ctx: Ctx): Promise<number> {
  const rows = await ctx.tx.selectDistinct({ t: outbox.tableName, r: outbox.rowId }).from(outbox);
  return rows.length;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/**
 * One full sync: push everything in the outbox, then pull everything new.
 * Safe to interrupt at any point and to run again; throws whatever the
 * transport throws, leaving the outbox and cursor consistent.
 */
export async function syncOnce(col: Collection, transport: SyncTransport): Promise<SyncResult> {
  let pushed = 0;
  let pulled = 0;
  for (;;) {
    const batch = await col.run((ctx) => readOutbox(ctx, PUSH_BATCH));
    if (!batch.upToSeq) break;
    if (batch.changes.length) await transport.push({ deviceId: col.deviceId, changes: batch.changes });
    // Only now is it safe to forget these entries. A row edited again meanwhile has a later entry and stays queued.
    await col.run((ctx) => ctx.tx.delete(outbox).where(lte(outbox.seq, batch.upToSeq)));
    pushed += batch.changes.length;
  }
  for (;;) {
    const since = Number((await col.run((ctx) => getMeta(ctx.tx, CURSOR))) ?? 0);
    const res = await transport.pull(since, PULL_PAGE);
    pulled += await col.run((ctx) => applyPull(ctx, res));
    if (!res.more) break;
  }
  return { pushed, pulled };
}
