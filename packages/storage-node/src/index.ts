import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface NodeDriver {
  exec(sql: string, params: unknown[]): Promise<unknown[][]>;
  /** The underlying connection, for backup and pragmas. */
  raw: DatabaseSync;
  close(): void;
}

/** SQLite through Node's built-in driver. Pass ':memory:' for tests. */
export function openNodeDriver(path: string): NodeDriver {
  const raw = new DatabaseSync(path);
  if (path !== ':memory:') {
    // The dk CLI writes from a second process, so WAL and a busy timeout are required.
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA busy_timeout = 5000');
  }
  return {
    raw,
    async exec(sql, params) {
      const stmt = raw.prepare(sql);
      stmt.setReturnArrays(true);
      const bound = params.map((p) => (typeof p === 'boolean' ? Number(p) : p)) as SQLInputValue[];
      return stmt.all(...bound) as unknown as unknown[][];
    },
    close: () => raw.close(),
  };
}
