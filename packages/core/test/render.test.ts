import { describe, expect, it } from 'vitest';
import { cardOrdinals, clozeIndexes, renderCard, renderCloze, stripHtml } from '../src';

describe('cloze parsing', () => {
  it('finds distinct indexes in order', () => {
    expect(clozeIndexes('{{c2::b}} and {{c1::a}} and {{c2::again}}')).toEqual([1, 2]);
    expect(clozeIndexes('no clozes here')).toEqual([]);
  });

  it('hides the active deletion on the front and reveals it on the back', () => {
    const text = 'The capital of {{c1::France}} is {{c2::Paris}}.';
    expect(renderCloze(text, 1, 'front')).toBe('The capital of <span class="cloze">[...]</span> is Paris.');
    expect(renderCloze(text, 1, 'back')).toBe('The capital of <span class="cloze">France</span> is Paris.');
    expect(renderCloze(text, 2, 'front')).toBe('The capital of France is <span class="cloze">[...]</span>.');
  });

  it('shows the hint in place of the ellipsis', () => {
    expect(renderCloze('{{c1::Paris::city}}', 1, 'front')).toBe('<span class="cloze">[city]</span>');
    expect(renderCloze('{{c1::Paris::city}}', 1, 'back')).toBe('<span class="cloze">Paris</span>');
    expect(renderCloze('{{c1::Paris::city}}', 2, 'front')).toBe('Paris');
  });

  it('handles nested deletions', () => {
    const text = '{{c1::outer {{c2::inner}} tail}}';
    expect(clozeIndexes(text)).toEqual([1, 2]);
    expect(renderCloze(text, 1, 'front')).toBe('<span class="cloze">[...]</span>');
    expect(renderCloze(text, 2, 'front')).toBe('outer <span class="cloze">[...]</span> tail');
    expect(renderCloze(text, 1, 'back')).toBe('<span class="cloze">outer inner tail</span>');
  });

  it('leaves malformed input as literal text', () => {
    expect(renderCloze('broken {{c1::never closed', 1, 'front')).toBe('broken {{c1::never closed');
    expect(renderCloze('maths: {{x}} and a::b', 1, 'front')).toBe('maths: {{x}} and a::b');
  });

  it('keeps HTML inside the answer, and like Anki reads a later :: as the hint separator', () => {
    expect(renderCloze('{{c1::<b>bold</b>}}', 1, 'back')).toBe('<span class="cloze"><b>bold</b></span>');
    expect(renderCloze('{{c1::std::vector}}', 1, 'back')).toBe('<span class="cloze">std</span>');
    expect(renderCloze('{{c1::std::vector}}', 1, 'front')).toBe('<span class="cloze">[vector]</span>');
  });
});

const basic = {
  kind: 'standard' as const,
  fieldNames: ['Front', 'Back'],
  fieldValues: ['Question', 'Answer'],
  front: '{{Front}}',
  back: '{{FrontSide}}<hr id="answer">{{Back}}',
  ordinal: 0,
};

