import { parseDelimited, type AnkiImportSummary, type ColumnTarget, type ParsedTable, type RowImportResult } from '@dk/core';
import { Download, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, Label, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { api, onImportProgress, useLive } from '@/db/client';
import type { ImportProgress } from '@/db/protocol';

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Anki ---------------------------------------------------------------------------------

function AnkiSummary({ s }: { s: AnkiImportSummary }) {
  const lines = [
    `${plural(s.notesAdded, 'note')} and ${plural(s.cardsAdded, 'card')} added` + (s.decks.length ? ` to ${s.decks.join(', ')}` : ''),
    s.notesUpdated > 0 && `${plural(s.notesUpdated, 'note')} that were already here were updated`,
    s.cardsKept > 0 && `${plural(s.cardsKept, 'card')} were already here; their scheduling was left as it is`,
    s.noteTypesCreated.length > 0 && `New note types: ${s.noteTypesCreated.join(', ')}`,
    s.scheduledFromFsrs > 0 && `${plural(s.scheduledFromFsrs, 'card')} kept their FSRS scheduling exactly`,
    s.scheduledFromSm2 > 0 && `${plural(s.scheduledFromSm2, 'card')} used Anki's older SM-2 scheduling and were converted (same due date and interval; memory strength estimated from the interval)`,
    s.resetToNew > 0 && `${plural(s.resetToNew, 'card')} were part-way through learning and start again as new`,
    s.suspended > 0 && `${plural(s.suspended, 'card')} are suspended, as they were in Anki`,
    s.reviews > 0 && `${plural(s.reviews, 'past review')} imported into your history`,
    s.media > 0 && `${plural(s.media, 'media file')} imported`,
    s.notesSkipped > 0 && `${plural(s.notesSkipped, 'note')} skipped because their note type was missing from the package`,
  ].filter(Boolean) as string[];
  return (
    <div className="mt-4 text-sm" data-testid="anki-summary">
      <h3 className="mb-1 font-medium">Import finished</h3>
      <ul className="list-disc space-y-0.5 pl-5">{lines.map((l) => <li key={l}>{l}.</li>)}</ul>
      {s.warnings.length > 0 && (
        <>
          <h3 className="mb-1 mt-3 font-medium text-rate-hard">Will not work as in Anki</h3>
          <ul className="list-disc space-y-0.5 pl-5">{s.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </>
      )}
    </div>
  );
}

function AnkiImportCard() {
  const { fail } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [keep, setKeep] = useState(true);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<AnkiImportSummary | null>(null);

  useEffect(() => onImportProgress(setProgress), []);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setSummary(null);
    try {
      setSummary(await api.importApkg(file, { keepScheduling: keep }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Card className="p-4 md:p-5">
      <h2 className="font-medium">From Anki</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        In Anki choose File → Export, format "Anki Deck Package (.apkg)", and include media. Decks, note types, tags and media come across. Importing the same package again updates it without duplicating anything.
      </p>
      <div className="flex flex-col gap-3">
        <input type="file" accept=".apkg,.colpkg,application/zip" aria-label="Anki package" className="text-sm file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-2 file:text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSummary(null); }} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>Keep my scheduling and review history from Anki<br /><span className="text-muted-foreground">Unticked, every card starts as new.</span></span>
        </label>
        <div>
          <Button disabled={!file || busy} onClick={() => void run()}><Upload /> {busy ? 'Importing…' : 'Import'}</Button>
        </div>
        {busy && progress && (
          <div role="status">
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>{progress.phase}</span>
              <span className="tabular-nums">{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
      </div>
      {summary && <AnkiSummary s={summary} />}
    </Card>
  );
}

// CSV / TSV ---------------------------------------------------------------------------------

const targetValue = (t: ColumnTarget) => (t === null ? '' : typeof t === 'string' ? t : `f${t.field}`);
const parseTarget = (v: string): ColumnTarget => (v === '' ? null : v === 'tags' || v === 'deck' ? v : { field: Number(v.slice(1)) });

function ListImportCard() {
  const { fail } = useToast();
  const decks = useLive(() => api.deckTree(), []);
  const types = useLive(() => api.listNoteTypes(), []);
  const [text, setText] = useState('');
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [typeId, setTypeId] = useState('');
  const [deckId, setDeckId] = useState('');
  const [mapping, setMapping] = useState<ColumnTarget[]>([]);
  const [header, setHeader] = useState(false);
  const [allowDup, setAllowDup] = useState(false);
  const [result, setResult] = useState<RowImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const type = types.data?.find((t) => t.id === typeId) ?? types.data?.[0];
  const deck = decks.data?.find((d) => d.deck.id === deckId) ?? decks.data?.[0];

  // Parse on change, and guess the mapping: by header names if they match, otherwise by position.
  useEffect(() => {
    if (!text.trim() || !type) {
      setTable(null);
      return;
    }
    const t = parseDelimited(text);
    setTable(t);
    setResult(null);
    const first = (t.rows[0] ?? []).map((h) => h.toLowerCase());
    const byName = first.map<ColumnTarget>((h) => {
      const f = type.fields.findIndex((n) => n.toLowerCase() === h);
      return f >= 0 ? { field: f } : h === 'tags' || h === 'deck' ? h : null;
    });
    const named = byName.some((m) => m && typeof m === 'object' && m.field === 0);
    setHeader(named);
    setMapping(named ? byName : Array.from({ length: t.columns }, (_, i) => (i < type.fields.length ? { field: i } : null)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, type?.id]);

  if (decks.data && decks.data.length === 0) {
    return <EmptyState title="Create a deck first">A list is imported into a deck, so you need one.</EmptyState>;
  }

  const run = async () => {
    if (!table || !type || !deck) return;
    setBusy(true);
    try {
      setResult(await api.importRows(table.rows, { noteTypeId: type.id, deckId: deck.deck.id, mapping, skipFirstRow: header, allowDuplicates: allowDup }));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const dataRows = table ? table.rows.length - (header ? 1 : 0) : 0;

  return (
    <Card className="p-4 md:p-5">
      <h2 className="font-medium">From a list (CSV or TSV)</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        One note per line, columns separated by commas, semicolons or tabs. Choose a file or paste the text; a spreadsheet's cells can be pasted directly.
      </p>
      <div className="flex flex-col gap-3">
        <input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" aria-label="List file" className="text-sm file:mr-3 file:rounded-md file:border file:bg-card file:px-3 file:py-2 file:text-sm" onChange={(e) => void e.target.files?.[0]?.text().then(setText, fail)} />
        <Textarea aria-label="List text" rows={4} placeholder={'perro\tdog\ngato\tcat'} value={text} onChange={(e) => setText(e.target.value)} />

        {table && type && deck && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="list-deck">Into deck</Label>
                <Select id="list-deck" value={deck.deck.id} onChange={(e) => setDeckId(e.target.value)}>
                  {decks.data!.map((d) => <option key={d.deck.id} value={d.deck.id}>{d.path}</option>)}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="list-type">As note type</Label>
                <Select id="list-type" value={type.id} onChange={(e) => setTypeId(e.target.value)}>
                  {types.data!.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </div>
            </div>

            <div>
              <div className="mb-1 text-sm font-medium">What each column is</div>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      {Array.from({ length: table.columns }, (_, i) => (
                        <th key={i} className="min-w-36 p-2 text-left font-normal">
                          <Select
                            aria-label={`Column ${i + 1}`}
                            className="h-9"
                            value={targetValue(mapping[i] ?? null)}
                            onChange={(e) => setMapping(Array.from({ length: table.columns }, (_, j) => (j === i ? parseTarget(e.target.value) : (mapping[j] ?? null))))}
                          >
                            <option value="">Ignore</option>
                            {type.fields.map((f, k) => <option key={f} value={`f${k}`}>{f}</option>)}
                            <option value="tags">Tags</option>
                            <option value="deck">Deck</option>
                          </Select>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, 4).map((r, i) => (
                      <tr key={i} className={i === 0 && header ? 'border-b text-muted-foreground line-through' : 'border-b last:border-b-0'}>
                        {Array.from({ length: table.columns }, (_, j) => <td key={j} className="max-w-56 truncate p-2">{r[j] ?? ''}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {table.rows.length > 4 && <p className="mt-1 text-xs text-muted-foreground">Showing 4 of {table.rows.length.toLocaleString()} lines.</p>}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={header} onChange={(e) => setHeader(e.target.checked)} /> The first line is a header, not a note
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} /> Import notes even if the deck already has one with the same {type.fields[0]!.toLowerCase()}
            </label>
            <div>
              <Button disabled={busy || dataRows === 0} onClick={() => void run()}><Upload /> Import {plural(dataRows, 'note')}</Button>
            </div>
          </>
        )}

        {result && (
          <div className="text-sm" data-testid="list-summary">
            <p>
              Added {plural(result.added, 'note')} ({plural(result.cards, 'card')}).
              {result.duplicates > 0 && ` Skipped ${plural(result.duplicates, 'duplicate')}.`}
            </p>
            {result.errors.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-destructive">
                {result.errors.slice(0, 20).map((e) => <li key={e.row}>Line {e.row}: {e.message}</li>)}
                {result.errors.length > 20 && <li>…and {result.errors.length - 20} more.</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// Export ----------------------------------------------------------------------------------

function ExportCard() {
  const { fail } = useToast();
  const stamp = () => new Date().toISOString().slice(0, 10);
  return (
    <Card className="p-4 md:p-5">
      <h2 className="font-medium">Export</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        The backup holds everything on this device: decks, note types, notes, cards, scheduling and the full review history. Media files are not inside it; they are kept on the server and in its backups. The CSV is your notes only, for a spreadsheet or another app.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => api.exportBackup().then((b) => download(`downloadknowledge-backup-${stamp()}.json`, JSON.stringify(b), 'application/json'), fail)}>
          <Download /> Full backup (JSON)
        </Button>
        <Button variant="outline" onClick={() => api.exportNotesCsv().then((csv) => download(`downloadknowledge-notes-${stamp()}.csv`, csv, 'text/csv'), fail)}>
          <Download /> Notes (CSV)
        </Button>
      </div>
    </Card>
  );
}

export function ImportPage() {
  return (
    <>
      <PageHeader title="Import and export" />
      <div className="flex flex-col gap-4">
        <AnkiImportCard />
        <ListImportCard />
        <ExportCard />
      </div>
    </>
  );
}
