import { useEffect, useRef, useState, type DependencyList } from 'react';
import type { Api, Request, Response } from './protocol';

export type DbStatus =
  | { state: 'starting' }
  | { state: 'ready' }
  /** Another tab holds the database; this one waits its turn. */
  | { state: 'blocked' }
  | { state: 'failed'; message: string };

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const changeListeners = new Set<() => void>();
const statusListeners = new Set<(s: DbStatus) => void>();
let status: DbStatus = { state: 'starting' };
let worker: Worker | null = null;
let nextId = 1;
let queued: Request[] = [];

function setStatus(s: DbStatus) {
  status = s;
  for (const l of statusListeners) l(s);
}

function startWorker() {
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'dk-db' });
  worker.onmessage = (e: MessageEvent<Response>) => {
    const msg = e.data;
    if ('event' in msg) {
      if (msg.event === 'ready') {
        setStatus({ state: 'ready' });
        void navigator.storage?.persist?.();
      } else if (msg.event === 'failed') {
        setStatus({ state: 'failed', message: msg.message });
        for (const p of pending.values()) p.reject(new ApiError('storage', msg.message));
        pending.clear();
      } else for (const l of changeListeners) l();
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new ApiError(msg.error.code, msg.error.message));
  };
  worker.onerror = (e) => setStatus({ state: 'failed', message: e.message || 'The database worker failed to start.' });
  for (const r of queued) worker.postMessage(r);
  queued = [];
}

/**
 * Only one tab may own the database. We hold a Web Lock for the life of the
 * page; a second tab shows "open in another tab" and takes over automatically
 * when the first one closes.
 */
export function startDb() {
  if (worker || status.state === 'blocked') return;
  if (!navigator.locks) {
    startWorker();
    return;
  }
  const hold = () => new Promise<void>(() => startWorker());
  void navigator.locks.request('dk-db', { ifAvailable: true }, (lock) => {
    if (lock) return hold();
    setStatus({ state: 'blocked' });
    void navigator.locks.request('dk-db', () => {
      setStatus({ state: 'starting' });
      return hold();
    });
    return undefined;
  });
}

/** The data API. Every call is a message to the worker. */
export const api = new Proxy({} as Api, {
  get(_t, method: string) {
    return (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const req: Request = { id: nextId++, method, args };
        pending.set(req.id, { resolve, reject });
        if (worker) worker.postMessage(req);
        else queued.push(req);
      });
  },
});

export function useDbStatus(): DbStatus {
  const [s, set] = useState(status);
  useEffect(() => {
    set(status);
    statusListeners.add(set);
    return () => void statusListeners.delete(set);
  }, []);
  return s;
}

export function onDbChange(fn: () => void): () => void {
  changeListeners.add(fn);
  return () => void changeListeners.delete(fn);
}

export interface Live<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload(): void;
}

/** Runs a query and re-runs it whenever the database changes. */
export function useLive<T>(query: () => Promise<T>, deps: DependencyList): Live<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const latest = useRef(0);
  const run = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    run.current = () => {
      const ticket = ++latest.current;
      query().then(
        (data) => alive && ticket === latest.current && setState({ data, loading: false }),
        (error: Error) => alive && ticket === latest.current && setState({ error, loading: false }),
      );
    };
    run.current();
    const off = onDbChange(() => run.current());
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data: state.data, error: state.error, loading: state.loading, reload: () => run.current() };
}
