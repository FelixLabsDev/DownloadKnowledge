import { clsx, type ClassValue } from 'clsx';
import { useEffect, useState } from 'react';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** "10m", "3d", "2.5mo": how far away a due time is, compactly. */
export function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const hours = ms / 3_600_000;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = ms / 86_400_000;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${trim(days / 30)}mo`;
  return `${trim(days / 365)}y`;
}

const trim = (n: number) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ''));

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'unknown';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDue(due: number, now: number, state: number): string {
  if (state === 0) return 'New';
  const diff = due - now;
  if (diff <= 0) return 'Due';
  return `in ${formatInterval(diff)}`;
}

export const STATE_NAMES = ['New', 'Learning', 'Review', 'Relearning'] as const;

export type Theme = 'system' | 'light' | 'dark';

export function getTheme(): Theme {
  return (localStorage.getItem('dk-theme') as Theme | null) ?? 'system';
}

export function applyTheme(theme: Theme = getTheme()) {
  localStorage.setItem('dk-theme', theme);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export const isDark = () => document.documentElement.classList.contains('dark');

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}
