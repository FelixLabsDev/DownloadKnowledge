/**
 * The built-in note types. Ids are fixed so that two devices seeding them
 * independently while offline produce the same rows rather than duplicates.
 */
export const BASIC_ID = '00000000-0000-7000-8000-000000000001';
export const BASIC_REVERSED_ID = '00000000-0000-7000-8000-000000000002';
export const CLOZE_ID = '00000000-0000-7000-8000-000000000003';

const CARD_CSS = `.card {
  font-family: system-ui, sans-serif;
  font-size: 20px;
  text-align: center;
}
.cloze { font-weight: bold; color: #2563eb; }
`;

const ANSWER = '{{FrontSide}}\n\n<hr id="answer">\n\n';

export interface BuiltinNoteType {
  id: string;
  name: string;
  kind: 'standard' | 'cloze';
  fields: string[];
  css: string;
  templates: { id: string; name: string; front: string; back: string; ordinal: number }[];
}

export const builtinNoteTypes: BuiltinNoteType[] = [
  {
    id: BASIC_ID,
    name: 'Basic',
    kind: 'standard',
    fields: ['Front', 'Back'],
    css: CARD_CSS,
    templates: [
      { id: '00000000-0000-7000-8000-000000000101', name: 'Card 1', front: '{{Front}}', back: `${ANSWER}{{Back}}`, ordinal: 0 },
    ],
  },
  {
    id: BASIC_REVERSED_ID,
    name: 'Basic (and reversed card)',
    kind: 'standard',
    fields: ['Front', 'Back'],
    css: CARD_CSS,
    templates: [
      { id: '00000000-0000-7000-8000-000000000201', name: 'Card 1', front: '{{Front}}', back: `${ANSWER}{{Back}}`, ordinal: 0 },
      { id: '00000000-0000-7000-8000-000000000202', name: 'Card 2', front: '{{Back}}', back: `${ANSWER}{{Front}}`, ordinal: 1 },
    ],
  },
  {
    id: CLOZE_ID,
    name: 'Cloze',
    kind: 'cloze',
    fields: ['Text', 'Back Extra'],
    css: CARD_CSS,
    templates: [
      { id: '00000000-0000-7000-8000-000000000301', name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}<br>\n{{Back Extra}}', ordinal: 0 },
    ],
  },
];
