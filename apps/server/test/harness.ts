import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  Collection,
  syncedTableNames,
  syncedTables,
  type PullResponse,
  type PushRequest,
  type PushResponse,
  type SyncTransport,
} from '@dk/core';
import { openNodeDriver } from '@dk/storage-node';
import { createApp } from '../src/app';
import { hashPassword, RateLimiter, Sessions } from '../src/auth';

export const T0 = Date.UTC(2026, 0, 5, 12);
export const PASSWORD = 'correct horse battery';
const HASH = hashPassword(PASSWORD);

export interface Clock {
  now: number;
}

/** A real server: the Hono app over an in-memory database, called in-process. */
export async function makeServer() {
  const clock: Clock = { now: T0 };
  const driver = openNodeDriver(':memory:');
  const col = await Collection.open(driver, { role: 'server', now: () => clock.now, tzOffsetMinutes: () => 0, fuzz: false });
  const sessions = await Sessions.open(driver);
  const dir = mkdtempSync(path.join(tmpdir(), 'dk-server-test-'));
  const app = createApp({
    col,
    sessions,
    passwordHash: HASH,
    commit: 'test-commit',
    mediaDir: path.join(dir, 'media'),
    dbPath: path.join(dir, 'dk.sqlite3'),
    limiter: new RateLimiter(5, 15 * 60_000, () => clock.now),
  });

  const login = async (password = PASSWORD, deviceName = 'test') => {
    const res = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, deviceName }),
    });
    return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const { cookie } = await login();

  const request = async (url: string, init: RequestInit = {}) => {
    const res = await app.request(url, { ...init, headers: { cookie, 'content-type': 'application/json', ...init.headers } });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${await res.text()}`);
    return res;
  };

  const transport: SyncTransport = {
    push: async (body: PushRequest) => (await request('/api/sync/push', { method: 'POST', body: JSON.stringify(body) })).json() as Promise<PushResponse>,
    pull: async (since, limit) => (await request(`/api/sync/pull?since=${since}&limit=${limit}`)).json() as Promise<PullResponse>,
  };

  return { app, col, clock, cookie, login, request, transport };
}

/** A client: its own in-memory database, device id and clock. */
export async function makeClient(startAt = T0) {
  const clock: Clock = { now: startAt };
  const col = await Collection.open(openNodeDriver(':memory:'), { now: () => clock.now, tzOffsetMinutes: () => 0, fuzz: false });
  return { col, clock };
}

/** Every synced row of a collection, without the server version, in a stable order. */
export async function snapshot(col: Collection): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of syncedTableNames) {
    const rows = (await col.db.select().from(syncedTables[name])) as Record<string, unknown>[];
    out[name] = rows
      .map(({ serverVersion: _v, ...rest }) => rest)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return out;
}

export async function serverVersion(col: Collection): Promise<number> {
  return (await col.readChanges(0, 2000)).next;
}
