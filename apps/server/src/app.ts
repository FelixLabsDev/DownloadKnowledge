import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DkError, SyncError, type Collection, type PushRequest } from '@dk/core';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { RateLimiter, verifyPassword, type Sessions } from './auth';

export interface AppConfig {
  col: Collection;
  sessions: Sessions;
  /** argon2id PHC string of the one account's password. */
  passwordHash: string;
  /** Git commit the image was built from. */
  commit: string;
  mediaDir: string;
  dbPath: string;
  /** Built web app to serve, if any. */
  webDist?: string;
  secureCookies?: boolean;
  limiter?: RateLimiter;
}

const COOKIE = 'dk_session';
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

export function createApp(cfg: AppConfig) {
  const app = new Hono<{ Variables: { sessionId: string } }>();
  const limiter = cfg.limiter ?? new RateLimiter();
  const mediaPath = (hash: string) => path.join(cfg.mediaDir, hash);
  const clientKey = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';

  app.onError((err, c) => {
    if (err instanceof DkError) return c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : 400);
    if (err instanceof SyncError || err instanceof SyntaxError) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  // The deploy check polls this until it reports the new commit.
  app.get('/api/health', (c) => c.json({ status: 'ok', commit: cfg.commit }));

  app.post('/api/login', async (c) => {
    const key = clientKey(c);
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return c.json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.` }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as { password?: unknown; deviceName?: unknown };
    if (typeof body.password !== 'string' || !verifyPassword(cfg.passwordHash, body.password)) {
      limiter.fail(key);
      return c.json({ error: 'Wrong password.' }, 401);
    }
    limiter.succeed(key);
    const token = await cfg.sessions.create(typeof body.deviceName === 'string' ? body.deviceName : '');
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      secure: cfg.secureCookies ?? true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 400 * 24 * 3600, // The longest browsers allow.
    });
    return c.json({ ok: true });
  });

  app.use('/api/*', async (c, next) => {
    const id = await cfg.sessions.check(getCookie(c, COOKIE));
    if (!id) return c.json({ error: 'Not signed in.' }, 401);
    c.set('sessionId', id);
    return next();
  });

  app.get('/api/session', async (c) => c.json({ current: c.get('sessionId'), sessions: await cfg.sessions.list() }));

  app.post('/api/logout', async (c) => {
    await cfg.sessions.revoke(c.get('sessionId'));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.delete('/api/sessions/:id', async (c) => {
    await cfg.sessions.revoke(c.req.param('id'));
    return c.json({ ok: true });
  });

  // Sync ---------------------------------------------------------------------

  app.post('/api/sync/push', async (c) => c.json(await cfg.col.applyPush((await c.req.json()) as PushRequest)));

  app.get('/api/sync/pull', async (c) => {
    const since = Number(c.req.query('since') ?? 0);
    const limit = Number(c.req.query('limit') ?? 0);
    if (!Number.isFinite(since) || since < 0) return c.json({ error: 'Bad "since".' }, 400);
    return c.json(await cfg.col.readChanges(since, limit));
  });

  // Media: content-addressed by sha256 ----------------------------------------

  app.post('/api/media/missing', async (c) => {
    const { ids } = (await c.req.json()) as { ids?: unknown };
    if (!Array.isArray(ids)) return c.json({ error: 'Expected { ids: [...] }.' }, 400);
    const missing: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !HASH.test(id)) continue;
      if (!(await fs.stat(mediaPath(id)).catch(() => null))) missing.push(id);
    }
    return c.json({ missing });
  });

  app.put('/api/media/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!HASH.test(hash)) return c.json({ error: 'Bad hash.' }, 400);
    if (Number(c.req.header('content-length') ?? 0) > MAX_MEDIA_BYTES) return c.json({ error: 'File too large.' }, 413);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) return c.json({ error: 'File too large.' }, 413);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) {
      return c.json({ error: 'The content does not match its hash.' }, 400);
    }
    await fs.mkdir(cfg.mediaDir, { recursive: true });
    // Write then rename, so a half-written file is never served.
    const tmp = `${mediaPath(hash)}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, mediaPath(hash));
    return c.json({ ok: true });
  });

  app.get('/api/media/:hash', async (c) => {
    const hash = c.req.param('hash');
    if (!HASH.test(hash)) return c.json({ error: 'Bad hash.' }, 400);
    const stat = await fs.stat(mediaPath(hash)).catch(() => null);
    if (!stat) return c.json({ error: 'Not found.' }, 404);
    return new Response(Readable.toWeb(createReadStream(mediaPath(hash))) as ReadableStream, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(stat.size),
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });

  /** For the dashboard's storage readout. */
  app.get('/api/storage', async (c) => {
    const dbBytes = (await fs.stat(cfg.dbPath).catch(() => null))?.size ?? 0;
    let mediaBytes = 0;
    let mediaFiles = 0;
    for (const name of await fs.readdir(cfg.mediaDir).catch(() => [] as string[])) {
      const s = await fs.stat(path.join(cfg.mediaDir, name)).catch(() => null);
      if (!s?.isFile()) continue;
      mediaBytes += s.size;
      mediaFiles++;
    }
    const disk = await fs.statfs(path.dirname(cfg.dbPath)).catch(() => null);
    return c.json({ dbBytes, mediaBytes, mediaFiles, diskFreeBytes: disk ? Number(disk.bavail) * Number(disk.bsize) : null });
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

  // The web app: one origin, so no CORS -----------------------------------------

  if (cfg.webDist) {
    const root = path.relative(process.cwd(), cfg.webDist) || '.';
    app.use('*', async (c, next) => {
      await next();
      // The service worker and the page itself must always be revalidated, or updates would stall.
      const p = c.req.path;
      if (p === '/' || /\/(index\.html|sw\.js|registerSW\.js|manifest\.webmanifest)$/.test(p) || !path.extname(p)) {
        c.header('Cache-Control', 'no-cache');
      } else if (p.startsWith('/assets/')) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
    });
    app.use('*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  }

  return app;
}
