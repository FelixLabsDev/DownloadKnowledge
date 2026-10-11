import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Label, PageHeader, Select, useToast } from '@/components/ui';
import { api, useLive } from '@/db/client';
import { applyTheme, formatBytes, getTheme, type Theme } from '@/lib/utils';

declare const __COMMIT__: string;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium tabular-nums" data-testid={`info-${label.toLowerCase().replace(/\W+/g, '-')}`}>{children}</span>
    </div>
  );
}

export function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(getTheme());
  const info = useLive(() => api.storageInfo(), []);
  const probe = useLive(() => api.probeRead(), []);
  const { fail } = useToast();
  const s = info.data;

  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-4">
        <Card className="p-4">
          <h2 className="mb-3 font-medium">Appearance</h2>
          <div className="flex max-w-xs flex-col gap-1.5">
            <Label htmlFor="theme">Theme</Label>
            <Select
              id="theme"
              value={theme}
              onChange={(e) => {
                const t = e.target.value as Theme;
                setTheme(t);
                applyTheme(t);
              }}
            >
              <option value="system">Match the device</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
          </div>
          <p className="mt-3 text-sm text-muted-foreground md:hidden">
            <Link to="/note-types" className="text-primary underline">Edit note types and templates</Link>
          </p>
        </Card>

        <Card className="p-4">
          <h2 className="mb-1 font-medium">Storage on this device</h2>
          <p className="mb-3 text-sm text-muted-foreground">Your collection is stored in this browser and works without a connection.</p>
          {s && (
            <div>
              <Row label="Database">{formatBytes(s.dbBytes)}</Row>
              <Row label="Media">{formatBytes(s.mediaBytes)} in {s.mediaFiles} {s.mediaFiles === 1 ? 'file' : 'files'}</Row>
              <Row label="Used by this site">{formatBytes(s.usage)} of {formatBytes(s.quota)} allowed</Row>
              <Row label="Protected from eviction">{s.persisted ? 'Yes' : 'No'}</Row>
              <Row label="Engine">SQLite {s.sqliteVersion} ({s.vfs})</Row>
            </div>
          )}
          {s && !s.persisted && (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-muted-foreground">The browser may clear unprotected data if the device runs low on space. Installing the app usually grants protection.</span>
              <Button size="sm" variant="outline" onClick={() => void navigator.storage.persist().then(() => info.reload())}>Ask for protection</Button>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-1 font-medium">Storage self-test</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Writes a row to the local database. Close the app completely, reopen it (try it in airplane mode), and the rows should still be listed.
          </p>
          <Button variant="outline" onClick={() => api.probeWrite(`written ${new Date().toLocaleString()}`).then(() => probe.reload(), fail)}>
            Write a test row
          </Button>
          <ul className="mt-3 flex flex-col gap-1 text-sm" data-testid="probe-rows">
            {(probe.data ?? []).map((r) => <li key={r.at} className="tabular-nums">{r.value}</li>)}
            {probe.data?.length === 0 && <li className="text-muted-foreground">No test rows yet.</li>}
          </ul>
        </Card>

        <p className="text-xs text-muted-foreground">Version {__COMMIT__.slice(0, 7)}</p>
      </div>
    </>
  );
}
