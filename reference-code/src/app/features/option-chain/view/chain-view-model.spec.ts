import { describe, expect, it } from 'vitest';
import { ChainAnalytics, LegQuote } from '@option-analytics/index';
import { ChainMeta, ContractRef, QUICK_UNDERLYINGS } from '../data-access/models';
import { COLUMNS } from '../columns/column-registry';
import { PRESETS } from '../columns/presets';
import { buildViewModel, RowVM } from './chain-view-model';

const ref = (token: string): ContractRef => ({ token, tsym: token, lotSize: 75, tickSize: 0.05, pricePrecision: 2 });
const STRIKES = Array.from({ length: 21 }, (_, i) => 24000 + i * 50);
const META: ChainMeta = {
  underlying: QUICK_UNDERLYINGS[0]!,
  expiry: { iso: '2026-11-10', exd: '10-NOV-2026', sampleTsym: 'X', foExch: 'NFO' },
  strikes: STRIKES.map((k) => ({ strike: k, ce: ref(`NFO|c${k}`), pe: ref(`NFO|p${k}`) })),
  strikeStep: 50,
};
function quote(token: string, type: 'CE' | 'PE', strike: number, oi: number): LegQuote {
  return {
    token, type, strike, lotSize: 75, tickSize: 0.05, ltp: 100, bid: 99, ask: 101, bidQty: 1, askQty: 1,
    volume: oi * 2, oi, prevOi: 0, prevClose: 80, open: 90, high: 110, low: 85, lastTickMs: 0,
  };
}
const QUOTES = new Map<string, LegQuote>();
STRIKES.forEach((k, i) => {
  QUOTES.set(`NFO|c${k}`, quote(`NFO|c${k}`, 'CE', k, 1000 * (i + 1)));
  QUOTES.set(`NFO|p${k}`, quote(`NFO|p${k}`, 'PE', k, 500 * (21 - i)));
});
function analytics(atm: number): ChainAnalytics {
  return {
    forward: atm, forwardSource: 'PARITY_MID', T: 0.02, atmStrike: atm, atmIv: 0.15, maxPain: null, pcrOi: null,
    pcrVol: null, cumOi: 0, legs: {},
    strikes: STRIKES.map((k) => ({
      strike: k, straddle: 10, straddleBid: null, straddleAsk: null, strDecay: null, strDecayPct: null,
      cumOi: k - 23000, avgIv: null, pcrOi: null, pcrVol: null, painCr: null, gexOiCr: 0, gexVolCr: 0,
    })),
  };
}
const base = {
  meta: META, quotes: QUOTES, analytics: analytics(24500) as ChainAnalytics | null, spot: 24512, presetId: 'default',
  customColumns: [] as string[], strikeCount: 4 as number | 'all', prevSlot: null as number | null, hysteresis: 0.1,
};

