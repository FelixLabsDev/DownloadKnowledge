import { renderCard, type NoteTypeWithTemplates } from '@dk/core';
import { useMemo, useState } from 'react';
import { CardView } from '@/components/CardView';
import { Button, Card, Label, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import { api, useLive } from '@/db/client';
import { cn } from '@/lib/utils';

export function NoteTypesPage() {
  const types = useLive(() => api.listNoteTypes(), []);
  const [typeId, setTypeId] = useState('');
  const type = types.data?.find((t) => t.id === typeId) ?? types.data?.[0];
  return (
    <>
      <PageHeader title="Note types" />
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        A note type decides which fields a note has and how its cards look. Templates are HTML; put a field in with{' '}
        <code>{'{{FieldName}}'}</code>. JavaScript in templates does not run.
      </p>
      {type && (
        <>
          <div className="mb-4 flex max-w-sm flex-col gap-1.5">
            <Label htmlFor="nt-select">Note type</Label>
            <Select id="nt-select" value={type.id} onChange={(e) => setTypeId(e.target.value)}>
              {types.data!.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <p className="text-xs text-muted-foreground">Fields: {type.fields.join(', ')}</p>
          </div>
          {/* Remount when the stored version changes (a save here, or an edit synced from another device). */}
          <TypeEditor key={[type.id, type.modifiedAt, ...type.templates.map((t) => t.modifiedAt)].join()} type={type} />
        </>
      )}
    </>
  );
}

function TypeEditor({ type }: { type: NoteTypeWithTemplates }) {
  const { toast, fail } = useToast();
  const [tplIndex, setTplIndex] = useState(0);
  const [css, setCss] = useState(type.css);
  const [drafts, setDrafts] = useState(() => type.templates.map((t) => ({ front: t.front, back: t.back })));
  const [side, setSide] = useState<'front' | 'back'>('front');
  const tpl = type.templates[tplIndex]!;
  const draft = drafts[tplIndex]!;

  const pristine = css === type.css && type.templates.every((t, i) => t.front === drafts[i]?.front && t.back === drafts[i]?.back);
  const preview = useMemo(
    () =>
      renderCard({
        kind: type.kind,
        fieldNames: type.fields,
        fieldValues: type.fields.map((f, i) => (type.kind === 'cloze' && i === 0 ? `The (${f}) with a {{c1::hidden part}}.` : `(${f})`)),
        front: draft.front,
        back: draft.back,
        ordinal: type.kind === 'cloze' ? 1 : tpl.ordinal,
        templateName: tpl.name,
        noteTypeName: type.name,
        deckName: 'Deck',
        tags: ['tag'],
      }),
    [type, tpl, draft],
  );

  const setDraft = (patch: Partial<typeof draft>) => setDrafts(drafts.map((d, i) => (i === tplIndex ? { ...d, ...patch } : d)));

  const save = async () => {
    try {
      if (css !== type.css) await api.updateNoteType(type.id, { css });
      for (const [i, t] of type.templates.entries()) {
        const d = drafts[i]!;
        if (d.front !== t.front || d.back !== t.back) await api.updateTemplate(t.id, d);
      }
      toast('Note type saved.');
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        {type.templates.length > 1 && (
          <div className="flex gap-1">
            {type.templates.map((t, i) => (
              <Button key={t.id} size="sm" variant={i === tplIndex ? 'default' : 'outline'} onClick={() => setTplIndex(i)}>{t.name}</Button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-front">Front template</Label>
          <Textarea id="tpl-front" rows={6} spellCheck={false} value={draft.front} onFocus={() => setSide('front')} onChange={(e) => setDraft({ front: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-back">Back template</Label>
          <Textarea id="tpl-back" rows={6} spellCheck={false} value={draft.back} onFocus={() => setSide('back')} onChange={(e) => setDraft({ back: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tpl-css">Styling (CSS, shared by all cards of this note type)</Label>
          <Textarea id="tpl-css" rows={8} spellCheck={false} value={css} onChange={(e) => setCss(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={pristine} onClick={() => { setCss(type.css); setDrafts(type.templates.map((t) => ({ front: t.front, back: t.back }))); }}>
            Discard changes
          </Button>
          <Button disabled={pristine} onClick={() => void save()}>Save</Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1">
          <span className="mr-auto text-sm font-medium">Preview</span>
          {(['front', 'back'] as const).map((s) => (
            <Button key={s} size="sm" variant={side === s ? 'secondary' : 'ghost'} className={cn('capitalize')} onClick={() => setSide(s)}>{s}</Button>
          ))}
        </div>
        <Card className="h-80 overflow-hidden">
          <CardView html={preview[side]} css={css} />
        </Card>
        {preview.warnings.map((w) => (
          <p key={w} className="text-sm text-rate-hard" role="note">{w}</p>
        ))}
      </div>
    </div>
  );
}
