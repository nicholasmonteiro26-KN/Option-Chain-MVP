import { describe, expect, it } from 'vitest';
import { gexCr, maxPain, oiChange, oiSense, pcr, straddle } from './aggregates';
import type { LegQuote } from './types';

const leg = (over: Partial<LegQuote>): LegQuote => ({
  token: 't', type: 'CE', strike: 25000, lotSize: 75, tickSize: 0.05,
  ltp: 100, bid: 99, ask: 101, bidQty: 75, askQty: 75, volume: 10, oi: 1, prevOi: 1,
  prevClose: 100, open: null, high: null, low: null, lastTickMs: 0, ...over,
});

const V13 = [
  { strike: 24800, ceOi: 1000, peOi: 3500 },
  { strike: 24900, ceOi: 1500, peOi: 4000 },
  { strike: 25000, ceOi: 3000, peOi: 3000 },
  { strike: 25100, ceOi: 4000, peOi: 1500 },
  { strike: 25200, ceOi: 2500, peOi: 500 },
];

describe('maxPain', () => {
  it('V13: finds 25000 and pain in rupees', () => {
    const r = maxPain(V13, 75, 25000);
    expect(r.maxPain).toBe(25000);
    expect(r.painRs.get(25000)).toBe(45_000_000);
    expect(r.painRs.get(24800)).toBe(123_750_000);
    expect(r.painRs.get(24900)).toBe(63_750_000);
    expect(r.painRs.get(25100)).toBe(71_250_000);
    expect(r.painRs.get(25200)).toBe(138_750_000);
    expect(r.painRs.size).toBe(5);
  });

  const tie = [
    { strike: 100, ceOi: 1, peOi: 0 },
    { strike: 200, ceOi: 0, peOi: 1 },
  ];
  it('real tie (pain 100 at both) goes to the strike nearest forward', () => {
    const r = maxPain(tie, 1, 190);
    expect(r.painRs.get(100)).toBe(100);
    expect(r.painRs.get(200)).toBe(100);
    expect(r.maxPain).toBe(200);
    expect(maxPain(tie, 1, 110).maxPain).toBe(100);
  });
  it('tie equidistant from forward goes to the lower strike, regardless of input order', () => {
    expect(maxPain(tie, 1, 150).maxPain).toBe(100);
    expect(maxPain([...tie].reverse(), 1, 150).maxPain).toBe(100);
  });
  it('all OI zero gives null with a 0 entry per strike', () => {
    const r = maxPain(V13.map((x) => ({ ...x, ceOi: 0, peOi: 0 })), 75, 25000);
    expect(r.maxPain).toBeNull();
    expect(r.painRs.size).toBe(5);
    for (const v of r.painRs.values()) expect(v).toBe(0);
  });
});

describe('pcr', () => {
  it('V13 overall and per strike', () => {
    expect(pcr(12500, 12000)).toBeCloseTo(1.041666667, 8);
    expect(pcr(3500, 1000)).toBe(3.5);
    expect(pcr(4000, 1500)).toBe(4000 / 1500);
    expect(pcr(4000, 1500)).toBeCloseTo(2.666667, 6);
    expect(pcr(3000, 3000)).toBe(1);
    expect(pcr(1500, 4000)).toBe(0.375);
    expect(pcr(500, 2500)).toBe(0.2);
  });
  it('null for zero or negative denominator, or non-finite', () => {
    expect(pcr(5, 0)).toBeNull();
    expect(pcr(5, -1)).toBeNull();
    expect(pcr(Number.NaN, 5)).toBeNull();
  });
});

describe('oiChange', () => {
  it('computes change and percent', () => {
    expect(oiChange(150, 100)).toEqual({ chg: 50, pct: 50 });
    expect(oiChange(50, 100)).toEqual({ chg: -50, pct: -50 });
  });
  it('pct null when prevOi is 0', () => {
    const r = oiChange(100, 0);
    expect(r.chg).toBe(100);
    expect(r.pct).toBeNull();
  });
});

