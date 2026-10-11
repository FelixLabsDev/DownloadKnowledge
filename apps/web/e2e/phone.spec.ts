import { expect, test } from '@playwright/test';
import { addBasic, card, createDeck } from './helpers';

test('phone: quick-add, tap to reveal, tap to answer', async ({ page }) => {
  await createDeck(page, 'Spanish');
  await page.getByRole('link', { name: 'Add cards' }).click();
  await addBasic(page, 'perro', 'dog');
  await addBasic(page, 'gato', 'cat');

  await page.getByRole('navigation').getByRole('link', { name: 'Decks' }).click();
  await page.getByRole('link', { name: 'Spanish', exact: true }).click();
  await expect(card(page)).toHaveText('perro');

  // Tap the card to reveal.
  await card(page).tap();
  await expect(card(page)).toContainText('dog');
  await page.getByRole('button', { name: /Easy/ }).tap();

  await expect(card(page)).toHaveText('gato');
  await card(page).tap();
  await expect(card(page)).toContainText('cat');
  await page.getByRole('button', { name: /Good/ }).tap();
  // The Good answer keeps the card in learning; it comes back in this session.
  await expect(card(page)).toHaveText('gato');
});

test('phone: the page does not scroll sideways', async ({ page }) => {
  await createDeck(page, 'A deck with quite a long name to test truncation on a phone');
  await addBasic(page, 'word '.repeat(40), 'answer');
  for (const url of ['/', '/add', '/browse', '/settings']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
});
