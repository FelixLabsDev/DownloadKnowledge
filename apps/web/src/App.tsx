import { Layers, Plus, Search, Settings as SettingsIcon, Shapes } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { SyncDot, SyncLine } from './components/Sync';
import { Button, Card } from './components/ui';
import { useDbStatus } from './db/client';
import { cn } from './lib/utils';
import { BrowsePage } from './pages/Browse';
import { DecksPage } from './pages/Decks';
import { NoteEditorPage } from './pages/NoteEditor';
import { NoteTypesPage } from './pages/NoteTypes';
import { SettingsPage } from './pages/Settings';
import { StudyPage } from './pages/Study';

const NAV = [
  { to: '/', label: 'Decks', icon: Layers },
  { to: '/add', label: 'Add', icon: Plus },
  { to: '/browse', label: 'Browse', icon: Search },
  { to: '/note-types', label: 'Note types', icon: Shapes, desktopOnly: true },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function Splash({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-md p-8 text-center">
        <img src="/icon.svg" alt="" className="mx-auto mb-4 size-14 rounded-xl" />
        <h1 className="text-lg font-semibold">{title}</h1>
        {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
      </Card>
    </div>
  );
}

/** Offers the reload when a new version is ready. Never shown mid-review. */
function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const studying = useLocation().pathname.startsWith('/study');
  if (!needRefresh || studying) return null;
  return (
    <div className="flex items-center justify-center gap-3 bg-primary px-4 py-2 text-sm text-primary-foreground" role="status">
      A new version is available.
      <Button size="sm" variant="secondary" onClick={() => void updateServiceWorker(true)}>
        Reload
      </Button>
    </div>
  );
}

function Shell() {
  return (
    <div className="flex h-full flex-col">
      <UpdatePrompt />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="hidden w-56 shrink-0 flex-col gap-1 border-r bg-card p-3 md:flex" aria-label="Main">
          <div className="mb-4 flex items-center gap-2 px-2 pt-1">
            <img src="/icon.svg" alt="" className="size-7 rounded-md" />
            <span className="font-semibold tracking-tight">DownloadKnowledge</span>
          </div>
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
                  isActive && 'bg-accent text-primary hover:bg-accent hover:text-primary',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
          <NavLink to="/settings" className="mt-auto rounded-md px-3 py-2 hover:bg-muted" aria-label="Sync status">
            <SyncLine />
          </NavLink>
        </nav>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-4 py-5 md:px-8 md:py-8">
            <Outlet />
          </div>
        </main>
        <nav
          className="flex shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
          aria-label="Main"
        >
          {NAV.filter((n) => !n.desktopOnly).map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn('flex flex-1 flex-col items-center gap-1 py-2.5 text-xs text-muted-foreground', isActive && 'text-primary')
              }
            >
              <span className="relative">
                <Icon className="size-5" />
                {to === '/settings' && <SyncDot className="absolute -right-1.5 -top-0.5" />}
              </span>
              {label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}

export function App() {
  const status = useDbStatus();
  if (status.state === 'starting') return <Splash title="Opening your collection…" />;
  if (status.state === 'blocked') {
    return (
      <Splash title="Open in another tab">
        DownloadKnowledge is already open in another tab or window. Your cards live in one local database that only one
        tab can use at a time. Close the other tab and this one will take over.
      </Splash>
    );
  }
  if (status.state === 'failed') {
    return (
      <Splash title="The local database could not be opened">
        <p>{status.message}</p>
        <p className="mt-2">This app needs a browser with OPFS storage (Chrome, Edge, Firefox or Safari, recent versions) and a secure context (https or localhost).</p>
      </Splash>
    );
  }
  return (
    <Routes>
      <Route path="/study/:deckId" element={<StudyPage />} />
      <Route element={<Shell />}>
        <Route index element={<DecksPage />} />
        <Route path="add" element={<NoteEditorPage />} />
        <Route path="note/:noteId" element={<NoteEditorPage />} />
        <Route path="browse" element={<BrowsePage />} />
        <Route path="note-types" element={<NoteTypesPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
