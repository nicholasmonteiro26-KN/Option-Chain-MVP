import { expect, test } from '@playwright/test';

// Not part of the normal run: SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
// Writes the light and dark option chain images used in the design docs.
const ON = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['SCREENSHOTS'] === '1';
const DIR = '../docs/design/screenshots';

test.describe('theme screenshots', () => {
  test.skip(!ON, 'set SCREENSHOTS=1 to write the theme screenshots');
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const theme of ['light', 'dark'] as const) {
    test(`login page, ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('ts.theme', t), theme);
      await page.goto('/login');
      await expect(page.getByTestId('theme-toggle')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('body')).toHaveAttribute('color-theme', theme);
      await page.screenshot({ path: `${DIR}/login-${theme}.png` });
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test(`option chain, ${theme}`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('ts.theme', t), theme);
      await page.goto('/option-chain?underlying=NSE:NIFTY&feed=mock');
      await expect(page.locator('table.oc tbody tr:not(.spot)')).toHaveCount(16, { timeout: 15000 });
      await expect(page.getByTestId('spot-row')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('td.k.atm')).toHaveCount(1, { timeout: 15000 });
      await expect(page.locator('body')).toHaveAttribute('color-theme', theme);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `${DIR}/option-chain-${theme}.png` });
    });
  }
});
