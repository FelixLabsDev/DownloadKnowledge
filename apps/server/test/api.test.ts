import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth';
import { makeServer, PASSWORD } from './harness';

describe('auth', () => {
  it('hashes and verifies passwords', () => {
    const hash = hashPassword('s3cret-pass');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(verifyPassword(hash, 's3cret-pass')).toBe(true);
    expect(verifyPassword(hash, 's3cret-pasS')).toBe(false);
    expect(verifyPassword('not a hash', 'x')).toBe(false);
  });

  it('verifies a hash produced by the reference argon2 implementation', () => {
    // From the argon2 CLI: echo -n "password" | argon2 somesalt -id -t 2 -m 16 -p 1 -l 32 -e
    const reference = '$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc';
    expect(verifyPassword(reference, 'password')).toBe(true);
    expect(verifyPassword(reference, 'Password')).toBe(false);
  });

  it('serves health without a session, reporting the commit', async () => {
    const { app } = await makeServer();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', commit: 'test-commit' });
  });

  it('refuses everything else without a session', async () => {
    const { app } = await makeServer();
    for (const [method, url] of [
      ['GET', '/api/sync/pull?since=0'],
      ['POST', '/api/sync/push'],
      ['GET', '/api/session'],
      ['GET', `/api/media/${'a'.repeat(64)}`],
      ['PUT', `/api/media/${'a'.repeat(64)}`],
      ['GET', '/api/storage'],
    ] as const) {
      expect((await app.request(url, { method })).status, `${method} ${url}`).toBe(401);
    }
    expect((await app.request('/api/sync/pull', { headers: { cookie: 'dk_session=forged' } })).status).toBe(401);
  });

  it('sets a hardened cookie on login and revokes it on logout', async () => {
    const { app, login } = await makeServer();
    const { res, cookie } = await login(PASSWORD, 'Pixel');
    const header = res.headers.get('set-cookie')!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Max-Age=34560000/);

    const session = (await (await app.request('/api/session', { headers: { cookie } })).json()) as { sessions: { deviceName: string }[] };
    expect(session.sessions.map((s) => s.deviceName).sort()).toEqual(['Pixel', 'test']);

    expect((await app.request('/api/logout', { method: 'POST', headers: { cookie } })).status).toBe(200);
    expect((await app.request('/api/session', { headers: { cookie } })).status).toBe(401);
  });

  it('lets one device revoke another', async () => {
    const { app, login, cookie } = await makeServer();
    const other = await login(PASSWORD, 'Lost phone');
    const { sessions } = (await (await app.request('/api/session', { headers: { cookie } })).json()) as { sessions: { id: string; deviceName: string }[] };
    const lost = sessions.find((s) => s.deviceName === 'Lost phone')!;
    await app.request(`/api/sessions/${lost.id}`, { method: 'DELETE', headers: { cookie } });
    expect((await app.request('/api/session', { headers: { cookie: other.cookie } })).status).toBe(401);
    expect((await app.request('/api/session', { headers: { cookie } })).status).toBe(200);
  });

  it('rate-limits failed logins and recovers after the window', async () => {
    const { login, clock } = await makeServer();
    for (let i = 0; i < 5; i++) expect((await login('wrong')).res.status).toBe(401);
    const blocked = await login(PASSWORD);
    expect(blocked.res.status).toBe(429);
    expect(Number(blocked.res.headers.get('retry-after'))).toBeGreaterThan(0);
    clock.now += 15 * 60_000 + 1;
    expect((await login(PASSWORD)).res.status).toBe(200);
  });
});

describe('media', () => {
  const bytes = Buffer.from('not really a png');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const put = (s: Awaited<ReturnType<typeof makeServer>>, id: string, body: Buffer) =>
    s.app.request(`/api/media/${id}`, { method: 'PUT', headers: { cookie: s.cookie }, body });

  it('stores a file once by content hash and serves it back', async () => {
    const s = await makeServer();
    const other = 'b'.repeat(64);
    const missing = async () => ((await (await s.request('/api/media/missing', { method: 'POST', body: JSON.stringify({ ids: [hash, other, 'junk'] }) })).json()) as { missing: string[] }).missing;
    expect(await missing()).toEqual([hash, other]);
    expect((await put(s, hash, bytes)).status).toBe(200);
    expect((await put(s, hash, bytes)).status).toBe(200); // Uploading again is harmless.
    expect(await missing()).toEqual([other]);
    const got = await s.app.request(`/api/media/${hash}`, { headers: { cookie: s.cookie } });
    expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);
    const storage = (await (await s.request('/api/storage')).json()) as { mediaFiles: number; mediaBytes: number };
    expect(storage).toMatchObject({ mediaFiles: 1, mediaBytes: bytes.length });
  });

  it('rejects content that does not match its hash, and path tricks', async () => {
    const s = await makeServer();
    expect((await put(s, 'c'.repeat(64), bytes)).status).toBe(400);
    expect((await put(s, '..%2F..%2Fetc%2Fpasswd', bytes)).status).toBe(400);
    expect((await s.app.request(`/api/media/${'c'.repeat(64)}`, { headers: { cookie: s.cookie } })).status).toBe(404);
  });
});
