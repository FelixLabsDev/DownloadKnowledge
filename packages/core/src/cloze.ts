/** Cloze deletions in Anki's syntax: `{{c1::answer}}` or `{{c1::answer::hint}}`. May nest. */

type Node = string | { index: number; body: Node[]; hint: string | null };

const OPEN = /\{\{c(\d+)::/y;

function parse(text: string): Node[] {
  let pos = 0;

  function nodes(insideCloze: boolean): Node[] {
    const out: Node[] = [];
    let buf = '';
    const flush = () => {
      if (buf) out.push(buf);
      buf = '';
    };
    while (pos < text.length) {
      if (insideCloze && text.startsWith('}}', pos)) break;
      OPEN.lastIndex = pos;
      const m = OPEN.exec(text);
      if (m) {
        const start = pos;
        pos += m[0].length;
        const body = nodes(true);
        if (!text.startsWith('}}', pos)) {
          // Unclosed: treat the opener as literal text.
          pos = start + m[0].length;
          buf += m[0];
          continue;
        }
        pos += 2;
        flush();
        out.push(splitHint(Number(m[1]), body));
        continue;
      }
      buf += text[pos];
      pos++;
    }
    flush();
    return out;
  }

  return nodes(false);
}

/** The hint is whatever follows the last top-level `::` in the cloze body. */
function splitHint(index: number, body: Node[]): Node {
  for (let i = body.length - 1; i >= 0; i--) {
    const n = body[i]!;
    if (typeof n !== 'string') continue;
    const at = n.lastIndexOf('::');
    if (at < 0) continue;
    const trailingText = body.slice(i + 1).every((x) => typeof x === 'string');
    if (!trailingText) break;
    const hint = n.slice(at + 2) + body.slice(i + 1).join('');
    const kept = [...body.slice(0, i), n.slice(0, at)].filter((x) => x !== '');
    return { index, body: kept, hint };
  }
  return { index, body, hint: null };
}

/** Distinct cloze indexes used in the text, ascending. */
export function clozeIndexes(text: string): number[] {
  const found = new Set<number>();
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      if (typeof n === 'string') continue;
      if (n.index > 0) found.add(n.index);
      walk(n.body);
    }
  };
  walk(parse(text));
  return [...found].sort((a, b) => a - b);
}

/**
 * Renders a field for the card that tests cloze `index`. On the front the
 * active deletion shows as `[...]` (or its hint); on the back it is revealed.
 * Other deletions show as plain text on both sides.
 */
export function renderCloze(text: string, index: number, side: 'front' | 'back'): string {
  const walk = (ns: Node[]): string =>
    ns
      .map((n) => {
        if (typeof n === 'string') return n;
        if (n.index !== index) return walk(n.body);
        if (side === 'front') return `<span class="cloze">[${n.hint ?? '...'}]</span>`;
        return `<span class="cloze">${walk(n.body)}</span>`;
      })
      .join('');
  return walk(parse(text));
}

/** Whether the text contains cloze `index` anywhere. */
export function hasCloze(text: string, index: number): boolean {
  return clozeIndexes(text).includes(index);
}
