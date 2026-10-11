import { clozeIndexes } from '@dk/core';
import { Bold, Brackets, Image, Italic, List, ListOrdered, Music } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { api } from '@/db/client';
import { resolveMedia, sanitizeHtml } from '@/lib/media';
import { cn } from '@/lib/utils';
import { useToast } from './ui';

/** Turns editor DOM back into stored HTML: blob URLs become media filenames again. */
function serialise(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-dk-src]').forEach((el) => {
    el.setAttribute('src', el.getAttribute('data-dk-src')!);
    el.removeAttribute('data-dk-src');
  });
  const html = clone.innerHTML;
  return html === '<br>' ? '' : html;
}

function ToolButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Keep the selection in the field when the toolbar is pressed.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

/**
 * A rich-text field: bold, italic, lists, images (attach or paste), audio and,
 * for cloze note types, a cloze button. Value in and out is the field's HTML.
 */
export function FieldEditor({
  name,
  value,
  onChange,
  cloze,
  allText,
  autoFocus,
}: {
  name: string;
  value: string;
  onChange(html: string): void;
  /** Show the cloze button. */
  cloze?: boolean;
  /** All field text of the note, to pick the next cloze number. */
  allText?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const { fail } = useToast();

  // Push external changes into the DOM, but never while they merely echo what the user typed.
  useEffect(() => {
    if (value === current.current) return;
    current.current = value;
    let alive = true;
    let applied = false;
    void resolveMedia(sanitizeHtml(value)).then((html) => {
      if (!alive || !ref.current) return;
      ref.current.innerHTML = html;
      applied = true;
    });
    return () => {
      alive = false;
      // Cancelled before it reached the DOM (React's development mode runs effects twice): let the next run redo it.
      if (!applied && current.current === value) current.current = null;
    };
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const emit = () => {
    if (!ref.current) return;
    const html = serialise(ref.current);
    current.current = html;
    onChange(html);
  };

  const command = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    emit();
  };

  const attach = async (file: File | Blob, name: string) => {
    const filename = await api.addMedia(file, name);
    const url = URL.createObjectURL(file);
    const safe = filename.replace(/"/g, '');
    const html = file.type.startsWith('audio/')
      ? `<audio controls src="${url}" data-dk-src="${safe}"></audio>&nbsp;`
      : `<img src="${url}" data-dk-src="${safe}">`;
    command('insertHTML', html);
  };

  const addCloze = () => {
    const sel = getSelection();
    if (!sel || !ref.current?.contains(sel.anchorNode)) ref.current?.focus();
    const next = Math.max(0, ...clozeIndexes(allText ?? '')) + 1;
    const text = getSelection()?.toString() ?? '';
    command('insertText', `{{c${next}::${text}}}`);
    if (!text) {
      // Put the caret between the "::" and the closing braces.
      const s = getSelection();
      s?.modify('move', 'backward', 'character');
      s?.modify('move', 'backward', 'character');
    }
  };

  return (
    <div className="rounded-lg border border-input bg-card focus-within:ring-2 focus-within:ring-ring">
      <div className="flex items-center gap-0.5 border-b px-1.5 py-1">
        <span className="mr-auto px-1.5 text-xs font-medium text-muted-foreground">{name}</span>
        <ToolButton label="Bold" onClick={() => command('bold')}><Bold /></ToolButton>
        <ToolButton label="Italic" onClick={() => command('italic')}><Italic /></ToolButton>
        <ToolButton label="Bulleted list" onClick={() => command('insertUnorderedList')}><List /></ToolButton>
        <ToolButton label="Numbered list" onClick={() => command('insertOrderedList')}><ListOrdered /></ToolButton>
        <ToolButton label="Attach image" onClick={() => imageInput.current?.click()}><Image /></ToolButton>
        <ToolButton label="Attach audio" onClick={() => audioInput.current?.click()}><Music /></ToolButton>
        {cloze && <ToolButton label="Cloze deletion" onClick={addCloze}><Brackets /></ToolButton>}
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-label={name}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={name}
        className={cn('field-editor px-3 py-2.5 text-base')}
        onInput={emit}
        onPaste={(e) => {
          const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
          if (file) {
            e.preventDefault();
            attach(file, file.name || 'pasted.png').catch(fail);
            return;
          }
          const html = e.clipboardData.getData('text/html');
          if (html) {
            e.preventDefault();
            command('insertHTML', sanitizeHtml(html));
          }
        }}
      />
      {(['image', 'audio'] as const).map((kind) => (
        <input
          key={kind}
          ref={kind === 'image' ? imageInput : audioInput}
          type="file"
          accept={`${kind}/*`}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) attach(file, file.name).catch(fail);
          }}
        />
      ))}
    </div>
  );
}
