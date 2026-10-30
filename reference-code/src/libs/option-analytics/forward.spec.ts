import { describe, expect, it } from 'vitest';
import { estimateForward } from './forward';
import type { LegQuote, OptType, StrikeQuotes } from './types';

const T = 0.01432648401826484, r = 0.06;

function leg(type: OptType, strike: number, mid: number, ltp: number | null = null, volume = 0): LegQuote {
  return {
    token: `${type}${strike}`, type, strike, lotSize: 75, tickSize: 0.05, ltp,
    bid: mid - 0.05, ask: mid + 0.05, bidQty: 75, askQty: 75, volume, oi: 0, prevOi: 0,
    prevClose: null, open: null, high: null, low: null, lastTickMs: 0,
  };
}
const pair = (k: number, c: number, p: number): StrikeQuotes => ({ strike: k, ce: leg('CE', k, c), pe: leg('PE', k, p) });
const v14 = () => [pair(24900, 225, 120), pair(25000, 160, 155.5), pair(25100, 108, 203)];
const base = { spot: 24980, futuresPrice: null, T, r, prevForward: null, eachSide: 3 };

describe('estimateForward', () => {
  it('V14 median parity', () => {
    const res = estimateForward({ ...base, strikes: v14() });
    expect(res.source).toBe('PARITY_MID');
    expect(Math.abs(res.forward - 25004.91830393) / 25004.91830393).toBeLessThan(1e-8);
  });
  it('futures fallback', () => {
    expect(estimateForward({ ...base, strikes: [], futuresPrice: 25010 })).toEqual({ forward: 25010, source: 'FUTURES' });
  });
  it('spot carry fallback', () => {
    const res = estimateForward({ ...base, strikes: [] });
    expect(res.source).toBe('SPOT_CARRY');
    expect(res.forward).toBe(24980 * Math.exp(r * T));
  });
  it('bad pair is ignored by the median', () => {
    const s = v14();
    s[1] = pair(25000, 900, 155.5);
    const res = estimateForward({ ...base, strikes: s });
    expect(res.source).toBe('PARITY_MID');
    expect(res.forward).toBeGreaterThanOrEqual(25004.9);
    expect(res.forward).toBeLessThanOrEqual(25005.1);
  });
  it('rejects forward >3% from spot', () => {
    const res = estimateForward({ ...base, spot: 20000, strikes: v14() });
    expect(res.source).not.toBe('PARITY_MID');
    expect(res.source).toBe('SPOT_CARRY');
  });
  it('PARITY_LTP when quotes have no bid/ask', () => {
    const mk = (k: number, c: number, p: number): StrikeQuotes => ({
      strike: k,
      ce: { ...leg('CE', k, c, c, 10), bid: null, ask: null },
      pe: { ...leg('PE', k, p, p, 10), bid: null, ask: null },
    });
    const res = estimateForward({ ...base, strikes: [mk(24900, 225, 120), mk(25000, 160, 155.5), mk(25100, 108, 203)] });
    expect(res.source).toBe('PARITY_LTP');
    close(res.forward, F25100);
  });
  it('futures outside 3% is ignored', () => {
    expect(estimateForward({ ...base, strikes: [], futuresPrice: 30000 }).source).toBe('SPOT_CARRY');
  });
  const F24900 = 25005.09029565, F25000 = 25004.50386981, F25100 = 25004.91830393;
  const close = (a: number, b: number) => expect(Math.abs(a - b) / b).toBeLessThan(1e-8);

  it('centres on prevForward and clips with eachSide 0 (bad far strikes excluded)', () => {
    const s = [pair(24000, 5000, 1), ...v14(), pair(26000, 1, 900)];
    const res = estimateForward({ ...base, strikes: s, eachSide: 0, prevForward: 25004 });
    expect(res.source).toBe('PARITY_MID');
    close(res.forward, F25000);
  });
  it('prevForward (not spot) selects the centre strike: spot 24980, prevForward 25105, eachSide 0 -> 25100 strike', () => {
    const res = estimateForward({ ...base, strikes: v14(), eachSide: 0, prevForward: 25105 });
    close(res.forward, F25100);
  });
  it('eachSide 1 takes exactly three strikes around the centre', () => {
    const s = [pair(24000, 5000, 1), ...v14(), pair(26000, 1, 900)];
    const res = estimateForward({ ...base, strikes: s, eachSide: 1, prevForward: 25004 });
    close(res.forward, F25100);
  });
  it('tie between strikes centres on the lower strike', () => {
    const res = estimateForward({ ...base, spot: 24950, strikes: v14(), eachSide: 0 });
    close(res.forward, F24900);
  });
  it('even count median is the mean of the two middle values', () => {
    const res = estimateForward({ ...base, strikes: [pair(24900, 225, 120), pair(25000, 160, 155.5)] });
    close(res.forward, (F24900 + F25000) / 2);
  });
  it('skips strikes with a missing leg', () => {
    const s = v14();
    s[1] = { strike: 25000, ce: null, pe: leg('PE', 25000, 155.5) };
    const res = estimateForward({ ...base, strikes: s });
    expect(res.source).toBe('PARITY_MID');
    close(res.forward, (F24900 + F25100) / 2);
  });
});
