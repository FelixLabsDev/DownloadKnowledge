import type { CardRow } from '@dk/core';
import { Eye, EyeOff, FolderInput, Tag, Tags, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Dialog, EmptyState, Input, Label, PageHeader, Select, useToast } from '@/components/ui';
import { api, useLive } from '@/db/client';
import { cn, formatDue, STATE_NAMES, useMediaQuery } from '@/lib/utils';

const PAGE = 200;
type Bulk = 'move' | 'tag' | 'untag' | 'delete';

const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

export function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const [text, setText] = useState(query);
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const navigate = useNavigate();
  const { toast, fail } = useToast();
  // A table on desktop, a list on a phone.
  const desktop = useMediaQuery('(min-width: 768px)');

  const result = useLive(() => api.searchCards(query, { limit }), [query, limit]);
  const decks = useLive(() => api.deckTree(), []);
  const tags = useLive(() => api.listTags(), []);
  const rows = result.data?.rows ?? [];
  const total = result.data?.total ?? 0;

  // Search as you type, lightly debounced.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== query) {
        setParams(text ? { q: text } : {}, { replace: true });
        setLimit(PAGE);
        setSelected(new Set());
      }
    }, 200);
    return () => clearTimeout(t);
  }, [text, query, setParams]);

  const chosen = rows.filter((r) => selected.has(r.card.id));
  const cardIds = chosen.map((r) => r.card.id);
  const noteIds = [...new Set(chosen.map((r) => r.note.id))];
  const allSelected = rows.length > 0 && chosen.length === rows.length;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };
  const addFilter = (token: string) => setText((t) => `${t.trim()} ${token}`.trim());
  const run = (p: Promise<unknown>, message: string) =>
    p.then(() => {
      toast(message);
      setSelected(new Set());
      setBulk(null);
    }, fail);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return (
    <>
      <PageHeader title="Browse" />
      <div className="mb-3 flex flex-col gap-2 md:flex-row">
        <Input
          type="search"
          aria-label="Search cards"
          placeholder="Search…  e.g.  perro  deck:Spanish  tag:verb  is:due"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="md:flex-1"
        />
        <div className="flex gap-2">
          <Select aria-label="Filter by deck" value="" onChange={(e) => e.target.value && addFilter(`deck:${quote(e.target.value)}`)} className="md:w-44">
            <option value="">Deck…</option>
            {(decks.data ?? []).map((d) => <option key={d.deck.id} value={d.path}>{d.path}</option>)}
          </Select>
          <Select aria-label="Filter by tag" value="" onChange={(e) => e.target.value && addFilter(`tag:${e.target.value}`)} className="md:w-36">
            <option value="">Tag…</option>
            {(tags.data ?? []).map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
          </Select>
          <Select aria-label="Filter by state" value="" onChange={(e) => e.target.value && addFilter(`is:${e.target.value}`)} className="md:w-36">
            <option value="">State…</option>
            {['new', 'learn', 'review', 'due', 'suspended'].map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </div>
      </div>

      <div className="mb-2 flex min-h-10 flex-wrap items-center gap-2 text-sm">
        {chosen.length === 0 ? (
          <span className="text-muted-foreground" data-testid="result-count">{result.data ? plural(total, 'card') : ''}</span>
        ) : (
          <>
            <span className="font-medium">{chosen.length} selected</span>
            <Button size="sm" variant="outline" onClick={() => setBulk('move')}><FolderInput /> Move</Button>
            <Button size="sm" variant="outline" onClick={() => setBulk('tag')}><Tag /> Add tag</Button>
            <Button size="sm" variant="outline" onClick={() => setBulk('untag')}><Tags /> Remove tag</Button>
            <Button size="sm" variant="outline" onClick={() => void run(api.setSuspended(cardIds, true), `Suspended ${plural(cardIds.length, 'card')}.`)}><EyeOff /> Suspend</Button>
            <Button size="sm" variant="outline" onClick={() => void run(api.setSuspended(cardIds, false), `Unsuspended ${plural(cardIds.length, 'card')}.`)}><Eye /> Unsuspend</Button>
            <Button size="sm" variant="outline" className="text-destructive" onClick={() => setBulk('delete')}><Trash2 /> Delete</Button>
            <Button size="sm" variant="ghost" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X /></Button>
          </>
        )}
      </div>

      {result.error && <p className="text-sm text-destructive">{result.error.message}</p>}
      {result.data && rows.length === 0 && (
        <EmptyState title={query ? 'No cards match' : 'No cards yet'}>
          {query ? 'Try fewer words or remove a filter.' : 'Add some cards and they will show up here.'}
        </EmptyState>
      )}

      {rows.length > 0 && (
        <Card className="overflow-hidden">
          {desktop ? (
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.card.id)))} />
                </th>
                <th className="px-2 py-2 font-medium">Note</th>
                <th className="px-2 py-2 font-medium">Card</th>
                <th className="px-2 py-2 font-medium">Deck</th>
                <th className="px-2 py-2 font-medium">State</th>
                <th className="px-2 py-2 font-medium">Due</th>
                <th className="px-2 py-2 font-medium">Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.card.id} r={r} selected={selected.has(r.card.id)} onToggle={() => toggle(r.card.id)} onOpen={() => navigate(`/note/${r.note.id}`)} />
              ))}
            </tbody>
          </table>
          ) : (
          <ul>
            {rows.map((r) => (
              <li key={r.card.id} className={cn('flex items-start gap-3 border-b px-3 py-3 last:border-b-0', selected.has(r.card.id) && 'bg-accent')}>
                <input type="checkbox" className="mt-1 size-5" aria-label={`Select ${r.preview}`} checked={selected.has(r.card.id)} onChange={() => toggle(r.card.id)} />
                <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/note/${r.note.id}`)}>
                  <div className={cn('truncate', r.card.suspended && 'text-muted-foreground line-through')}>{r.preview || '(empty)'}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {r.deckPath} · {r.card.suspended ? 'Suspended' : STATE_NAMES[r.card.state]} · {formatDue(r.card.due, Date.now(), r.card.state)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          )}
        </Card>
      )}
      {rows.length < total && (
        <div className="mt-3 text-center">
          <Button variant="outline" onClick={() => setLimit(limit + PAGE)}>Show more ({total - rows.length} left)</Button>
        </div>
      )}

      <BulkDialog
        bulk={bulk}
        onClose={() => setBulk(null)}
        decks={(decks.data ?? []).map((d) => ({ id: d.deck.id, path: d.path }))}
        tags={[...new Set(chosen.flatMap((r) => r.note.tags))].sort()}
        summary={`${plural(cardIds.length, 'card')} from ${plural(noteIds.length, 'note')}`}
        onMove={(deckId) => run(api.moveCards(cardIds, deckId), `Moved ${plural(cardIds.length, 'card')}.`)}
        onTag={(tag) => run(api.changeTags(noteIds, tag.split(/[\s,]+/).filter(Boolean), []), `Tagged ${plural(noteIds.length, 'note')}.`)}
        onUntag={(tag) => run(api.changeTags(noteIds, [], [tag]), `Removed the tag from ${plural(noteIds.length, 'note')}.`)}
        onDelete={() => run(api.deleteCards(cardIds), `Deleted ${plural(noteIds.length, 'note')}.`)}
      />
    </>
  );
}

function Row({ r, selected, onToggle, onOpen }: { r: CardRow; selected: boolean; onToggle(): void; onOpen(): void }) {
  return (
    <tr className={cn('cursor-pointer border-b last:border-b-0 hover:bg-muted/50', selected && 'bg-accent hover:bg-accent')} onClick={onOpen}>
      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`Select ${r.preview}`} checked={selected} onChange={onToggle} />
      </td>
      <td className={cn('max-w-0 w-[40%] truncate px-2 py-2', r.card.suspended && 'text-muted-foreground line-through')}>{r.preview || '(empty)'}</td>
      <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{r.templateName}</td>
      <td className="max-w-40 truncate px-2 py-2 text-muted-foreground" title={r.deckPath}>{r.deckPath}</td>
      <td className="whitespace-nowrap px-2 py-2">{r.card.suspended ? 'Suspended' : STATE_NAMES[r.card.state]}</td>
      <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{formatDue(r.card.due, Date.now(), r.card.state)}</td>
      <td className="px-2 py-2">
        <div className="flex flex-wrap gap-1">{r.note.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
      </td>
    </tr>
  );
}

function BulkDialog(p: {
  bulk: Bulk | null;
  onClose(): void;
  decks: { id: string; path: string }[];
  tags: string[];
  summary: string;
  onMove(deckId: string): void;
  onTag(tag: string): void;
  onUntag(tag: string): void;
  onDelete(): void;
}) {
  const [value, setValue] = useState('');
  useEffect(() => setValue(''), [p.bulk]);
  const title = { move: 'Move cards', tag: 'Add tag', untag: 'Remove tag', delete: 'Delete notes' }[p.bulk ?? 'move'];
  const pick = p.bulk === 'move' ? (value || p.decks[0]?.id) : p.bulk === 'untag' ? (value || p.tags[0]) : value.trim();
  return (
    <Dialog open={p.bulk !== null} onClose={p.onClose} title={title}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (p.bulk === 'delete') p.onDelete();
          else if (!pick) return;
          else if (p.bulk === 'move') p.onMove(pick);
          else if (p.bulk === 'tag') p.onTag(pick);
          else p.onUntag(pick);
        }}
      >
        {p.bulk === 'move' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-deck">Move {p.summary} to</Label>
            <Select id="bulk-deck" value={pick} onChange={(e) => setValue(e.target.value)}>
              {p.decks.map((d) => <option key={d.id} value={d.id}>{d.path}</option>)}
            </Select>
          </div>
        )}
        {p.bulk === 'tag' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-tag">Tag to add</Label>
            <Input id="bulk-tag" autoFocus value={value} onChange={(e) => setValue(e.target.value)} autoCapitalize="none" />
          </div>
        )}
        {p.bulk === 'untag' &&
          (p.tags.length ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bulk-untag">Tag to remove</Label>
              <Select id="bulk-untag" value={pick} onChange={(e) => setValue(e.target.value)}>
                {p.tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </div>
          ) : (
            <p className="text-sm">The selected notes have no tags.</p>
          ))}
        {p.bulk === 'delete' && (
          <p className="text-sm">This deletes {p.summary}. Deleting a card deletes its whole note, including any sibling cards.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={p.onClose}>Cancel</Button>
          <Button type="submit" variant={p.bulk === 'delete' ? 'destructive' : 'default'} disabled={p.bulk !== 'delete' && !pick}>
            {title}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