describe('buildViewModel', () => {
  it('returns strikeCount rows centred on the spot slot: floor(n/2) at or below it, the rest above', () => {
    const vm = buildViewModel(base); // spot 24512 -> slot 24500
    expect(vm.spotSlot).toBe(24500);
    expect(vm.rows.map((r) => r.strike)).toEqual([24450, 24500, 24550, 24600]);
  });

  it("'all' returns every strike", () => {
    expect(buildViewModel({ ...base, strikeCount: 'all' }).rows.length).toBe(21);
  });

  it('shifts the window at the chain edge so it still has strikeCount rows', () => {
    const lo = buildViewModel({ ...base, spot: 24010 });
    expect(lo.rows.map((r) => r.strike)).toEqual([24000, 24050, 24100, 24150]);
    const hi = buildViewModel({ ...base, spot: 25010 });
    expect(hi.rows.map((r) => r.strike)).toEqual([24850, 24900, 24950, 25000]);
  });

  it('clips only when the chain is smaller than strikeCount', () => {
    expect(buildViewModel({ ...base, strikeCount: 50 }).rows.length).toBe(21);
  });

  it('the window does not depend on analytics (same rows before and after the first analysis)', () => {
    const before = buildViewModel({ ...base, analytics: null });
    const after = buildViewModel({ ...base, analytics: analytics(24800) });
    expect(after.rows.map((r) => r.strike)).toEqual(before.rows.map((r) => r.strike));
    const odd = buildViewModel({ ...base, analytics: null, spot: 24525, strikeCount: 3 });
    expect(odd.rows.map((r) => r.strike)).toEqual([24500, 24550, 24600]);
  });

  it('follows the hysteresis slot: a small move past the next strike keeps the window', () => {
    const vm = buildViewModel({ ...base, prevSlot: 24500, spot: 24553 });
    expect(vm.spotSlot).toBe(24500);
    expect(vm.rows.map((r) => r.strike)).toEqual([24450, 24500, 24550, 24600]);
  });

  it('SENSEX Jan-27 (forward far above spot) at 16 strikes keeps the slot row in the window, at index 7', () => {
    const ks = Array.from({ length: 21 }, (_, i) => 73000 + i * 100);
    const meta: ChainMeta = {
      underlying: QUICK_UNDERLYINGS[1]!,
      expiry: { iso: '2027-01-28', exd: '28-JAN-2027', sampleTsym: 'X', foExch: 'BFO' },
      strikes: ks.map((k) => ({ strike: k, ce: ref(`BFO|c${k}`), pe: ref(`BFO|p${k}`) })),
      strikeStep: 100,
    };
    const fwdAtm = { ...analytics(74900), strikes: [] } as ChainAnalytics;
    const vm = buildViewModel({ ...base, meta, quotes: new Map(), analytics: fwdAtm, spot: 73830.29, strikeCount: 16 });
    expect(vm.spotSlot).toBe(73800);
    expect(vm.rows).toHaveLength(16);
    expect(vm.rows.findIndex((r) => r.strike === 73800)).toBe(7);
  });

  it('Greeks preset is mirrored with the right columns', () => {
    const vm = buildViewModel({ ...base, presetId: 'greeks' });
    expect(vm.mode).toBe('mirrored');
    expect(vm.columns.map((c) => c.id)).toEqual(['iv', 'theta', 'vega', 'gamma', 'delta']);
  });

  it('Statistics preset is strike mode', () => {
    const vm = buildViewModel({ ...base, presetId: 'stats' });
    expect(vm.mode).toBe('strike');
    expect(vm.columns[0]!.id).toBe('straddle');
  });

  it('Custom with empty columns falls back to ltp; custom uses given columns', () => {
    expect(buildViewModel({ ...base, presetId: 'custom', customColumns: [] }).columns.map((c) => c.id)).toEqual(['ltp']);
    const vm = buildViewModel({ ...base, presetId: 'custom', customColumns: ['oi', 'nope', 'iv'] });
    expect(vm.columns.map((c) => c.id)).toEqual(['oi', 'iv']);
    expect(vm.mode).toBe('mirrored');
  });

  it('sums come from visible rows only', () => {
    const vm = buildViewModel(base);
    // visible strikes idx 9..12 (24450..24600) -> CE oi 10000+11000+12000+13000
    expect(vm.sums['oi']!.ce).toBe(46000);
    expect(vm.sums['oi']!.pe).toBe(500 * (12 + 11 + 10 + 9));
    expect(vm.sums['oi']!.total).toBe(46000 + 21000);
    expect(vm.sums['volume']!.ce).toBe(92000);
    expect(vm.sums['ltp']).toBeUndefined();
  });

  it('strike-mode sums put total in total and ce/pe 0', () => {
    const vm = buildViewModel({ ...base, presetId: 'stats' });
    expect(vm.sums['cumOi']).toEqual({ ce: 0, pe: 0, total: 1450 + 1500 + 1550 + 1600 });
  });

  it('maxOi covers visible rows', () => {
    const vm = buildViewModel(base);
    expect(vm.maxOi).toEqual({ ce: 13000, pe: 6000, cum: 1600 });
  });

  it('joins quotes, leg analytics and strike analytics', () => {
    const an = analytics(24500);
    an.legs['NFO|c24500'] = {
      token: 'NFO|c24500', iv: 0.2, ivStatus: 'OK', ivSource: 'MID', lowConfidence: false,
      delta: 0.5, gamma: null, theta: null, vega: null, itmProb: null, oiChg: 0, oiChgPct: null, sense: 'NEUTRAL',
    };
    const row = buildViewModel({ ...base, analytics: an }).rows.find((r) => r.strike === 24500) as RowVM;
    expect(row.ce!.quote!.oi).toBe(11000);
    expect(row.ce!.a!.iv).toBe(0.2);
    expect(row.pe!.a).toBeNull();
    expect(row.s!.cumOi).toBe(1500);
  });

  it('spotSlot is null with no strikes and a strike otherwise', () => {
    expect(buildViewModel({ ...base, meta: { ...META, strikes: [] } }).spotSlot).toBeNull();
    expect(buildViewModel(base).spotSlot).toBe(24500);
    expect(buildViewModel({ ...base, prevSlot: 24500, spot: 24548 }).spotSlot).toBe(24500);
  });
});

describe('PRESETS and COLUMNS', () => {
  it('has exact column lists', () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
    expect(by['default']!.columns).toEqual(['volume', 'oi', 'bid', 'ask', 'ltpChg']);
    expect(by['price']!.columns).toEqual(['chgPct', 'chg', 'bid', 'ask', 'ltp']);
    expect(by['oi']!.columns).toEqual(['oiSense', 'oiChgPct', 'oiChg', 'oi', 'itmProb']);
    expect(by['candle']!.columns).toEqual(['volume', 'low', 'high', 'open', 'ltp']);
    expect(by['stats']!.columns).toEqual(['straddle', 'cumOi', 'avgIv', 'pcrOi', 'pcrVol', 'gexOiCr', 'gexVolCr']);
    expect(by['straddle']!.mode).toBe('strike');
    expect(PRESETS.every((p) => p.columns.every((c) => COLUMNS[c]))).toBe(true);
  });

  it('formats per spec', () => {
    const f = (id: string, v: number | string | null) => COLUMNS[id]!.format(v);
    expect(f('iv', 0.1234)).toBe('12.34');
    expect(f('itmProb', 0.456)).toBe('45.6%');
    expect(f('oi', 250000)).toBe('2.50');
    expect(f('oiChg', 150000)).toBe('+1.50');
    expect(f('oiChg', -150000)).toBe('-1.50');
    expect(f('chgPct', 3.456)).toBe('+3.46');
    expect(f('delta', 0.51234)).toBe('0.5123');
    expect(f('theta', -3.456)).toBe('-3.46');
    expect(f('painCr', 12.6)).toBe('13');
    expect(f('gexOiCr', 2.25)).toBe('+2.3');
    expect(f('oiSense', 'NEUTRAL')).toBe('—');
    expect(f('oiSense', 'LONG_BUILD_UP')).toBe('Long Build Up');
    expect(f('iv', null)).toBe('–');
  });

  it('derives chg and chgPct from ltp and prevClose', () => {
    const row = buildViewModel(base).rows[0]!;
    expect(COLUMNS['chg']!.value(row, 'ce')).toBe(20);
    expect(COLUMNS['chgPct']!.value(row, 'ce')).toBe(25);
    const noPrev: RowVM = { ...row, ce: { ...row.ce!, quote: { ...row.ce!.quote!, prevClose: null } } };
    expect(COLUMNS['chg']!.value(noPrev, 'ce')).toBeNull();
  });
});