describe('oiSense', () => {
  it('V15 table', () => {
    expect(oiSense(12, 50000)).toBe('LONG_BUILD_UP');
    expect(oiSense(-12, 50000)).toBe('SHORT_BUILD_UP');
    expect(oiSense(12, -50000)).toBe('SHORT_COVERING');
    expect(oiSense(-12, -50000)).toBe('LONG_UNWINDING');
  });
  it('neutral on zero or non-finite inputs', () => {
    expect(oiSense(0, 50000)).toBe('NEUTRAL');
    expect(oiSense(12, 0)).toBe('NEUTRAL');
    expect(oiSense(0, 0)).toBe('NEUTRAL');
    expect(oiSense(Number.NaN, 5)).toBe('NEUTRAL');
    expect(oiSense(5, Number.POSITIVE_INFINITY)).toBe('NEUTRAL');
  });
});

describe('straddle', () => {
  it('V15 price, decay, decayPct', () => {
    const s = straddle(
      leg({ ltp: 160, prevClose: 185, bid: 159, ask: 161 }),
      leg({ type: 'PE', ltp: 140, prevClose: 170, bid: 139, ask: 141 }),
    );
    expect(s.price).toBe(300);
    expect(s.bid).toBe(298);
    expect(s.ask).toBe(302);
    expect(s.decay).toBe(-55);
    expect(s.decayPct).toBeCloseTo(-15.49295775, 6);
    expect(Math.abs((s.decayPct as number) - (-55 / 355) * 100)).toBeLessThan(1e-8);
  });
  it('bid null when a leg bid is 0 or null; ask likewise', () => {
    const pe = leg({ type: 'PE' });
    expect(straddle(leg({ bid: 0 }), pe).bid).toBeNull();
    expect(straddle(leg({}), leg({ type: 'PE', bid: null })).bid).toBeNull();
    expect(straddle(leg({ ask: 0 }), pe).ask).toBeNull();
    expect(straddle(leg({}), leg({ type: 'PE', ask: null })).ask).toBeNull();
    expect(straddle(leg({ bid: 0 }), pe).price).toBe(200);
  });
  it('price null when an ltp is null or 0; decay then null', () => {
    const pe = leg({ type: 'PE' });
    for (const ce of [leg({ ltp: null }), leg({ ltp: 0 })]) {
      const s = straddle(ce, pe);
      expect(s.price).toBeNull();
      expect(s.decay).toBeNull();
      expect(s.decayPct).toBeNull();
    }
  });
  it('decay null when a prevClose is null', () => {
    const s = straddle(leg({ prevClose: null }), leg({ type: 'PE' }));
    expect(s.price).toBe(200);
    expect(s.decay).toBeNull();
    expect(s.decayPct).toBeNull();
  });
  it('decayPct null when prevSum is 0', () => {
    const s = straddle(leg({ prevClose: 0 }), leg({ type: 'PE', prevClose: 0 }));
    expect(s.decay).toBe(200);
    expect(s.decayPct).toBeNull();
  });
});

describe('gexCr', () => {
  const S = 24978.51950749323;
  const g = 0.001111939394;
  it('V11', () => {
    expect(Math.abs(gexCr({ ce: g, pe: g }, { ce: 3000 * 75, pe: 1000 * 75 }, S) - 104.065)).toBeLessThan(1e-3);
  });
  it('null gamma counts as 0', () => {
    const u = { ce: 3000 * 75, pe: 1000 * 75 };
    const callOnly = gexCr({ ce: g, pe: null }, u, S);
    expect(callOnly).toBeCloseTo((g * u.ce * S * S * 0.01) / 1e7, 6);
    expect(gexCr({ ce: null, pe: g }, u, S)).toBeLessThan(0);
    expect(gexCr({ ce: null, pe: null }, u, S)).toBe(0);
  });
});
