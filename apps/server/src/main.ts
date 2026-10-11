import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { DAY_MS } from '@dk/core';
import { createApp } from './app';
import { hashPassword, Sessions } from './auth';
import { dataPaths, openServerCollection } from './open';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 8787);
const paths = dataPaths();

let passwordHash = process.env.DK_PASSWORD_HASH ?? '';
if (!passwordHash) {
  if (production) {
    console.error('DK_PASSWORD_HASH is not set. Generate one with: dk hash-password');
    process.exit(1);
  }
  passwordHash = hashPassword('dev');
  console.warn('DK_PASSWORD_HASH is not set: using the development password "dev".');
}

// Migrations run inside this call, before the server listens.
const { col, driver } = await openServerCollection(paths);
const sessions = await Sessions.open(driver);

const purge = async () => {
  const n = await col.purgeDeleted(Date.now() - 30 * DAY_MS);
  if (n) console.log(`Purged ${n} rows deleted more than 30 days ago.`);
};
await purge();
setInterval(() => void purge().catch(console.error), DAY_MS).unref();

const webDist = process.env.WEB_DIST ?? path.join(import.meta.dirname, '../../web/dist');
const app = createApp({
  col,
  sessions,
  passwordHash,
  commit: process.env.GIT_SHA ?? 'dev',
  mediaDir: paths.mediaDir,
  dbPath: paths.dbPath,
  webDist: fs.existsSync(path.join(webDist, 'index.html')) ? webDist : undefined,
  secureCookies: process.env.DK_INSECURE_COOKIES !== '1',
});

const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '0.0.0.0' }, () => {
  console.log(`DownloadKnowledge server listening on :${port} (commit ${process.env.GIT_SHA ?? 'dev'}, data in ${paths.dataDir})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      driver.close();
      process.exit(0);
    });
  });
}
