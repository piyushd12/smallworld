// Loads the page in a real browser, runs Demo mode and saves screenshots of
// the animation to test-output/ for a visual check. Skipped when Playwright
// isn't installed (npm i -D playwright && npx playwright install chromium).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { app } from '../server.js';

let chromium = null;
try {
  ({ chromium } = await import('playwright'));
} catch {
  // not installed
}

test('Demo mode plays the search animation to the end', { skip: !chromium && 'playwright is not installed', timeout: 90_000 }, async () => {
  mkdirSync('test-output', { recursive: true });
  const server = app.listen(0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.click('#demo-btn');
    const canvas = page.locator('#watch-stage');
    await canvas.waitFor();
    await page.waitForTimeout(600);
    await canvas.screenshot({ path: 'test-output/start.png' });
    const caption = (text) => page.locator('#watch-caption', { hasText: text }).waitFor({ timeout: 60_000 });
    await caption(/Round 3/);
    await canvas.screenshot({ path: 'test-output/middle.png' });
    await caption(/waves met/);
    await canvas.screenshot({ path: 'test-output/meet.png' });
    await page.waitForSelector('#result:not([hidden])', { timeout: 30_000 });
    await canvas.screenshot({ path: 'test-output/end.png' });
    assert.match(await page.textContent('#headline'), /5 degrees/);
  } finally {
    await browser.close();
    server.close();
  }
});
