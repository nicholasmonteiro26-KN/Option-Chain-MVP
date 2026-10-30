import { expect, Page, test } from '@playwright/test';

const URL = '/option-chain?underlying=NSE:NIFTY&feed=mock';
const T = { timeout: 15000 };

const rows = (page: Page) => page.locator('table.oc tbody tr:not(.spot)');

async function open(page: Page, url = URL): Promise<void> {
  await page.goto(url);
  await expect(rows(page)).toHaveCount(16, T);
  await expect(page.getByTestId('spot-row')).toBeVisible(T);
}

declare global {
  interface Window {
    __mockFeed: { drop(): void; setSpot(v: number, sym?: string): void };
    __ocMetrics: { lastRoundTripMs: number | null };
  }
}

test.beforeEach(async ({ page }) => {
  // Each test starts from default prefs (cleared once per tab, so reloads keep their prefs).
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      localStorage.clear();
      sessionStorage.setItem('e2e-init', '1');
    }
  });
});

test('loads 16 rows and a spot line', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('spot-row')).toHaveCount(1);
  await expect(page.getByTestId('underlying-ltp')).toBeVisible();
});

test('Greeks preset shows IV in the header', async ({ page }) => {
  await open(page);
  await page.getByTestId('preset-greeks').click();
  await expect(page.locator('table.oc thead')).toContainText('IV', T);
});

test('Custom shows the editor, Price hides it', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('custom-editor')).toHaveCount(0);
  await page.getByTestId('preset-custom').click();
  await expect(page.getByTestId('custom-editor')).toBeVisible(T);
  await page.getByTestId('preset-price').click();
  await expect(page.getByTestId('custom-editor')).toHaveCount(0);
});

test('an unticked Custom column survives a reload', async ({ page }) => {
  await open(page);
  const oiHeader = page.locator('table.oc thead th', { hasText: /^OI$/ });
  await page.getByTestId('preset-custom').click();
  await expect(oiHeader.first()).toBeVisible(T);
  await page.getByTestId('custom-editor').locator('input[type="checkbox"][value="oi"]').uncheck();
  await expect(oiHeader).toHaveCount(0);
  await page.reload();
  await expect(rows(page)).toHaveCount(16, T);
  await expect(page.getByTestId('preset-custom')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('table.oc thead th', { hasText: /^OI Chg$/ }).first()).toBeVisible();
  await expect(oiHeader).toHaveCount(0);
  await page.getByTestId('preset-custom').click();
  await expect(page.getByTestId('custom-editor').locator('input[value="oi"]')).not.toBeChecked();
});

test('switching expiry puts expiry= in the URL', async ({ page }) => {
  await open(page);
  await page.getByTestId('expiry-2026-11-10').click();
  await expect(page).toHaveURL(/expiry=2026-11-10/, T);
  await expect(rows(page)).toHaveCount(16, T);
});

test('searching SBI + Enter selects SBIN', async ({ page }) => {
  await open(page);
  const search = page.getByTestId('underlying-search');
  await search.fill('SBI');
  await expect(page.getByRole('option').first()).toBeVisible(T);
  await search.press('Enter');
  await expect(page.locator('.und-bar')).toContainText('SBIN', T);
  await expect(page).toHaveURL(/underlying=NSE:SBIN/, T);
});

test('a dropped feed shows the reconnect banner, then clears', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('status-banner')).toHaveCount(0);
  await page.evaluate(() => window.__mockFeed.drop());
  await expect(page.getByTestId('status-banner')).toContainText('Reconnecting', T);
  await expect(page.getByTestId('status-banner')).toHaveCount(0, T);
});

test('the SENSEX quick button switches the chain; the bar shows LTP and change', async ({ page }) => {
  await open(page);
  await page.locator('.qbtn', { hasText: 'SENSEX' }).click();
  await expect(page.locator('.und-bar')).toContainText('SENSEX', T);
  await expect(page).toHaveURL(/underlying=BSE:SENSEX/, T);
  await expect(rows(page)).toHaveCount(16, T);
  await expect(page.getByTestId('underlying-ltp')).toHaveText(/^[\d,]+\.\d\d$/, T);
  await expect(page.locator('.und-bar')).toContainText(/[+-][\d,]+\.\d\d \([+-]\d+\.\d\d%\)/, T);
});

test('SENSEX 28-Jan-2027 expiry shows Lot 25', async ({ page }) => {
  await open(page, '/option-chain?underlying=BSE:SENSEX&feed=mock');
  await expect(page.locator('.und-bar')).toContainText('Lot 20', T);
  await page.getByTestId('expiry-2027-01-28').click();
  await expect(page.locator('.und-bar')).toContainText('Lot 25', T);
  await expect(page).toHaveURL(/expiry=2027-01-28/, T);
});

test('hovering a CE cell reveals B; clicking it shows the mock order line', async ({ page }) => {
  await open(page);
  const cell = page.locator('table.oc tbody tr:not(.spot) td:has(.acts.ce)').first();
  await cell.hover();
  const buy = cell.locator('.acts.ce .b');
  await expect(buy).toBeVisible(T);
  await buy.click();
  await expect(page.getByTestId('status-line')).toContainText(/Opens the order window: BUY /, T);
});

