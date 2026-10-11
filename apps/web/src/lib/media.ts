import { api } from '@/db/client';

const urls = new Map<string, Promise<string | null>>();

/** A blob URL for a stored media file, or null if this device does not have it. */
export function mediaUrl(filename: string): Promise<string | null> {
  let p = urls.get(filename);
  if (!p) {
    p = api.readMedia(filename).then((blob) => (blob ? URL.createObjectURL(blob) : null));
    urls.set(filename, p);
    // Do not remember a miss: the file may arrive later.
    void p.then((u) => u === null && urls.delete(filename));
  }
  return p;
}

const isExternal = (src: string) => /^(https?:|data:|blob:|\/\/)/i.test(src);

/**
 * Prepares stored field HTML for display: Anki's `[sound:x]` markers become
 * audio players, and media filenames become blob URLs.
 */
export async function resolveMedia(html: string): Promise<string> {
  html = html.replace(/\[sound:([^\]]+)\]/g, (_m, f: string) => `<audio controls src="${f.replace(/"/g, '&quot;')}"></audio>`);
  const names = new Set<string>();
  const attr = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of html.matchAll(attr)) {
    const src = m[1] ?? m[2] ?? m[3] ?? '';
    if (src && !isExternal(src)) names.add(src);
  }
  if (!names.size) return html;
  const resolved = new Map<string, string | null>();
  await Promise.all([...names].map(async (n) => resolved.set(n, await mediaUrl(decodeName(n)))));
  return html.replace(attr, (whole, a?: string, b?: string, c?: string) => {
    const src = a ?? b ?? c ?? '';
    const url = resolved.get(src);
    return url ? `src="${url}" data-dk-src="${src.replace(/"/g, '&quot;')}"` : whole;
  });
}

function decodeName(n: string): string {
  try {
    return decodeURIComponent(n.replace(/&amp;/g, '&'));
  } catch {
    return n;
  }
}

/**
 * Makes untrusted HTML (an imported deck, a paste) safe to put in the page:
 * removes scripts, embedded documents, event-handler attributes and
 * `javascript:` URLs. Card display does not rely on this (it uses a sandboxed
 * frame); the field editor does.
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form').forEach((el) => el.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on') || (/^(href|src|xlink:href|action|formaction)$/.test(name) && /^\s*javascript:/i.test(a.value))) {
        el.removeAttribute(a.name);
      }
    }
  }
  return doc.body.innerHTML;
}
