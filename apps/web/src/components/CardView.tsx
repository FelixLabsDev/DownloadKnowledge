import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveMedia } from '@/lib/media';
import { cn, isDark, type CardAlign } from '@/lib/utils';

const esc = (s: string) => s.replace(/<\/(style)/gi, '<\\/$1');

function frameDoc(html: string, css: string, dark: boolean, align?: CardAlign | null): string {
  const fg = dark ? '#e2e8f0' : '#0f172a';
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html { color-scheme: ${dark ? 'dark' : 'light'}; }
body { margin: 0; padding: 20px 16px; background: transparent; color: ${fg};
  font-family: system-ui, sans-serif; font-size: 20px; text-align: center; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
audio { max-width: 100%; }
hr { border: 0; border-top: 1px solid ${dark ? '#334155' : '#cbd5e1'}; margin: 20px 0; }
.dk-unsupported { color: ${dark ? '#fbbf24' : '#b45309'}; font-size: 0.75em; border: 1px dashed currentColor;
  border-radius: 4px; padding: 0 0.3em; }
.hint summary { cursor: pointer; color: ${dark ? '#60a5fa' : '#2563eb'}; }
</style>
<style>${esc(css)}</style>
${dark ? '<style>.card { color: #e2e8f0; background: transparent; }</style>' : ''}
${align ? `<style>.card { text-align: ${align} !important; }</style>` : ''}
</head><body class="card${dark ? ' nightMode night_mode' : ''}">${html}</body></html>`;
}

const INTERACTIVE = 'a, audio, video, summary, details, button, input, select, textarea';

/**
 * Shows rendered card HTML in a sandboxed frame. The sandbox omits
 * `allow-scripts`, so nothing in a template or an imported deck can run code,
 * and the note type's CSS cannot leak into the app.
 */
export function CardView({
  html,
  css,
  align,
  className,
  onTap,
  onSwipe,
  onKey,
}: {
  html: string;
  css: string;
  /** Overrides the note type's text alignment. */
  align?: CardAlign | null;
  className?: string;
  onTap?(): void;
  onSwipe?(dir: 'left' | 'right'): void;
  onKey?(e: KeyboardEvent): void;
}) {
  const [resolved, setResolved] = useState<string | null>(null);
  const handlers = useRef({ onTap, onSwipe, onKey });
  handlers.current = { onTap, onSwipe, onKey };

  useEffect(() => {
    let alive = true;
    void resolveMedia(html).then((h) => alive && setResolved(h));
    return () => {
      alive = false;
    };
  }, [html]);

  const dark = isDark();
  const srcDoc = useMemo(() => (resolved === null ? '' : frameDoc(resolved, css, dark, align)), [resolved, css, dark, align]);

  return (
    <iframe
      title="Card"
      data-testid="card"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      className={cn('block h-full w-full border-0 bg-transparent', className)}
      onLoad={(e) => {
        // Same-origin without scripts: the app can listen inside the frame, the frame cannot run code.
        const doc = e.currentTarget.contentDocument;
        if (!doc) return;
        let start: { x: number; y: number } | null = null;
        let swiped = false;
        doc.addEventListener('touchstart', (t) => {
          const p = t.touches[0];
          start = p ? { x: p.clientX, y: p.clientY } : null;
          swiped = false;
        }, { passive: true });
        doc.addEventListener('touchend', (t) => {
          const p = t.changedTouches[0];
          if (!start || !p) return;
          const dx = p.clientX - start.x;
          const dy = p.clientY - start.y;
          if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) {
            swiped = true;
            handlers.current.onSwipe?.(dx > 0 ? 'right' : 'left');
          }
        }, { passive: true });
        doc.addEventListener('click', (c) => {
          if (swiped) return;
          if ((c.target as Element).closest?.(INTERACTIVE)) return;
          if (doc.getSelection()?.toString()) return;
          handlers.current.onTap?.();
        });
        doc.addEventListener('keydown', (k) => handlers.current.onKey?.(k));
      }}
    />
  );
}
