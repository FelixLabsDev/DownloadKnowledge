import { expect, type Page } from '@playwright/test';

export async function createDeck(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /New deck|Create your first deck/ }).first().click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
}

export async function addBasic(page: Page, front: string, back: string, tags = '') {
  if (!page.url().endsWith('/add')) await page.goto('/add');
  await page.getByRole('textbox', { name: 'Front' }).fill(front);
  await page.getByRole('textbox', { name: 'Back' }).fill(back);
  await page.getByLabel('Tags').fill(tags);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/Added 1 card/).last()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Front' })).toHaveText('');
}

export const card = (page: Page) => page.frameLocator('[data-testid=card]').locator('body');
