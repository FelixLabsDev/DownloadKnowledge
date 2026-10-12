import { expect, test } from '@playwright/test';
import { addBasic, card, createDeck } from './helpers';

test('create a deck, add cards and review them', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog', 'animal');
  await addBasic(page, 'gato', 'cat', 'animal pet');

  await page.goto('/');
  await expect(page.getByTestId('due-summary')).toHaveText('2 cards to study today.');
  await page.getByRole('link', { name: 'Spanish', exact: true }).click();

  await expect(card(page)).toHaveText('perro');
  await expect(page.getByTestId('counts')).toHaveText('200');
  await page.getByRole('button', { name: 'Show answer' }).click();
  await expect(card(page)).toContainText('dog');
  await page.getByRole('button', { name: /Easy/ }).click();

  // Keyboard: space reveals, 4 rates Easy.
  await expect(card(page)).toHaveText('gato');
  await page.keyboard.press('Space');
  await expect(card(page)).toContainText('cat');
  await page.keyboard.press('4');
  await expect(page.getByTestId('done')).toHaveText('Done for today');

  // Undo brings the last card back as new.
  await page.getByRole('button', { name: 'Undo last review' }).click();
  await expect(card(page)).toHaveText('gato');
  await expect(page.getByTestId('counts')).toHaveText('100');
});

test('cloze notes generate one card per deletion', async ({ page }) => {
  await createDeck(page, 'Facts');
  await page.goto('/add');
  await page.getByLabel('Note type').selectOption({ label: 'Cloze' });
  await page.getByRole('textbox', { name: 'Text' }).fill('{{c1::Paris}} is the capital of {{c2::France}}');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added 2 cards to Facts.')).toBeVisible();

  await page.goto('/');
  await page.getByRole('link', { name: 'Facts', exact: true }).click();
  await expect(card(page)).toHaveText('[...] is the capital of France');
  await page.getByRole('button', { name: 'Show answer' }).click();
  await expect(card(page).locator('.cloze')).toHaveText('Paris');
});

test('the cloze button wraps the selection', async ({ page }) => {
  await createDeck(page, 'Facts');
  await page.goto('/add');
  await page.getByLabel('Note type').selectOption({ label: 'Cloze' });
  const text = page.getByRole('textbox', { name: 'Text' });
  await text.fill('Water boils at 100 degrees');
  await text.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Cloze deletion' }).first().click();
  await expect(text).toHaveText('{{c1::Water boils at 100 degrees}}');
});

test('browse: search, filter and bulk-edit', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await createDeck(page, 'Archive');
  await addBasic(page, 'perro', 'dog', 'animal');
  await addBasic(page, 'gato', 'cat', 'animal');
  await addBasic(page, 'mesa', 'table');

  await page.goto('/browse');
  await expect(page.getByTestId('result-count')).toHaveText('3 cards');
  await page.getByLabel('Search cards').fill('tag:animal');
  await expect(page.getByTestId('result-count')).toHaveText('2 cards');

  await page.getByLabel('Select all').check();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await page.getByLabel(/Move 2 cards/).selectOption({ label: 'Archive' });
  await page.getByRole('button', { name: 'Move cards' }).click();
  await expect(page.getByText('Moved 2 cards.')).toBeVisible();

  await page.getByLabel('Search cards').fill('deck:Archive');
  await expect(page.getByTestId('result-count')).toHaveText('2 cards');
  await page.getByLabel('Select perro').check();
  await page.getByRole('button', { name: 'Suspend', exact: true }).click();
  await page.getByLabel('Search cards').fill('is:suspended');
  await expect(page.getByTestId('result-count')).toHaveText('1 card');

  // Suspended cards are not offered for study.
  await page.goto('/');
  await expect(page.getByTestId('due-summary')).toHaveText('2 cards to study today.');
});

test('editing a note updates its cards', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog');
  await page.goto('/browse');
  await page.getByRole('cell', { name: 'perro', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit note' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Back' })).toHaveText('dog');
  await page.getByRole('textbox', { name: 'Back' }).fill('hound');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByLabel('Search cards').fill('hound');
  await expect(page.getByTestId('result-count')).toHaveText('1 card');
});

test('nested decks: studying the folder includes its sub-decks', async ({ page }) => {
  await createDeck(page, 'Languages');
  await page.getByRole('button', { name: 'Actions for Languages' }).click();
  await page.getByRole('menuitem', { name: 'Add sub-deck' }).click();
  await page.getByLabel('Name').fill('Spanish');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Spanish', exact: true })).toBeVisible();

  await page.goto('/add');
  await page.getByLabel('Deck').selectOption({ label: 'Languages::Spanish' });
  await addBasic(page, 'hola', 'hello');
  await page.goto('/');
  await page.getByRole('link', { name: 'Languages', exact: true }).click();
  await expect(card(page)).toHaveText('hola');
});

test('cram shows cards without changing the schedule', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog');
  await page.goto('/');
  await page.getByRole('button', { name: 'Actions for Spanish' }).click();
  await page.getByRole('menuitem', { name: 'Cram' }).click();
  await expect(page.getByText('Cram: your schedule is not changed')).toBeVisible();
  await page.getByRole('button', { name: 'Show answer' }).click();
  await page.getByRole('button', { name: 'Good' }).click();
  await expect(page.getByTestId('done')).toHaveText('Cram finished');
  await page.goto('/');
  await expect(page.getByTestId('due-summary')).toHaveText('1 card to study today.');
});

test('a template with a script degrades visibly and runs nothing', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog');
  await page.goto('/note-types');
  await page.getByLabel('Front template').fill('{{Front}}<script>document.title = "pwned"</script>{{type:Back}}');
  await expect(page.getByText(/JavaScript, which is not supported/)).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Note type saved.')).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: 'Spanish', exact: true }).click();
  await expect(card(page)).toContainText('type-in-the-answer is not supported');
  await expect(page).not.toHaveTitle('pwned');
});