describe('template rendering', () => {
  it('substitutes fields and FrontSide', () => {
    const r = renderCard(basic);
    expect(r.front).toBe('Question');
    expect(r.back).toBe('Question<hr id="answer">Answer');
    expect(r.warnings).toEqual([]);
  });

  it('applies conditional sections', () => {
    const tpl = { ...basic, front: '{{Front}}{{#Back}} (has back){{/Back}}{{^Back}} (no back){{/Back}}' };
    expect(renderCard(tpl).front).toBe('Question (has back)');
    expect(renderCard({ ...tpl, fieldValues: ['Question', '<br>'] }).front).toBe('Question (no back)');
  });

  it('handles nested conditionals', () => {
    const tpl = { ...basic, front: '{{#Front}}A{{#Back}}B{{/Back}}C{{/Front}}' };
    expect(renderCard(tpl).front).toBe('ABC');
    expect(renderCard({ ...tpl, fieldValues: ['x', ''] }).front).toBe('AC');
    expect(renderCard({ ...tpl, fieldValues: ['', 'y'] }).front).toBe('');
  });

  it('supports text: and hint: filters and special fields', () => {
    const r = renderCard({
      ...basic,
      fieldValues: ['<b>Bold</b> text', 'Clue'],
      front: '{{text:Front}}|{{hint:Back}}|{{Tags}}|{{Deck}}|{{Subdeck}}|{{Card}}|{{Type}}',
      tags: ['a', 'b'],
      deckName: 'Lang::Spanish',
      templateName: 'Card 1',
      noteTypeName: 'Basic',
    });
    expect(r.front).toBe(
      'Bold text|<details class="hint"><summary>Show Back</summary>Clue</details>|a b|Lang::Spanish|Spanish|Card 1|Basic',
    );
  });

  it('renders cloze fields for the card’s index', () => {
    const r = renderCard({
      kind: 'cloze',
      fieldNames: ['Text', 'Extra'],
      fieldValues: ['{{c1::one}} {{c2::two}}', 'note'],
      front: '{{cloze:Text}}',
      back: '{{cloze:Text}}<br>{{Extra}}',
      ordinal: 2,
    });
    expect(r.front).toBe('one <span class="cloze">[...]</span>');
    expect(r.back).toBe('one <span class="cloze">two</span><br>note');
  });

  it('degrades unsupported features visibly', () => {
    const typed = renderCard({ ...basic, front: '{{Front}} {{type:Back}}' });
    expect(typed.front).toContain('type-in-the-answer is not supported');
    expect(typed.warnings.join(' ')).toMatch(/Type-in-the-answer/);

    const script = renderCard({ ...basic, front: '{{Front}}<script>alert(1)</script>' });
    expect(script.front).toBe('Question');
    expect(script.warnings.join(' ')).toMatch(/JavaScript/);

    const unknown = renderCard({ ...basic, front: '{{Nope}}' });
    expect(unknown.front).toContain('unknown field: Nope');

    const filter = renderCard({ ...basic, front: '{{furigana:Front}}' });
    expect(filter.front).toBe('Question');
    expect(filter.warnings.join(' ')).toMatch(/furigana/);
  });

  it('strips HTML to text', () => {
    expect(stripHtml('<div>a</div><div>b &amp; c</div><style>.x{}</style>')).toBe('a b & c');
  });
});

describe('card generation', () => {
  const two = [
    { ordinal: 0, front: '{{Front}}' },
    { ordinal: 1, front: '{{Back}}' },
  ];

  it('generates one card per template with content', () => {
    expect(cardOrdinals('standard', ['Front', 'Back'], ['q', 'a'], two)).toEqual([0, 1]);
    expect(cardOrdinals('standard', ['Front', 'Back'], ['q', ''], two)).toEqual([0]);
    expect(cardOrdinals('standard', ['Front', 'Back'], ['', ''], two)).toEqual([]);
  });

  it('ignores templates whose front is constant text', () => {
    expect(cardOrdinals('standard', ['Front'], ['q'], [{ ordinal: 0, front: 'static' }])).toEqual([]);
  });

  it('respects conditionals', () => {
    const tpl = [{ ordinal: 0, front: '{{#Back}}{{Front}}{{/Back}}' }];
    expect(cardOrdinals('standard', ['Front', 'Back'], ['q', ''], tpl)).toEqual([]);
    expect(cardOrdinals('standard', ['Front', 'Back'], ['q', 'a'], tpl)).toEqual([0]);
  });

  it('generates one card per cloze index', () => {
    const tpl = [{ ordinal: 0, front: '{{cloze:Text}}' }];
    expect(cardOrdinals('cloze', ['Text', 'Extra'], ['{{c1::a}} {{c3::b}}', '{{c7::ignored}}'], tpl)).toEqual([1, 3]);
    expect(cardOrdinals('cloze', ['Text', 'Extra'], ['no cloze', ''], tpl)).toEqual([1]);
  });
});
