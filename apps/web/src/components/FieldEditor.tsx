import { clozeIndexes } from '@dk/core';
import { Ban, Baseline, Bold, Brackets, Highlighter, Image, Italic, List, ListOrdered, Music, Pipette } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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
      // Tab goes from one field straight to the next, not through the toolbar.
      tabIndex={-1}
      // Keep the selection in the field when the toolbar is pressed.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

const TEXT_COLORS = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#9333ea', '#db2777', '#64748b'];
// Translucent, so the text stays readable on both the light and the dark theme.
const HIGHLIGHT_COLORS = TEXT_COLORS.map((c) => `${c}59`);
/** A colour nobody picks: applied and then stripped again, which is how a colour is removed. */
const NO_COLOR = 'rgb(1, 2, 3)';

/** A toolbar button that opens a row of colour swatches, a custom colour and "remove". */
function ColorMenu({
  label,
  colors,
  onOpen,
  onPick,
  children,
}: {
  label: string;
  colors: string[];
  onOpen(): void;
  /** `null` removes the colour. */
  onPick(color: string | null): void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const swatch = 'flex size-7 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground [&_svg]:size-4';
  return (
    <div ref={ref}>
      <ToolButton
        label={label}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
      >
        {children}
      </ToolButton>
      {open && (
        <div
          role="group"
          aria-label={label}
          className="absolute right-1.5 top-full z-30 mt-1 flex max-w-[calc(100%-0.75rem)] flex-wrap gap-1 rounded-lg border bg-card p-1.5 shadow-lg"
          // Keep the selection in the field, except for the colour input, which needs the press.
          onPointerDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}
        >
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              tabIndex={-1}
              title={c}
              aria-label={`${label} ${c}`}
              className={swatch}
              style={{ background: c }}
              onClick={() => {
                onPick(c);
                setOpen(false);
              }}
            />
          ))}
          <label title="Custom color" className={cn(swatch, 'relative cursor-pointer')}>
            <Pipette />
            <input
              type="color"
              tabIndex={-1}
              aria-label={`Custom ${label.toLowerCase()}`}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
              onChange={(e) => onPick(e.target.value)}
            />
          </label>
          <button
            type="button"
            tabIndex={-1}
            title="Remove color"
            aria-label={`Remove ${label.toLowerCase()}`}
            className={swatch}
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
          >
            <Ban />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A rich-text field: bold, italic, text and highlight colour, lists, images (attach or paste), audio and,
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
  const selection = useRef<Range | null>(null);
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

  const saveSelection = () => {
    const sel = getSelection();
    selection.current = sel?.rangeCount && ref.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };

  const paint = (prop: 'color' | 'backgroundColor', color: string | null) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // The custom colour picker takes the focus, and with it the selection: put it back.
    if (selection.current) {
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(selection.current);
    }
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(prop === 'color' ? 'foreColor' : 'hiliteColor', false, color ?? NO_COLOR);
    document.execCommand('styleWithCSS', false, 'false');
    if (!color) {
      for (const node of el.querySelectorAll<HTMLElement>('[style]')) {
        if (node.style[prop] !== NO_COLOR) continue;
        node.style[prop] = '';
        if (!node.getAttribute('style')) node.removeAttribute('style');
        if (node.tagName === 'SPAN' && !node.attributes.length) node.replaceWith(...node.childNodes);
      }
    }
    saveSelection();
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
      <div className="relative flex flex-wrap items-center gap-0.5 border-b px-1.5 py-1">
        <span className="mr-auto px-1.5 text-xs font-medium text-muted-foreground">{name}</span>
        <ToolButton label="Bold" onClick={() => command('bold')}><Bold /></ToolButton>
        <ToolButton label="Italic" onClick={() => command('italic')}><Italic /></ToolButton>
        <ColorMenu label="Text color" colors={TEXT_COLORS} onOpen={saveSelection} onPick={(c) => paint('color', c)}><Baseline /></ColorMenu>
        <ColorMenu label="Highlight color" colors={HIGHLIGHT_COLORS} onOpen={saveSelection} onPick={(c) => paint('backgroundColor', c)}><Highlighter /></ColorMenu>
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