test('the spot line sticks to the edges and the row before it stays 22850', async ({ page }) => {
  await open(page);
  await page.getByTestId('strike-count').selectOption('all');
  const wrap = page.getByTestId('chain-table');
  await expect.poll(() => rows(page).count(), T).toBeGreaterThan(30);
  await page.evaluate(() => window.__mockFeed.setSpot(22873));

  const pill = page.getByTestId('spot-row').locator('.pill');
  const box = async () => (await wrap.boundingBox())!;
  const pillBox = async () => (await pill.boundingBox())!;
  // The th cells are sticky, not the thead element itself.
  const headBox = async () => (await page.locator('table.oc thead tr:last-child th').first().boundingBox())!;

  // Scrolled to the top: the spot line is below the visible rows, so it sticks to the bottom edge.
  await wrap.evaluate((el) => { el.scrollTop = 0; });
  await expect(pill).toBeVisible(T);
  await expect
    .poll(async () => {
      const b = await box(), p = await pillBox();
      return b.y + b.height - (p.y + p.height);
    }, T)
    .toBeLessThanOrEqual(60);
  {
    const b = await box(), p = await pillBox();
    expect(p.y + p.height).toBeLessThanOrEqual(b.y + b.height + 1);
    expect(p.y).toBeGreaterThanOrEqual(b.y);
  }

  // Scrolled to the bottom: the spot line is above the visible rows, so it sticks just under the header.
  await wrap.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect
    .poll(async () => {
      const h = await headBox(), p = await pillBox();
      return p.y - (h.y + h.height);
    }, T)
    .toBeLessThanOrEqual(60);
  {
    const b = await box(), h = await headBox(), p = await pillBox();
    expect(p.y).toBeGreaterThanOrEqual(h.y + h.height - 1);
    expect(p.y + p.height).toBeLessThanOrEqual(b.y + b.height);
  }

  // The strike before the spot row stays 22850 while prices tick (22873 +/- 3), sampled for 10 s.
  const strikeBeforeSpot = () =>
    page.evaluate(() => {
      const spot = document.querySelector('[data-testid="spot-row"]');
      return spot?.previousElementSibling?.querySelector('td.k')?.textContent?.trim() ?? null;
    });
  const seen: (string | null)[] = [];
  for (let i = 0; i < 20; i++) {
    seen.push(await strikeBeforeSpot());
    await page.waitForTimeout(500);
  }
  expect(seen).toEqual(new Array(20).fill('22850'));
});

test('live data without a session goes to the login page, keeping the URL as returnUrl', async ({ page }) => {
  await page.goto('/option-chain?underlying=NSE:NIFTY');
  await expect(page).toHaveURL(/\/login\?returnUrl=%2Foption-chain%3Funderlying%3DNSE:NIFTY/, T);
  await expect(page.getByLabel('Client ID')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByText('Your password and OTP are never entered here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log in with TradeSmart' })).toBeEnabled();
});

test('a direct visit to /auth/callback says no login is in progress, drops the code from the URL, and links back to /login', async ({ page }) => {
  await page.goto('/auth/callback?code=FAKE_CODE_FOR_TEST');
  await expect(page.getByRole('heading', { name: 'No login in progress' })).toBeVisible(T);
  expect(page.url()).not.toContain('code=');
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page).toHaveURL(/\/login$/, T);
});

test.describe('theme', () => {
  const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  test('toggle switches to dark, survives a reload, and switches back', async ({ page }) => {
    await open(page);
    const toggle = page.getByTestId('theme-toggle');
    await expect(page.locator('body')).toHaveAttribute('color-theme', 'light');
    expect(await bg(page)).toBe('rgb(255, 255, 255)');
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');

    await toggle.click();
    await expect(page.locator('body')).toHaveAttribute('color-theme', 'dark');
    expect(await bg(page)).toBe('rgb(10, 18, 34)');
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');

    await page.reload();
    await expect(rows(page)).toHaveCount(16, T);
    await expect(page.locator('body')).toHaveAttribute('color-theme', 'dark');
    expect(await bg(page)).toBe('rgb(10, 18, 34)');

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('body')).toHaveAttribute('color-theme', 'light');
    expect(await bg(page)).toBe('rgb(255, 255, 255)');
  });

  test('the toggle works on the login page', async ({ page }) => {
    await page.goto('/login');
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toBeVisible(T);
    expect(await bg(page)).toBe('rgb(255, 255, 255)');
    await toggle.click();
    await expect(page.locator('body')).toHaveAttribute('color-theme', 'dark');
    expect(await bg(page)).toBe('rgb(10, 18, 34)');
    await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');
  });

  test('follows the system setting until a choice is made', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page);
    await expect(page.locator('body')).toHaveAttribute('color-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('body')).toHaveAttribute('color-theme', 'light');
  });
});
