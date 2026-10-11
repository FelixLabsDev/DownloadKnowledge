import { useEffect, useState } from 'react';
import { api, useSyncStatus } from '@/db/client';
import type { SyncStatus } from '@/db/protocol';
import { cn, formatInterval } from '@/lib/utils';
import { Button, Card, Input, Label, useToast } from './ui';

/** One line describing where sync stands, and a colour for it. */
export function describeSync(s: SyncStatus): { label: string; tone: 'ok' | 'busy' | 'warn' | 'bad' | 'off' } {
  const pending = s.pending ? `${s.pending} ${s.pending === 1 ? 'change' : 'changes'} waiting` : '';
  switch (s.phase) {
    case 'syncing':
      return { label: 'Syncing…', tone: 'busy' };
    case 'offline':
      return { label: pending ? `Offline · ${pending}` : 'Offline', tone: 'warn' };
    case 'signed-out':
      return { label: pending ? `Not signed in · ${pending}` : 'Not signed in', tone: 'off' };
    case 'error':
      return { label: 'Sync error', tone: 'bad' };
    default:
      return pending ? { label: pending, tone: 'busy' } : { label: 'Synced', tone: 'ok' };
  }
}

const TONES = {
  ok: 'bg-state-review',
  busy: 'bg-state-new',
  warn: 'bg-rate-hard',
  bad: 'bg-destructive',
  off: 'bg-muted-foreground/50',
};

export function SyncDot({ className }: { className?: string }) {
  const { tone, label } = describeSync(useSyncStatus());
  return <span className={cn('inline-block size-2 rounded-full', TONES[tone], className)} title={label} />;
}

export function SyncLine({ className }: { className?: string }) {
  const { tone, label } = describeSync(useSyncStatus());
  return (
    <span className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)} data-testid="sync-status">
      <span className={cn('size-2 shrink-0 rounded-full', TONES[tone])} />
      {label}
    </span>
  );
}

interface Session {
  id: string;
  deviceName: string;
  lastSeenAt: number;
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox/.test(ua) ? 'Firefox' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${os} ${browser}`;
}

export function SyncCard() {
  const status = useSyncStatus();
  const { toast, fail } = useToast();
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState(() => localStorage.getItem('dk-device-name') ?? defaultDeviceName());
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<{ current: string; sessions: Session[] } | null>(null);
  const signedIn = status.phase !== 'signed-out';

  useEffect(() => {
    if (status.phase !== 'idle') return;
    fetch('/api/session').then(async (r) => setSessions(r.ok ? await r.json() : null), () => setSessions(null));
  }, [status.phase, status.lastSyncedAt]);

  const signIn = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, deviceName }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Sign-in failed (${res.status}).`);
      localStorage.setItem('dk-device-name', deviceName);
      setPassword('');
      await api.syncNow();
      toast('Signed in. This device now syncs.');
    } catch (e) {
      fail(e instanceof TypeError ? new Error('The server cannot be reached.') : e);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    setSessions(null);
    await api.syncNow();
  };

  const revoke = async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    setSessions((s) => s && { ...s, sessions: s.sessions.filter((x) => x.id !== id) });
  };

  return (
    <Card className="p-4">
      <h2 className="mb-1 font-medium">Sync</h2>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <SyncLine className="text-sm" />
        {status.lastSyncedAt && signedIn && (
          <span className="text-sm text-muted-foreground">Last synced {formatInterval(Date.now() - status.lastSyncedAt)} ago</span>
        )}
      </div>
      {status.error && <p className="mb-3 text-sm text-destructive">{status.error}</p>}

      {signedIn ? (
        <>
          <div className="flex gap-2">
            <Button variant="outline" disabled={status.phase === 'syncing'} onClick={() => void api.syncNow()}>Sync now</Button>
            {status.phase !== 'offline' && <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>}
          </div>
          {status.phase === 'offline' && (
            <p className="mt-3 text-sm text-muted-foreground">
              Keep studying: everything is saved on this device and will be sent when the connection returns.
            </p>
          )}
          {sessions && sessions.sessions.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-1 text-sm font-medium">Signed-in devices</h3>
              <ul className="text-sm">
                {sessions.sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 border-b py-2 last:border-b-0">
                    <span className="flex-1">
                      {s.deviceName}
                      {s.id === sessions.current && <span className="text-muted-foreground"> (this device)</span>}
                    </span>
                    <span className="text-muted-foreground">{formatInterval(Date.now() - s.lastSeenAt)} ago</span>
                    {s.id !== sessions.current && <Button size="sm" variant="outline" onClick={() => void revoke(s.id)}>Sign out</Button>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <form
          className="flex max-w-sm flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn();
          }}
        >
          <p className="text-sm text-muted-foreground">
            Sign in to keep this device in step with your others. Until then everything stays on this device only.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sync-password">Password</Label>
            <Input id="sync-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sync-device">Name for this device</Label>
            <Input id="sync-device" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
          </div>
          <Button type="submit" disabled={busy || !password}>Sign in</Button>
        </form>
      )}
    </Card>
  );
}
