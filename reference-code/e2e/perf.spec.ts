import { expect, test } from '@playwright/test';

/** Wall-clock budgets depend on the machine: opt-in only. Run with `PERF=1 npx playwright test --project perf`. */
const PERF = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['PERF'] === '1';
test.skip(!PERF, 'Perf budget test is opt-in: run PERF=1 npx playwright test --project perf');

test('200 contracts at 20 ticks/s keep >= 50 fps and a fast worker round trip', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/option-chain?underlying=NSE:NIFTY&feed=mock&mockStrikes=100&mockHz=20');
  await expect(page.getByTestId('spot-row')).toBeVisible({ timeout: 30000 });
  await page.getByTestId('strike-count').selectOption('all');
  await expect
    .poll(() => page.locator('table.oc tbody tr:not(.spot)').count(), { timeout: 15000 })
    .toBeGreaterThanOrEqual(100);

  // Frame deltas and every worker round trip (one per analysis pass, about 1/s) over the same loaded 10 s window.
  const { frames, rtt } = await page.evaluate(
    () =>
      new Promise<{ frames: number[]; rtt: number[] }>((resolve) => {
        type Metrics = { lastRoundTripMs: number | null; resultCount: number };
        const metrics = (window as unknown as { __ocMetrics: Metrics }).__ocMetrics;
        const out: number[] = [];
        const trips: number[] = [];
        let seen = metrics.resultCount; // passes before the window are not counted
        let last = performance.now();
        const end = last + 10000;
        const step = (now: number) => {
          out.push(now - last);
          last = now;
          // A pass that finished since the last frame. Passes are ~1 s apart, so at most one lands per frame.
          if (metrics.resultCount !== seen && metrics.lastRoundTripMs !== null) trips.push(metrics.lastRoundTripMs);
          seen = metrics.resultCount;
          if (now < end) requestAnimationFrame(step);
          else resolve({ frames: out, rtt: trips });
        };
        requestAnimationFrame(step);
      }),
  );

  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const longPct = (frames.filter((f) => f > 20).length / frames.length) * 100;
  console.log(
    `PERF frames=${frames.length} p50=${pct(0.5).toFixed(1)}ms p95=${pct(0.95).toFixed(1)}ms ` +
      `max=${sorted[sorted.length - 1]!.toFixed(1)}ms long(>20ms)=${longPct.toFixed(2)}% roundTripMs=[${rtt.join(', ')}]`,
  );

  expect(frames.length).toBeGreaterThan(100);
  expect(longPct).toBeLessThanOrEqual(5);
  expect(rtt.length).toBeGreaterThanOrEqual(5); // ~10 passes at recalcIntervalMs = 1000
  expect(Math.max(...rtt)).toBeLessThan(50);
});
