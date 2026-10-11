import type { DeckNode } from '@dk/core';
import { ChevronDown, ChevronRight, FolderInput, FolderPlus, MoreVertical, Pencil, Plus, Settings2, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, Dialog, EmptyState, Input, Label, Menu, PageHeader, Select, useToast } from '@/components/ui';
import { api, useLive } from '@/db/client';
import { cn } from '@/lib/utils';

type Action =
  | { kind: 'create'; parent: DeckNode | null }
  | { kind: 'rename'; node: DeckNode }
  | { kind: 'move'; node: DeckNode }
  | { kind: 'options'; node: DeckNode }
  | { kind: 'delete'; node: DeckNode };

function Count({ n, className, label }: { n: number; className: string; label: string }) {
  return (
    <span className={cn('w-9 text-right text-sm tabular-nums', n ? className : 'text-muted-foreground/40')} title={label} aria-label={`${n} ${label}`}>
      {n}
    </span>
  );
}

export function DecksPage() {
  const tree = useLive(() => api.deckTree(), []);
  const [action, setAction] = useState<Action | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('dk-collapsed') ?? '[]') as string[]));
  const navigate = useNavigate();
  const nodes = tree.data ?? [];

  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
    localStorage.setItem('dk-collapsed', JSON.stringify([...next]));
  };

  // Hide rows under a collapsed ancestor.
  const visible: DeckNode[] = [];
  let hideBelow: number | null = null;
  for (const n of nodes) {
    if (hideBelow !== null && n.depth > hideBelow) continue;
    hideBelow = collapsed.has(n.deck.id) ? n.depth : null;
    visible.push(n);
  }

  const top = nodes.filter((n) => n.depth === 0);
  const dueToday = top.reduce((sum, n) => sum + n.due.new + n.due.learning + n.due.review, 0);

  return (
    <>
      <PageHeader title="Decks">
        <Button variant="outline" onClick={() => setAction({ kind: 'create', parent: null })}>
          <FolderPlus /> New deck
        </Button>
        <Button className="hidden md:inline-flex" onClick={() => navigate('/add')}>
          <Plus /> Add cards
        </Button>
      </PageHeader>

      {tree.data && nodes.length === 0 && (
        <EmptyState title="No decks yet">
          <p className="mb-4">A deck holds the cards you study together. Decks can be nested to make folders.</p>
          <Button onClick={() => setAction({ kind: 'create', parent: null })}>Create your first deck</Button>
        </EmptyState>
      )}

      {nodes.length > 0 && (
        <>
          <p className="mb-3 text-sm text-muted-foreground" data-testid="due-summary">
            {dueToday === 0 ? 'Nothing due right now.' : `${dueToday} ${dueToday === 1 ? 'card' : 'cards'} to study today.`}
          </p>
          <Card className="overflow-visible">
            <div className="flex items-center gap-1 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
              <span className="flex-1">Deck</span>
              <span className="w-9 text-right">New</span>
              <span className="w-9 text-right">Learn</span>
              <span className="w-9 text-right">Due</span>
              <span className="w-9" />
            </div>
            <ul>
              {visible.map((n) => {
                const due = n.due.new + n.due.learning + n.due.review;
                return (
                  <li key={n.deck.id} className="flex items-center gap-1 border-b px-3 last:border-b-0" data-testid="deck-row">
                    <div className="flex min-w-0 flex-1 items-center" style={{ paddingLeft: n.depth * 20 }}>
                      {n.hasChildren ? (
                        <button
                          className="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                          aria-label={collapsed.has(n.deck.id) ? `Expand ${n.deck.name}` : `Collapse ${n.deck.name}`}
                          onClick={() => toggle(n.deck.id)}
                        >
                          {collapsed.has(n.deck.id) ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                        </button>
                      ) : (
                        <span className="size-7 shrink-0" />
                      )}
                      <Link
                        to={`/study/${n.deck.id}`}
                        className={cn('min-w-0 flex-1 truncate py-3.5 text-[15px] hover:text-primary', due > 0 && 'font-medium')}
                      >
                        {n.deck.name}
                      </Link>
                    </div>
                    <Count n={n.due.new} className="text-state-new" label="new" />
                    <Count n={n.due.learning} className="text-state-learning" label="learning" />
                    <Count n={n.due.review} className="text-state-review" label="to review" />
                    <Menu
                      label={`Actions for ${n.deck.name}`}
                      trigger={<MoreVertical />}
                      items={[
                        { label: 'Add cards', icon: <Plus />, onSelect: () => navigate(`/add?deck=${n.deck.id}`) },
                        { label: 'Cram', icon: <Zap />, onSelect: () => navigate(`/study/${n.deck.id}?cram=1`), disabled: n.total === 0 },
                        { label: 'Add sub-deck', icon: <FolderPlus />, onSelect: () => setAction({ kind: 'create', parent: n }) },
                        { label: 'Rename', icon: <Pencil />, onSelect: () => setAction({ kind: 'rename', node: n }) },
                        { label: 'Move', icon: <FolderInput />, onSelect: () => setAction({ kind: 'move', node: n }) },
                        { label: 'Options', icon: <Settings2 />, onSelect: () => setAction({ kind: 'options', node: n }) },
                        { label: 'Delete', icon: <Trash2 />, destructive: true, onSelect: () => setAction({ kind: 'delete', node: n }) },
                      ]}
                    />
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}

      <Link
        to="/add"
        aria-label="Add cards"
        className="fixed bottom-20 right-4 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg md:hidden"
      >
        <Plus className="size-6" />
      </Link>

      <DeckDialog action={action} nodes={nodes} onClose={() => setAction(null)} />
    </>
  );
}

function DeckDialog({ action, nodes, onClose }: { action: Action | null; nodes: DeckNode[]; onClose(): void }) {
  const { toast, fail } = useToast();
  const title = !action
    ? ''
    : action.kind === 'create'
      ? action.parent
        ? `New deck in ${action.parent.deck.name}`
        : 'New deck'
      : `${{ rename: 'Rename', move: 'Move', options: 'Options for', delete: 'Delete' }[action.kind]} ${action.node.deck.name}`;

  return (
    <Dialog open={action !== null} onClose={onClose} title={title}>
      {action && <DeckForm key={JSON.stringify([action.kind, 'node' in action ? action.node.deck.id : action.parent?.deck.id])} action={action} nodes={nodes} done={(msg) => { if (msg) toast(msg); onClose(); }} fail={fail} />}
    </Dialog>
  );
}

function DeckForm({ action, nodes, done, fail }: { action: Action; nodes: DeckNode[]; done(msg?: string): void; fail(e: unknown): void }) {
  const deck = 'node' in action ? action.node.deck : null;
  const [name, setName] = useState(action.kind === 'rename' ? deck!.name : '');
  const [parent, setParent] = useState(deck?.parentId ?? '');
  const [newPerDay, setNewPerDay] = useState(String(deck?.newPerDay ?? 20));
  const [reviewsPerDay, setReviewsPerDay] = useState(String(deck?.reviewsPerDay ?? 200));
  const [retention, setRetention] = useState(String(Math.round((deck?.desiredRetention ?? 0.9) * 100)));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      if (action.kind === 'create') {
        await api.createDeck({ name, parentId: action.parent?.deck.id ?? null });
        done();
      } else if (action.kind === 'rename') {
        await api.updateDeck(deck!.id, { name });
        done();
      } else if (action.kind === 'move') {
        await api.updateDeck(deck!.id, { parentId: parent || null });
        done();
      } else if (action.kind === 'options') {
        await api.updateDeck(deck!.id, {
          newPerDay: Number(newPerDay),
          reviewsPerDay: Number(reviewsPerDay),
          desiredRetention: Number(retention) / 100,
        });
        done();
      } else {
        const r = await api.deleteDeck(deck!.id);
        done(`Deleted ${r.decks} ${r.decks === 1 ? 'deck' : 'decks'} and ${r.cards} ${r.cards === 1 ? 'card' : 'cards'}.`);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // A deck cannot move into itself or anything beneath it.
  const banned = new Set<string>();
  if (action.kind === 'move') {
    let depth: number | null = null;
    for (const n of nodes) {
      if (n.deck.id === deck!.id) depth = n.depth;
      else if (depth !== null && n.depth <= depth) depth = null;
      if (depth !== null) banned.add(n.deck.id);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {(action.kind === 'create' || action.kind === 'rename') && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deck-name">Name</Label>
          <Input id="deck-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      )}
      {action.kind === 'move' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deck-parent">Move into</Label>
          <Select id="deck-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(top level)</option>
            {nodes.filter((n) => !banned.has(n.deck.id)).map((n) => (
              <option key={n.deck.id} value={n.deck.id}>{n.path}</option>
            ))}
          </Select>
        </div>
      )}
      {action.kind === 'options' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="opt-new">New cards per day</Label>
              <Input id="opt-new" type="number" min={0} max={9999} value={newPerDay} onChange={(e) => setNewPerDay(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="opt-rev">Reviews per day</Label>
              <Input id="opt-rev" type="number" min={0} max={9999} value={reviewsPerDay} onChange={(e) => setReviewsPerDay(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opt-ret">Desired retention (%)</Label>
            <Input id="opt-ret" type="number" min={70} max={99} value={retention} onChange={(e) => setRetention(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              The chance of recalling a card when it comes due. Higher means shorter intervals and more reviews. These limits also cap every deck inside this one.
            </p>
          </div>
        </>
      )}
      {action.kind === 'delete' && (
        <p className="text-sm">
          This deletes the deck{action.node.hasChildren ? ', every deck inside it,' : ''} and {action.node.total} {action.node.total === 1 ? 'card' : 'cards'}.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => done()}>Cancel</Button>
        <Button type="submit" disabled={busy} variant={action.kind === 'delete' ? 'destructive' : 'default'}>
          {{ create: 'Create', rename: 'Rename', move: 'Move', options: 'Save', delete: 'Delete' }[action.kind]}
        </Button>
      </div>
    </form>
  );
}