test('a second tab is told the app is open elsewhere, then takes over', async ({ context, page }) => {
  await createDeck(page, 'Spanish');
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.getByRole('heading', { name: 'Open in another tab' })).toBeVisible();
  await page.close();
  await expect(second.getByRole('link', { name: 'Spanish', exact: true })).toBeVisible();
});

test('reloading repeatedly always reopens the database', async ({ page }) => {
  await createDeck(page, 'Spanish');
  for (let i = 0; i < 6; i++) {
    await addBasic(page, `card ${i}`, 'x');
    // Reload straight after a write, while the previous worker may still hold the files.
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Front' })).toBeVisible();
  }
  await page.goto('/');
  await expect(page.getByTestId('due-summary')).toHaveText('6 cards to study today.');
});

test('stats: tiles and charts reflect reviews', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog');
  await addBasic(page, 'gato', 'cat');
  await page.goto('/');
  await page.getByRole('link', { name: 'Spanish', exact: true }).click();
  await page.getByRole('button', { name: 'Show answer' }).click();
  await page.getByRole('button', { name: /Easy/ }).click();
  await expect(card(page)).toHaveText('gato');

  await page.goto('/stats');
  await expect(page.getByTestId('tile-reviewed-today')).toHaveText('1');
  await expect(page.getByTestId('tile-streak')).toHaveText('1 day');
  await expect(page.getByRole('img', { name: /Bar chart of cards due/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /Heatmap of reviews/ })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Spanish: 1 new, 0 learning, 1 young, 0 mature, 0 suspended' })).toBeVisible();
  // Every chart has a table view of the same numbers.
  await page.getByRole('button', { name: 'Table' }).last().click();
  await expect(page.getByRole('row', { name: /Spanish 1 0 1 0 0 2/ })).toBeVisible();
});

test('field editor: Tab moves between fields, and text can be coloured', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await page.goto('/add');
  const front = page.getByRole('textbox', { name: 'Front' });
  const back = page.getByRole('textbox', { name: 'Back' });
  await front.click();
  await page.keyboard.type('perro');
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  await page.keyboard.type('dog');
  await expect(back).toHaveText('dog');

  await front.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Text color', exact: true }).first().click();
  await page.getByRole('button', { name: 'Text color #dc2626' }).click();
  await expect(front.locator('span')).toHaveCSS('color', 'rgb(220, 38, 38)');
  await page.getByRole('button', { name: 'Highlight color', exact: true }).first().click();
  await page.getByRole('button', { name: 'Highlight color #ca8a0459' }).click();
  await expect(front.locator('span').first()).toHaveCSS('background-color', 'rgba(202, 138, 4, 0.35)');

  await page.getByRole('button', { name: 'Text color', exact: true }).first().click();
  await page.getByRole('button', { name: 'Remove text color' }).click();
  await page.getByRole('button', { name: 'Highlight color', exact: true }).first().click();
  await page.getByRole('button', { name: 'Remove highlight color' }).click();
  await expect(front.locator('span')).toHaveCount(0);
  await expect(front).toHaveText('perro');
});

test('study: the text alignment can be chosen and is remembered', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog');
  await page.goto('/');
  await page.getByRole('link', { name: 'Spanish', exact: true }).click();
  await expect(card(page)).toHaveCSS('text-align', 'center');
  await page.getByRole('button', { name: 'Text alignment' }).click();
  await page.getByRole('menuitem', { name: 'Align left' }).click();
  await expect(card(page)).toHaveCSS('text-align', 'left');
  await page.reload();
  await expect(card(page)).toHaveCSS('text-align', 'left');
  await page.getByRole('button', { name: 'Text alignment' }).click();
  await page.getByRole('menuitem', { name: 'Note type default' }).click();
  await expect(card(page)).toHaveCSS('text-align', 'center');
});

test('field editor: a paste from a web page drops its styling, and a block background can be removed', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await page.goto('/add');
  const front = page.getByRole('textbox', { name: 'Front' });
  await front.click();
  await front.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/html', '<!--StartFragment--><ol class="x" style="color: rgb(69, 79, 91); background-color: rgb(255, 255, 255);"><li data-id="1" style="line-height: 2;"><strong style="color: rgb(22, 28, 36);">DNS</strong>: <span style="font-weight: 700;">first</span></li></ol>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(front).toHaveText('DNS: first');
  expect(await front.innerHTML()).toBe('<ol><li><strong>DNS</strong>: <b>first</b></li></ol>');

  // Styling that is already in a field (an older paste, an import) can be removed with the toolbar.
  await front.evaluate((el) => el.querySelector('ol')!.setAttribute('style', 'background-color: rgb(255, 255, 255);'));
  await front.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Highlight color', exact: true }).first().click();
  await page.getByRole('button', { name: 'Remove highlight color' }).click();
  expect(await front.innerHTML()).toBe('<ol><li><strong>DNS</strong>: <b>first</b></li></ol>');
});

test('study: a skipped card comes back after the others, unchanged', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await addBasic(page, 'perro', 'dog');
  await addBasic(page, 'gato', 'cat');
  await page.goto('/');
  await page.getByRole('link', { name: 'Spanish', exact: true }).click();
  await expect(card(page)).toHaveText('perro');
  await page.getByRole('button', { name: 'Skip card' }).click();
  await expect(card(page)).toHaveText('gato');
  await expect(page.getByTestId('counts')).toHaveText('200');
  await page.getByRole('button', { name: 'Skip card' }).click();
  await expect(card(page)).toHaveText('perro');
});
