import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { addBasic, card, createDeck } from './helpers';

/**
 * The plan's riskiest assumption: SQLite on OPFS (SAH-pool VFS) in a worker
 * keeps its data across a full browser restart, with no cross-origin
 * isolation headers, and the installed app opens with no network.
 */
test('data survives a browser restart and the app works offline', async ({ baseURL }) => {
  const profile = mkdtempSync(path.join(tmpdir(), 'dk-profile-'));
  try {
    let context = await chromium.launchPersistentContext(profile, { baseURL });
    let page = context.pages()[0] ?? (await context.newPage());

    await createDeck(page, 'Persistent');
    await addBasic(page, 'still here?', 'yes');
    await page.goto('/settings');
    await expect(page.getByTestId('info-engine')).toContainText('opfs-sahpool');
    await page.getByRole('button', { name: 'Write a test row' }).click();
    await expect(page.getByTestId('probe-rows').getByRole('listitem')).toHaveCount(1);
    await expect(page.getByTestId('probe-rows')).toContainText('written');
    // Let the service worker finish caching the app shell.
    await page.evaluate(async () => void (await navigator.serviceWorker.ready));
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).length)).toBeGreaterThan(0);
    await context.close();

    // A new browser process on the same profile, with the network off.
    context = await chromium.launchPersistentContext(profile, { baseURL });
    await context.setOffline(true);
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Persistent', exact: true })).toBeVisible();
    await expect(page.getByTestId('due-summary')).toHaveText('1 card to study today.');

    // Review offline.
    await page.getByRole('link', { name: 'Persistent', exact: true }).click();
    await expect(card(page)).toHaveText('still here?');
    await page.getByRole('button', { name: 'Show answer' }).click();
    await page.getByRole('button', { name: /Easy/ }).click();
    await expect(page.getByTestId('done')).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByTestId('probe-rows')).toContainText('written');
    await context.close();

    // And the offline review is still there after another restart.
    context = await chromium.launchPersistentContext(profile, { baseURL });
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('/');
    await expect(page.getByTestId('due-summary')).toHaveText('Nothing due right now.');
    await context.close();
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
