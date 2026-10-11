// Renders public/icon.svg to the PNG sizes the web manifest needs.
// Run with: node scripts/make-icons.mjs
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: new URL(`../public/icon-${size}.png`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  await page.close();
}
await browser.close();
