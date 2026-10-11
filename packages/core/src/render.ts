import { clozeIndexes, hasCloze, renderCloze } from './cloze';

export interface RenderInput {
  kind: 'standard' | 'cloze';
  /** Field names, in note-type order. */
  fieldNames: string[];
  /** Field values, parallel to `fieldNames`. */
  fieldValues: string[];
  front: string;
  back: string;
  /** Template ordinal (standard) or cloze index (cloze). */
  ordinal: number;
  templateName?: string;
  noteTypeName?: string;
  deckName?: string;
  tags?: string[];
}

export interface RenderOutput {
  front: string;
  back: string;
  /** Template features we do not support; shown to the user rather than hidden. */
  warnings: string[];
}

const SUPPORTED_FILTERS = new Set(['text', 'cloze', 'hint']);

export function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(div|p|li)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEmptyField(value: string | undefined): boolean {
  if (!value) return true;
  return stripHtml(value) === '' && !/<(img|audio|video)\b|\[sound:/i.test(value);
}

const unsupported = (msg: string) => `<span class="dk-unsupported">[${msg}]</span>`;

function renderSide(
  tpl: string,
  input: RenderInput,
  side: 'front' | 'back',
  frontSide: string | null,
  warnings: Set<string>,
): string {
  const fields = new Map(input.fieldNames.map((n, i) => [n, input.fieldValues[i] ?? '']));

  if (/<script\b/i.test(tpl)) {
    warnings.add('This template contains JavaScript, which is not supported and was removed.');
    tpl = tpl.replace(/<script\b[\s\S]*?(<\/script>|$)/gi, '');
  }

  const truthy = (name: string): boolean => {
    const cloze = /^c(\d+)$/.exec(name);
    if (cloze && input.kind === 'cloze' && !fields.has(name)) return Number(cloze[1]) === input.ordinal;
    if (name === 'Tags') return (input.tags?.length ?? 0) > 0;
    return !isEmptyField(fields.get(name));
  };

  // Conditional sections, innermost first.
  const section = /\{\{([#^])\s*([^}]+?)\s*\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/;
  for (let guard = 0; guard < 500; guard++) {
    const m = section.exec(tpl);
    if (!m) break;
    const show = m[1] === '#' ? truthy(m[2]!) : !truthy(m[2]!);
    tpl = tpl.slice(0, m.index) + (show ? m[3] : '') + tpl.slice(m.index + m[0].length);
  }

  return tpl.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_whole, expr: string) => {
    const parts = expr.split(':').map((p) => p.trim());
    const name = parts.pop()!;
    const filters = parts.reverse(); // Anki applies filters right to left.

    if (filters.length === 0) {
      switch (name) {
        case 'FrontSide':
          return frontSide ?? '';
        case 'Tags':
          return (input.tags ?? []).join(' ');
        case 'Type':
          return input.noteTypeName ?? '';
        case 'Deck':
          return input.deckName ?? '';
        case 'Subdeck':
          return (input.deckName ?? '').split('::').pop() ?? '';
        case 'Card':
          return input.templateName ?? '';
        case 'CardFlag':
          return '';
      }
    }

    if (!fields.has(name)) {
      warnings.add(`Unknown field "${name}" in the template.`);
      return unsupported(`unknown field: ${name}`);
    }
    let value = fields.get(name)!;

    for (const filter of filters) {
      if (filter === 'type' || filter.startsWith('type-')) {
        warnings.add('Type-in-the-answer is not supported; the answer is shown normally.');
        value = side === 'front' ? unsupported('type-in-the-answer is not supported') : value;
      } else if (filter === 'cloze') {
        value = renderCloze(value, input.ordinal, side);
      } else if (filter === 'text') {
        value = stripHtml(value);
      } else if (filter === 'hint') {
        value = isEmptyField(value)
          ? ''
          : `<details class="hint"><summary>Show ${name}</summary>${value}</details>`;
      } else if (!SUPPORTED_FILTERS.has(filter)) {
        warnings.add(`Template filter "${filter}" is not supported; the field is shown unchanged.`);
      }
    }
    return value;
  });
}

/** Renders both sides of one card. Pure: no DOM, no sanitising (the web app sandboxes the output). */
export function renderCard(input: RenderInput): RenderOutput {
  const warnings = new Set<string>();
  const front = renderSide(input.front, input, 'front', null, warnings);
  const back = renderSide(input.back, input, 'back', front, warnings);
  return { front, back, warnings: [...warnings] };
}

/**
 * Which cards a note generates. Standard note types: one per template whose
 * front shows something that depends on the fields. Cloze: one per cloze index.
 */
export function cardOrdinals(
  kind: 'standard' | 'cloze',
  fieldNames: string[],
  fieldValues: string[],
  templates: { ordinal: number; front: string }[],
): number[] {
  if (kind === 'cloze') {
    const clozeFields = new Set<string>();
    for (const t of templates) {
      for (const m of t.front.matchAll(/\{\{[^{}]*cloze:\s*([^{}]+?)\s*\}\}/g)) clozeFields.add(m[1]!);
    }
    const found = new Set<number>();
    fieldNames.forEach((n, i) => {
      if (clozeFields.size && !clozeFields.has(n)) return;
      for (const idx of clozeIndexes(fieldValues[i] ?? '')) found.add(idx);
    });
    // Like Anki, a cloze note with no deletions still gets one card so it is not lost.
    return found.size ? [...found].sort((a, b) => a - b) : [1];
  }
  const blank = fieldNames.map(() => '');
  const out: number[] = [];
  for (const t of templates) {
    const base = { kind, fieldNames, front: t.front, back: '', ordinal: t.ordinal } as const;
    const filled = renderCard({ ...base, fieldValues }).front;
    const empty = renderCard({ ...base, fieldValues: blank }).front;
    if (filled !== empty) out.push(t.ordinal);
  }
  return out;
}

export { hasCloze };
