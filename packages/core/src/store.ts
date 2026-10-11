import { eq } from 'drizzle-orm';
import type { DbOrTx } from './driver';
import { meta, outbox, syncedTables, type SyncedTableName } from './schema';

/** Everything a write needs to know. One per transaction. */
export interface Ctx {
  tx: DbOrTx;
  /** Clock reading for this operation, ms since epoch. */
  now: number;
  /**
   * `client` queues every write in the outbox for the next push.
   * `server` stamps every write with the next server version instead.
   */
  role: 'client' | 'server';
  deviceId: string;
  tzOffsetMinutes: number;
  fuzz: boolean;
  /** Set when the transaction wrote anything, so listeners are only notified of real changes. */
  wrote: boolean;
}

export type Rows = { [K in SyncedTableName]: (typeof syncedTables)[K]['$inferSelect'] };
export type RowInput<K extends SyncedTableName> = Omit<Rows[K], 'modifiedAt' | 'serverVersion'> &
  Partial<Pick<Rows[K], 'modifiedAt' | 'serverVersion'>>;

export async function getMeta(tx: DbOrTx, key: string): Promise<string | null> {
  const rows = await tx.select().from(meta).where(eq(meta.key, key));
  return rows[0]?.value ?? null;
}

export async function setMeta(tx: DbOrTx, key: string, value: string): Promise<void> {
  await tx.insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } });
}

/** Server only: the next value of the single monotonically increasing version counter. */
export async function nextServerVersion(tx: DbOrTx): Promise<number> {
  const next = Number((await getMeta(tx, 'server_version')) ?? 0) + 1;
  await setMeta(tx, 'server_version', String(next));
  return next;
}

/**
 * The only way user data is written. Upserts the whole row, bumps
 * `modified_at`, and either queues it for push (client) or stamps a server
 * version (server). Writing rows any other way would leave them invisible to sync.
 */
export async function put<K extends SyncedTableName>(ctx: Ctx, name: K, row: RowInput<K>): Promise<Rows[K]> {
  const table = syncedTables[name];
  const full = {
    ...row,
    // Strictly increasing per row even if the device clock steps backwards.
    modifiedAt: Math.max(ctx.now, (row.modifiedAt ?? 0) + 1),
    serverVersion: ctx.role === 'server' ? await nextServerVersion(ctx.tx) : (row.serverVersion ?? null),
  } as Rows[K];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.tx.insert(table) as any).values(full).onConflictDoUpdate({ target: table.id, set: full });
  if (ctx.role === 'client') await ctx.tx.insert(outbox).values({ tableName: name, rowId: full.id });
  ctx.wrote = true;
  return full;
}

/** Soft delete: the row stays, marked, until the server purges it. */
export async function softDelete<K extends SyncedTableName>(ctx: Ctx, name: K, row: Rows[K]): Promise<void> {
  if (row.deletedAt !== null) return;
  await put(ctx, name, { ...row, deletedAt: ctx.now } as RowInput<K>);
}

export function chunk<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
