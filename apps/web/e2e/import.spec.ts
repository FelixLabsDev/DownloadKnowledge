import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { legacyApkg, modernApkg } from './apkgFixture';
import { addBasic, card, createDeck } from './helpers';

const browse = (q: string) => `/browse?q=${encodeURIComponent(q)}`;

async function importPackage(page: Page, name: string, buffer: Buffer, keep = true) {
  await page.goto('/import');
  await page.getByLabel('Anki package').setInputFiles({ name: `${name}.apkg`, mimeType: 'application/octet-stream', buffer });
  if (!keep) await page.getByLabel(/Keep my scheduling/).uncheck();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByTestId('anki-summary')).toBeVisible({ timeout: 30_000 });
  return page.getByTestId('anki-summary');
}

for (const [label, build] of [
  ['older format (collection.anki2, JSON media map)', legacyApkg],
  ['newer format (zstd collection.anki21b, protobuf media map)', modernApkg],
] as const) {
  test(`Anki import, ${label}`, async ({ page }) => {
    const summary = await importPackage(page, 'Zoo', build('Zoo'));
    await expect(summary).toContainText('3 notes and 4 cards added to Zoo::Animals, Zoo::Other.');
    await expect(summary).toContainText('New note types: Typed.');
    await expect(summary).toContainText('1 card kept their FSRS scheduling exactly.');
    await expect(summary).toContainText('1 card used Anki\'s older SM-2 scheduling');
    await expect(summary).toContainText('1 card are suspended');
    await expect(summary).toContainText('3 past reviews imported');
    await expect(summary).toContainText('1 media file imported.');
    // Unsupported template features are called out, not hidden.
    await expect(summary).toContainText('Note type "Typed" uses JavaScript, which does not run here.');
    await expect(summary).toContainText('Note type "Typed" uses type-in-the-answer');

    // Deck hierarchy from "::", without Anki's empty Default deck.
    await page.goto('/');
    await expect(page.getByTestId('deck-row')).toHaveCount(3);
    await expect(page.getByRole('link', { name: 'Animals', exact: true })).toBeVisible();
    await expect(page.getByTestId('due-summary')).toHaveText('2 cards to study today.'); // The two cloze cards.

    // Scheduling came across: one review card not yet due, one suspended, two new.
    await page.goto(browse('is:review'));
    await expect(page.getByTestId('result-count')).toHaveText('2 cards');
    await page.goto(browse('is:suspended'));
    await expect(page.getByTestId('result-count')).toHaveText('1 card');
    await page.goto(browse('tag:animal'));
    await expect(page.getByRole('cell', { name: 'in 5d' })).toBeVisible();

    // The image shows, both in a cram of the deck and in the editor.
    await page.goto('/');
    await page.getByRole('button', { name: 'Actions for Animals' }).click();
    await page.getByRole('menuitem', { name: 'Cram' }).click();
    await expect(card(page)).toContainText('the dog');
    await expect(card(page).locator('img')).toHaveAttribute('src', /^blob:/);

    // Cloze cards are numbered as in Anki.
    await page.goto('/');
    await page.getByRole('link', { name: 'Other', exact: true }).click();
    await expect(card(page)).toHaveText('[...] is the capital of Peru');
    await expect(page).not.toHaveTitle('pwned');

    // History feeds the stats.
    await page.goto('/stats');
    await expect(page.getByText(/3 reviews on 3 days/)).toBeVisible();

    // Importing again changes nothing.
    const again = await importPackage(page, 'Zoo', build('Zoo'));
    await expect(again).toContainText('0 notes and 0 cards added.');
    await expect(again).toContainText('4 cards were already here');
    await page.goto(browse(''));
    await expect(page.getByTestId('result-count')).toHaveText('4 cards');
  });
}

test('Anki import without scheduling starts every card as new', async ({ page }) => {
  const summary = await importPackage(page, 'Fresh', legacyApkg('Fresh'), false);
  await expect(summary).toContainText('3 notes and 4 cards added');
  await expect(summary).not.toContainText('past review');
  await page.goto(browse('is:new'));
  await expect(page.getByTestId('result-count')).toHaveText('4 cards');
});

test('a file that is not an Anki package is refused with a reason', async ({ page }) => {
  await page.goto('/import');
  await page.getByLabel('Anki package').setInputFiles({ name: 'notes.apkg', mimeType: 'application/octet-stream', buffer: Buffer.from('hello') });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/not a zip archive/)).toBeVisible();
});

test('import a pasted list with column mapping', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog');
  await page.goto('/import');
  await page.getByLabel('List text').fill('word\tmeaning\tlabels\nperro\thound\tanimal\ngato\tcat\tanimal pet\n\tno front\t\nmesa\ttable\t');
  // Guessed by position: Front, Back, then nothing.
  await expect(page.getByLabel('Column 1')).toHaveValue('f0');
  await expect(page.getByLabel('Column 2')).toHaveValue('f1');
  await page.getByLabel('Column 3').selectOption('tags');
  await page.getByLabel(/first line is a header/).check();
  await page.getByRole('button', { name: 'Import 4 notes' }).click();
  const summary = page.getByTestId('list-summary');
  await expect(summary).toContainText('Added 2 notes (2 cards). Skipped 1 duplicate.');
  await expect(summary).toContainText('Line 4: The first field (Front) is empty.');
  await page.goto(browse('tag:pet'));
  await expect(page.getByTestId('result-count')).toHaveText('1 card');
});

test('export: the backup holds everything and the CSV imports back', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog, hound', 'animal');
  await page.goto('/import');

  const [json] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Full backup/ }).click()]);
  expect(json.suggestedFilename()).toMatch(/^downloadknowledge-backup-\d{4}-\d\d-\d\d\.json$/);
  const backup = JSON.parse(readFileSync(await json.path(), 'utf8')) as { format: string; tables: Record<string, { name?: string; fields?: string[] }[]> };
  expect(backup.format).toBe('downloadknowledge-backup');
  expect(backup.tables.decks!.map((d) => d.name)).toEqual(['Spanish']);
  expect(backup.tables.notes![0]!.fields).toEqual(['perro', 'dog, hound']);
  expect(backup.tables.cards).toHaveLength(1);

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Notes \(CSV\)/ }).click()]);
  const text = readFileSync(await csv.path(), 'utf8');
  expect(text).toBe('deck,note_type,tags,field_1,field_2\r\nSpanish,Basic,animal,perro,"dog, hound"\r\n');
});
