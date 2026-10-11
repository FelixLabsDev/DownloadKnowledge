import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { migrations } from './migrations';
import * as schema from './schema';

/**
 * The storage seam. Core talks to SQLite only through this, so the same code
 * runs in the browser worker (sqlite-wasm on OPFS), the server and the CLI
 * (node:sqlite). Implementations hold exactly one connection.
 */
export interface SqlDriver {
  /** Runs one statement and returns its rows as arrays of column values (empty for writes). */
  exec(sql: string, params: unknown[]): Promise<unknown[][]>;
}

export type Db = SqliteRemoteDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function openDb(driver: SqlDriver): Db {
  return drizzle(
    async (sql, params, method) => {
      const rows = await driver.exec(sql, params);
      return { rows: method === 'get' ? (rows[0] as unknown[]) : rows };
    },
    { schema },
  );
}

/** Applies pending migrations. Returns how many ran. */
export async function migrate(driver: SqlDriver, onBeforeMigrate?: () => Promise<void>): Promise<number> {
  const current = Number((await driver.exec('PRAGMA user_version', []))[0]?.[0] ?? 0);
  if (current >= migrations.length) return 0;
  if (current > 0) await onBeforeMigrate?.();
  for (let v = current; v < migrations.length; v++) {
    await driver.exec('BEGIN', []);
    try {
      for (const stmt of migrations[v]!) await driver.exec(stmt, []);
      await driver.exec(`PRAGMA user_version = ${v + 1}`, []);
      await driver.exec('COMMIT', []);
    } catch (e) {
      await driver.exec('ROLLBACK', []);
      throw e;
    }
  }
  return migrations.length - current;
}
