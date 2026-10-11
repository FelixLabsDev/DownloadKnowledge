import { expect, test, type Browser, type Page } from '@playwright/test';
import { addBasic, card } from './helpers';

// All tests here share one server and one account, so each uses its own deck names.
const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 8)}`;
const status = (page: Page) => page.getByTestId('sync-status').first();
const browse = (query: string) => `/browse?q=${encodeURIComponent(query)}`;

async function device(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/settings');
  await expect(status(page)).toHaveText(/Not signed in/);
  await page.getByLabel('Password').fill(process.env.DK_E2E_PASSWORD ?? 'dev');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(status(page)).toHaveText('Synced');
  return { context, page };
}

async function syncNow(page: Page) {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(status(page)).toHaveText('Synced');
}

async function newDeck(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /New deck|Create your first deck/ }).first().click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
}

test('a wrong password is refused', async ({ page }) => {
  await page.goto('/settings');
  await page.getByLabel('Password').fill('nope');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Wrong password.')).toBeVisible();
  await expect(status(page)).toHaveText(/Not signed in/);
});

test('a card made on one device appears on the other, and reviews made offline arrive later', async ({ browser }) => {
  const deck = unique('Sync');
  const desktop = await device(browser);
  const phone = await device(browser);

  // Desktop creates a deck and a card.
  await newDeck(desktop.page, deck);
  await desktop.page.goto('/add');
  await desktop.page.getByLabel('Deck').selectOption({ label: deck });
  await addBasic(desktop.page, 'made on desktop', 'yes');
  await syncNow(desktop.page);

  // It appears on the phone.
  await syncNow(phone.page);
  await phone.page.goto('/');
  await expect(phone.page.getByRole('link', { name: deck, exact: true })).toBeVisible();

  // And the other way: the phone adds a card.
  await phone.page.goto('/add');
  await phone.page.getByLabel('Deck').selectOption({ label: deck });
  await addBasic(phone.page, 'made on phone', 'yes');
  await syncNow(phone.page);
  await syncNow(desktop.page);
  await desktop.page.goto(browse(`deck:"${deck}"`));
  await expect(desktop.page.getByTestId('result-count')).toHaveText('2 cards');

  // Airplane mode on the phone: review both cards.
  await phone.context.setOffline(true);
  await phone.page.goto('/');
  await phone.page.getByRole('link', { name: deck, exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await expect(card(phone.page)).toContainText('made on');
    await phone.page.getByRole('button', { name: 'Show answer' }).click();
    await phone.page.getByRole('button', { name: /Easy/ }).click();
  }
  await expect(phone.page.getByTestId('done')).toBeVisible();
  await phone.page.goto('/settings');
  // Two cards rescheduled and two review-log entries.
  await expect(status(phone.page)).toHaveText('Offline · 4 changes waiting');

  // The desktop still sees both as new.
  await syncNow(desktop.page);
  await desktop.page.goto(browse(`deck:"${deck}" is:new`));
  await expect(desktop.page.getByTestId('result-count')).toHaveText('2 cards');

  // Back online: the reviews go up without anyone pressing anything.
  await phone.context.setOffline(false);
  await expect(status(phone.page)).toHaveText('Synced', { timeout: 15_000 });
  await syncNow(desktop.page);
  await desktop.page.goto(browse(`deck:"${deck}" is:review`));
  await expect(desktop.page.getByTestId('result-count')).toHaveText('2 cards');

  await desktop.context.close();
  await phone.context.close();
});

test('an attached image reaches the other device', async ({ browser }) => {
  const deck = unique('Media');
  const a = await device(browser);
  const b = await device(browser);
  await newDeck(a.page, deck);
  await a.page.goto('/add');
  await a.page.getByLabel('Deck').selectOption({ label: deck });
  await a.page.getByRole('textbox', { name: 'Front' }).fill('picture: ');
  // A 1x1 PNG, made unique so another run's upload cannot satisfy this test.
  const png = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    Buffer.from(deck),
  ]);
  await a.page.locator('input[type=file][accept="image/*"]').first().setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(a.page.getByRole('textbox', { name: 'Front' }).locator('img')).toHaveAttribute('src', /^blob:/);
  await a.page.getByRole('textbox', { name: 'Back' }).fill('answer');
  await a.page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(a.page.getByText(/Added 1 card/)).toBeVisible();
  await syncNow(a.page);

  await syncNow(b.page);
  await b.page.goto('/');
  await b.page.getByRole('link', { name: deck, exact: true }).click();
  // The image is fetched from the server the first time a card needs it.
  await expect(card(b.page).locator('img')).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  await a.context.close();
  await b.context.close();
});

test('signing out stops sync on this device', async ({ browser }) => {
  const a = await device(browser);
  await expect(a.page.getByText('(this device)')).toBeVisible();
  await a.page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
  await expect(status(a.page)).toHaveText(/Not signed in/);
  await expect(a.page.getByLabel('Password')).toBeVisible();
  await a.context.close();
});
