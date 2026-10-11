import crypto from 'node:crypto';
import type { SqlDriver } from '@dk/core';

// node:crypto gained argon2 in Node 24.7; the type definitions may lag behind.
type Argon2 = (
  algorithm: 'argon2id',
  params: { message: string | Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
) => Buffer;
const argon2Sync = (crypto as unknown as { argon2Sync: Argon2 }).argon2Sync;

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

/** Hashes a password as a standard argon2id PHC string. */
export function hashPassword(password: string): string {
  const [memory, passes, parallelism] = [19456, 2, 1];
  const nonce = crypto.randomBytes(16);
  const tag = argon2Sync('argon2id', { message: password, nonce, parallelism, tagLength: 32, memory, passes });
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(nonce)}$${b64(tag)}`;
}

export function verifyPassword(phc: string, password: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc.trim());
  if (!m) return false;
  const nonce = Buffer.from(m[4]!, 'base64');
  const want = Buffer.from(m[5]!, 'base64');
  const got = argon2Sync('argon2id', {
    message: password,
    nonce,
    parallelism: Number(m[3]),
    tagLength: want.length,
    memory: Number(m[1]),
    passes: Number(m[2]),
  });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export interface SessionInfo {
  id: string;
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Login sessions, one per device. Only a hash of each token is stored. */
export class Sessions {
  private constructor(private driver: SqlDriver) {}

  static async open(driver: SqlDriver): Promise<Sessions> {
    await driver.exec(
      `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL)`,
      [],
    );
    return new Sessions(driver);
  }

  async create(deviceName: string): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    await this.driver.exec('INSERT INTO sessions (id, token_hash, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [
      crypto.randomUUID(),
      sha256(token),
      deviceName.slice(0, 100) || 'Unnamed device',
      now,
      now,
    ]);
    return token;
  }

  /** Returns the session id if the token is valid. */
  async check(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    const row = (await this.driver.exec('SELECT id, last_seen_at FROM sessions WHERE token_hash = ?', [sha256(token)]))[0];
    if (!row) return null;
    // Touch at most once a minute; this runs on every request.
    if (Date.now() - Number(row[1]) > 60_000) {
      await this.driver.exec('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [Date.now(), row[0]]);
    }
    return String(row[0]);
  }

  async list(): Promise<SessionInfo[]> {
    const rows = await this.driver.exec('SELECT id, device_name, created_at, last_seen_at FROM sessions ORDER BY last_seen_at DESC', []);
    return rows.map((r) => ({ id: String(r[0]), deviceName: String(r[1]), createdAt: Number(r[2]), lastSeenAt: Number(r[3]) }));
  }

  async revoke(id: string): Promise<void> {
    await this.driver.exec('DELETE FROM sessions WHERE id = ?', [id]);
  }
}

/** Allows `max` failed attempts per key in a sliding window. In memory: one process, one user. */
export class RateLimiter {
  private failures = new Map<string, number[]>();
  constructor(
    private max = 5,
    private windowMs = 15 * 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Seconds until another attempt is allowed, or 0. */
  retryAfter(key: string): number {
    const recent = (this.failures.get(key) ?? []).filter((t) => this.now() - t < this.windowMs);
    this.failures.set(key, recent);
    if (recent.length < this.max) return 0;
    return Math.ceil((recent[0]! + this.windowMs - this.now()) / 1000);
  }

  fail(key: string): void {
    this.failures.set(key, [...(this.failures.get(key) ?? []), this.now()]);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
