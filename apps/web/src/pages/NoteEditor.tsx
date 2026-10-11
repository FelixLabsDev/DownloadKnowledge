import { stripHtml, type Card as CardRow, type Note } from '@dk/core';
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FieldEditor } from '@/components/FieldEditor';
import { Badge, Button, Card, Dialog, EmptyState, Input, Label, PageHeader, Select, useToast } from '@/components/ui';
import { api, useLive } from '@/db/client';
import { formatDue, STATE_NAMES } from '@/lib/utils';

const parseTags = (s: string) => s.split(/[\s,]+/).filter(Boolean);

export function NoteEditorPage() {
  const { noteId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast, fail } = useToast();
  const decks = useLive(() => api.deckTree(), []);
  const types = useLive(() => api.listNoteTypes(), []);
  const tags = useLive(() => api.listTags(), []);

  const [deckId, setDeckId] = useState(params.get('deck') ?? localStorage.getItem('dk-last-deck') ?? '');
  const [typeId, setTypeId] = useState(localStorage.getItem('dk-last-type') ?? '');
  const [fields, setFields] = useState<string[]>([]);
  const [tagText, setTagText] = useState('');
  const [existing, setExisting] = useState<{ note: Note; cards: CardRow[] } | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Bumped to remount the field editors (clearing them) after a note is added. */
  const [round, setRound] = useState(0);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!noteId) {
      setExisting(null);
      setFields([]);
      setTagText('');
      return;
    }
    api.getNote(noteId).then((r) => {
      setExisting(r);
      setTypeId(r.note.noteTypeId);
      setFields(r.note.fields);
      setTagText(r.note.tags.join(' '));
      setDeckId(r.cards[0]?.deckId ?? '');
      setRound((n) => n + 1);
    }, fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  const deckList = decks.data ?? [];
  const typeList = types.data ?? [];
  const type = typeList.find((t) => t.id === typeId) ?? typeList[0];
  const deck = deckList.find((d) => d.deck.id === deckId) ?? deckList[0];
  const values = type ? type.fields.map((_, i) => fields[i] ?? '') : [];
  const first = values[0] ?? '';

  // Warn about a likely duplicate while typing a new note.
  useEffect(() => {
    if (noteId || !deck || !type || !stripHtml(first)) {
      setDuplicate(false);
      return;
    }
    const t = setTimeout(() => {
      api.findDuplicate(deck.deck.id, type.id, first).then((d) => setDuplicate(d !== null), () => setDuplicate(false));
    }, 300);
    return () => clearTimeout(t);
  }, [noteId, deck, type, first]);

  if (decks.data && deckList.length === 0) {
    return (
      <EmptyState title="Create a deck first">
        <p className="mb-4">Cards live in decks, so you need one before adding cards.</p>
        <Link to="/"><Button>Go to decks</Button></Link>
      </EmptyState>
    );
  }
  if (!type || !deck) return null;

  const save = async () => {
    setSaving(true);
    try {
      if (existing) {
        await api.updateNote(existing.note.id, { fields: values, tags: parseTags(tagText) });
        const current = existing.cards[0]?.deckId;
        if (current && current !== deck.deck.id) await api.moveCards(existing.cards.map((c) => c.id), deck.deck.id);
        toast('Saved.');
        navigate(-1);
      } else {
        const r = await api.addNote({ noteTypeId: type.id, deckId: deck.deck.id, fields: values, tags: parseTags(tagText) });
        localStorage.setItem('dk-last-deck', deck.deck.id);
        localStorage.setItem('dk-last-type', type.id);
        toast(`Added ${r.cards.length} ${r.cards.length === 1 ? 'card' : 'cards'} to ${deck.deck.name}.`);
        setFields([]);
        setRound((n) => n + 1);
      }
    } catch (e) {
      fail(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title={existing ? 'Edit note' : 'Add cards'}>
        {existing && (
          <Button variant="outline" onClick={() => setConfirmDelete(true)}>
            <Trash2 /> Delete
          </Button>
        )}
      </PageHeader>
      <form
        ref={form}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note-deck">Deck</Label>
            <Select id="note-deck" value={deck.deck.id} onChange={(e) => setDeckId(e.target.value)}>
              {deckList.map((d) => <option key={d.deck.id} value={d.deck.id}>{d.path}</option>)}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="note-type">Note type</Label>
            <Select id="note-type" value={type.id} disabled={!!existing} onChange={(e) => setTypeId(e.target.value)}>
              {typeList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </div>
        </div>

        {type.fields.map((name, i) => (
          <div key={`${type.id}-${round}-${name}`}>
            <FieldEditor
              name={name}
              value={values[i]!}
              cloze={type.kind === 'cloze'}
              allText={values.join(' ')}
              autoFocus={i === 0 && !existing}
              onChange={(html) => setFields((prev) => type.fields.map((_, j) => (j === i ? html : (prev[j] ?? ''))))}
            />
            {i === 0 && duplicate && (
              <p className="mt-1 text-sm text-rate-hard" role="status">
                A note with this {name.toLowerCase()} already exists in this deck.
              </p>
            )}
          </div>
        ))}

        {type.kind === 'cloze' && (
          <p className="-mt-2 text-xs text-muted-foreground">
            Select the text to hide and press the cloze button, or type {'{{c1::answer}}'}. Each number makes one card.
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note-tags">Tags</Label>
          <Input id="note-tags" list="tag-list" placeholder="Separate tags with spaces" value={tagText} onChange={(e) => setTagText(e.target.value)} autoCapitalize="none" />
          <datalist id="tag-list">
            {(tags.data ?? []).map((t) => <option key={t.tag} value={t.tag} />)}
          </datalist>
        </div>

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto hidden text-xs text-muted-foreground md:inline">Ctrl+Enter saves</span>
          {existing && <Button variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>}
          <Button type="submit" size="lg" disabled={saving} className="flex-1 sm:flex-none">
            {existing ? 'Save' : 'Add'}
          </Button>
        </div>
      </form>

      {existing && (
        <Card className="mt-6 p-4">
          <h2 className="mb-2 text-sm font-medium">Cards from this note</h2>
          <ul className="flex flex-col gap-1.5 text-sm">
            {existing.cards.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <span>{type.kind === 'cloze' ? `Cloze ${c.ordinal}` : (type.templates.find((t) => t.ordinal === c.ordinal)?.name ?? `Card ${c.ordinal + 1}`)}</span>
                <Badge>{STATE_NAMES[c.state]}</Badge>
                {c.suspended && <Badge>Suspended</Badge>}
                <span className="ml-auto text-muted-foreground">{formatDue(c.due, Date.now(), c.state)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this note?">
        <p className="mb-4 text-sm">
          This deletes the note and its {existing?.cards.length} {existing?.cards.length === 1 ? 'card' : 'cards'}.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => existing && api.deleteNotes([existing.note.id]).then(() => navigate(-1), fail)}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </>
  );
}
