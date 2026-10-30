import { describe, expect, it } from 'vitest';
import { black76 } from './black76';
import { isLowConfidence, selectPrice, solveIv } from './iv';
import type { LegQuote, OptType } from './types';

const F = 25000, r = 0.06, T = 0.01432648401826484;
const solve = (t: OptType, p: number, K: number, f = F, tt = T, warm?: number) => solveIv(t, p, f, K, tt, r, warm);

function expectIv(t: OptType, p: number, K: number, expected: number, f = F) {
  const res = solve(t, p, K, f);
  expect(res.status).toBe('OK');
  expect(Math.abs((res.iv as number) - expected)).toBeLessThan(1e-7);
}

describe('solveIv V8', () => {
  it('CE 160 @ 25000', () => expectIv('CE', 160, 25000, 0.1341461084));
  it('PE 140 @ 25000', () => expectIv('PE', 140, 25000, 0.1173775493));
  it('CE 20 @ 25500', () => expectIv('CE', 20, 25500, 0.1319621404));
  it('PE 3 @ 24000', () => expectIv('PE', 3, 24000, 0.1618032012));
  it('CE 1005 @ 24000 (ITM)', () => expectIv('CE', 1005, 24000, 0.179745566));
  it('CE 900 @ 24000 is below intrinsic', () => {
    const res = solve('CE', 900, 24000);
    expect(res.iv).toBeNull();
    expect(res.status).toBe('BELOW_INTRINSIC');
    expect(res.iterations).toBe(0);
  });
  it('parity forward gives equal CE and PE IV', () => {
    const f = 25020.01719917187;
    expectIv('CE', 160, 25000, 0.1255334321, f);
    expectIv('PE', 140, 25000, 0.1255334321, f);
  });
});

describe('solveIv V12 and bounds', () => {
  it('CE 0.05 @ 26500', () => expectIv('CE', 0.05, 26500, 0.1459646448));
  it('CE 0.10 @ 26500', () => expectIv('CE', 0.1, 26500, 0.1538365464));
  it('PE 0.05 @ 23000', () => expectIv('PE', 0.05, 23000, 0.2046296875));
  it('ATM CE 0.05 is BELOW_MIN_VOL, never a clamped sigma', () => {
    const res = solve('CE', 0.05, 25000);
    expect(res.iv).toBeNull();
    expect(res.status).toBe('BELOW_MIN_VOL');
  });
  it('one minute to expiry', () => expect(Math.abs(
    (solve('CE', 2.063543389, 25000, F, 1 / 525600).iv as number) - 0.15)).toBeLessThan(1e-7));
  it('price at or above upper bound is ABOVE_MAX', () => {
    expect(solve('CE', 25001, 25000).status).toBe('ABOVE_MAX');
    expect(solve('PE', 25000, 25000).status).toBe('ABOVE_MAX');
  });
  it('price above price(5.0) is ABOVE_MAX_VOL', () => {
    const p = black76('CE', F, 25000, T, 0, 5).price * Math.exp(r * T);
    const res = solve('CE', p + 50, 25000);
    expect(res.iv).toBeNull();
    expect(res.status).toBe('ABOVE_MAX_VOL');
  });
  it('non-positive price is NO_PRICE', () => expect(solve('CE', 0, 25000).status).toBe('NO_PRICE'));
});

describe('solveIv round trip (V7)', () => {
  const cases: [OptType, number, number][] = [['CE', 25000, 0.12], ['PE', 25000, 0.12], ['CE', 25500, 0.13], ['PE', 24500, 0.14]];
  for (const [t, K, sigma] of cases) {
    it(`${t} ${K} cold and warm`, () => {
      const price = black76(t, F, K, T, r, sigma).price;
      const cold = solve(t, price, K);
      expect(Math.abs((cold.iv as number) - sigma)).toBeLessThan(1e-7);
      const warm = solve(t, price, K, F, T, sigma);
      expect(Math.abs((warm.iv as number) - sigma)).toBeLessThan(1e-7);
      expect(warm.iterations).toBeLessThanOrEqual(2);
    });
  }
});

const quote = (o: Partial<LegQuote>): LegQuote => ({
  token: 't', type: 'CE', strike: 25000, lotSize: 75, tickSize: 0.05, ltp: 100, bid: 99.9, ask: 100.1,
  bidQty: 75, askQty: 75, volume: 0, oi: 0, prevOi: 0, prevClose: null, open: null, high: null, low: null,
  lastTickMs: 0, ...o,
});

describe('selectPrice', () => {
  it('uses MID for a tight valid quote', () => {
    const s = selectPrice(quote({}));
    expect(s?.source).toBe('MID');
    expect(Math.abs((s?.price ?? 0) - 100)).toBeLessThan(1e-9);
  });
  it('wide spread falls back to LTP with volume, else null', () => {
    expect(selectPrice(quote({ bid: 90, ask: 110, volume: 10 }))).toEqual({ price: 100, source: 'LTP' });
    expect(selectPrice(quote({ bid: 90, ask: 110, volume: 0 }))).toBeNull();
  });
  it('empty book and no volume is null', () => {
    expect(selectPrice(quote({ bid: 0, ask: 0, volume: 0 }))).toBeNull();
  });
  it('zero quantity invalidates mid', () => {
    expect(selectPrice(quote({ bidQty: 0, volume: 5 }))?.source).toBe('LTP');
  });
});

describe('isLowConfidence', () => {
  it('flags small prices', () => {
    expect(isLowConfidence(0.1, 0.05)).toBe(true);
    expect(isLowConfidence(12, 0.05)).toBe(false);
  });
  it('flags under 4 ticks', () => {
    expect(isLowConfidence(2, 0.6)).toBe(true);
  });
});
