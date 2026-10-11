import fs from 'node:fs';
import path from 'node:path';
import { Collection } from '@dk/core';
import { openNodeDriver, type NodeDriver } from '@dk/storage-node';

export interface Paths {
  dataDir: string;
  dbPath: string;
  mediaDir: string;
}

/** Where the server and the dk CLI keep data. `DATA_DIR` in production; `./.data` at the repo root in development. */
export function dataPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const dataDir = path.resolve(env.DATA_DIR ?? path.join(import.meta.dirname, '../../../.data'));
  return { dataDir, dbPath: path.join(dataDir, 'dk.sqlite3'), mediaDir: path.join(dataDir, 'media') };
}

/**
 * Opens the server's collection. Pending schema migrations run here, before
 * anything is served, and the database is snapshotted first.
 */
export async function openServerCollection(paths: Paths): Promise<{ col: Collection; driver: NodeDriver }> {
  fs.mkdirSync(paths.mediaDir, { recursive: true });
  const driver = openNodeDriver(paths.dbPath);
  const col = await Collection.open(driver, {
    role: 'server',
    onBeforeMigrate: async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${paths.dbPath}.before-migration-${stamp}`;
      // VACUUM INTO takes a consistent snapshot even in WAL mode.
      await driver.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`, []);
      console.log(`Backed up the database to ${backup} before migrating.`);
    },
  });
  return { col, driver };
}
