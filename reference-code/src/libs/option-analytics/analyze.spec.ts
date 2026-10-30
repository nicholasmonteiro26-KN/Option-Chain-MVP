import { describe, expect, it } from 'vitest';
import { analyzeChain, smileIv, type ChainAnalytics, type ChainInput } from './analyze';
import { DEFAULT_CONFIG } from './config';
import { gexCr, maxPain, pcr } from './aggregates';
import { greeks } from './black76';
import { expiryInstantMs, yearsToExpiry } from './time';
import type { LegQuote, StrikeQuotes } from './types';
import {
  SAMPLE_LOT, SAMPLE_NOW_MS, SAMPLE_SIGMA, SAMPLE_SPOT, sampleChain, sampleChainWithSigma, sampleForward, sampleToken,
} from './testing/sample-chain';

/** Collects the path of every number that is NaN or ±Infinity, descending into objects, arrays and Maps. */
function badNumbers(v: unknown, path = '$', out: string[] = []): string[] {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) out.push(`${path}=${v}`);
  } else if (v instanceof Map) {
    for (const [k, x] of v) { badNumbers(k, `${path}<key>`, out); badNumbers(x, `${path}[${String(k)}]`, out); }
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => badNumbers(x, `${path}[${i}]`, out));
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) badNumbers(x, `${path}.${k}`, out);
  }
  return out;
}

const r = DEFAULT_CONFIG.riskFreeRate;
const legsOf = (input: ChainInput): LegQuote[] =>
  input.strikes.flatMap((s) => [s.ce, s.pe]).filter((q): q is LegQuote => q !== null);
const leg = (res: ChainAnalytics, token: string) => {
  const l = res.legs[token];
  if (!l) throw new Error(`missing leg ${token}`);
  return l;
};
const row = (res: ChainAnalytics, strike: number) => {
  const s = res.strikes.find((x) => x.strike === strike);
  if (!s) throw new Error(`missing strike ${strike}`);
  return s;
};
const nullGreeks = [null, null, null, null, null];
const greekList = (l: { delta: number | null; gamma: number | null; theta: number | null; vega: number | null; itmProb: number | null }) =>
  [l.delta, l.gamma, l.theta, l.vega, l.itmProb];

describe('badNumbers walker', () => {
  it('finds NaN/Infinity in nested objects, arrays and Maps', () => {
    expect(badNumbers({ a: [1, { b: NaN }], m: new Map([[1, -Infinity]]), ok: null }))
      .toEqual(['$.a[1].b=NaN', '$.m[1]=-Infinity']);
  });
});

describe('analyzeChain on the sample chain', () => {
  const input = sampleChain();
  const res = analyzeChain(input);

  it('recovers every leg IV within 1e-6 of the generating sigma', () => {
    const tokens = Object.keys(SAMPLE_SIGMA);
    expect(tokens.length).toBe(42);
    for (const t of tokens) {
      const l = leg(res, t);
      expect(l.ivStatus, t).toBe('OK');
      expect(l.ivSource, t).toBe('MID');
      expect(Math.abs((l.iv as number) - (SAMPLE_SIGMA[t] as number)), t).toBeLessThan(1e-6);
    }
  });

  it('forward comes from mid parity and matches the generating forward', () => {
    expect(res.forwardSource).toBe('PARITY_MID');
    expect(Math.abs(res.forward - sampleForward())).toBeLessThan(1e-6);
    expect(res.T).toBe(yearsToExpiry(SAMPLE_NOW_MS, expiryInstantMs('2026-11-03')));
  });

  it('maxPain equals maxPain() run directly on the fixture OI', () => {
    const rows = input.strikes.map((s) => ({ strike: s.strike, ceOi: s.ce?.oi ?? 0, peOi: s.pe?.oi ?? 0 }));
    const direct = maxPain(rows, 1, res.forward);
    expect(direct.maxPain).not.toBeNull();
    expect(res.maxPain).toBe(direct.maxPain);
    for (const s of res.strikes) expect(s.painCr).toBe((direct.painRs.get(s.strike) as number) / 1e7);
  });

  it('ATM is the strike nearest F; ATM IV is the mean of CE and PE IV', () => {
    expect(res.atmStrike).toBe(25000);
    const ce = leg(res, 'CE25000').iv as number, pe = leg(res, 'PE25000').iv as number;
    expect(res.atmIv).toBe((ce + pe) / 2);
  });

  it('chain totals and PCR use raw OI and volume', () => {
    const legs = legsOf(input);
    const sum = (f: (q: LegQuote) => number, t?: 'CE' | 'PE') =>
      legs.filter((q) => !t || q.type === t).reduce((a, q) => a + f(q), 0);
    expect(res.cumOi).toBe(sum((q) => q.oi));
    expect(res.pcrOi).toBe(pcr(sum((q) => q.oi, 'PE'), sum((q) => q.oi, 'CE')));
    expect(res.pcrVol).toBe(pcr(sum((q) => q.volume, 'PE'), sum((q) => q.volume, 'CE')));
  });

  it('per-strike fields: straddle, cumOi, avgIv, PCR, GEX, Greeks, OI change, sense', () => {
    const k = 25100;
    const s = input.strikes.find((x) => x.strike === k) as StrikeQuotes;
    const ce = s.ce as LegQuote, pe = s.pe as LegQuote;
    const rw = row(res, k);
    expect(rw.straddle).toBeCloseTo((ce.ltp as number) + (pe.ltp as number), 9);
    expect(rw.straddleBid).toBeCloseTo((ce.bid as number) + (pe.bid as number), 9);
    expect(rw.straddleAsk).toBeCloseTo((ce.ask as number) + (pe.ask as number), 9);
    expect(rw.strDecay).toBeCloseTo(
      (ce.ltp as number) + (pe.ltp as number) - (ce.prevClose as number) - (pe.prevClose as number), 9);
    expect(rw.strDecayPct).not.toBeNull();
    expect(rw.cumOi).toBe(ce.oi + pe.oi);
    const lc = leg(res, ce.token), lp = leg(res, pe.token);
    expect(rw.avgIv).toBe(((lc.iv as number) + (lp.iv as number)) / 2);
    expect(rw.pcrOi).toBe(pe.oi / ce.oi);
    expect(rw.pcrVol).toBe(pe.volume / ce.volume);
    const g = greeks('CE', res.forward, SAMPLE_SPOT, k, res.T, r, lc.iv as number);
    expect(greekList(lc)).toEqual([g.delta, g.gamma, g.theta, g.vega, g.itmProb]);
    expect(rw.gexOiCr).toBe(gexCr({ ce: lc.gamma, pe: lp.gamma }, { ce: ce.oi, pe: pe.oi }, SAMPLE_SPOT));
    expect(rw.gexVolCr).toBe(gexCr({ ce: lc.gamma, pe: lp.gamma }, { ce: ce.volume, pe: pe.volume }, SAMPLE_SPOT));
    expect(rw.gexOiCr).not.toBe(0);
    expect(lc.oiChg).toBe(ce.oi - ce.prevOi);
    expect(lc.oiChgPct).toBe(((ce.oi - ce.prevOi) / ce.prevOi) * 100);
    // Fixture: CE ltp below prevClose with OI up -> short build-up; PE ltp above prevClose with OI down -> short covering.
    expect(lc.sense).toBe('SHORT_BUILD_UP');
    expect(lp.sense).toBe('SHORT_COVERING');
    expect(lc.lowConfidence).toBe(false);
  });

  it('legs are keyed by token and strikes are sorted even when input is not', () => {
    const r2 = analyzeChain({ ...input, strikes: [...input.strikes].reverse() });
    expect(r2.strikes.map((s) => s.strike)).toEqual(input.strikes.map((s) => s.strike));
    expect(Object.keys(r2.legs).sort()).toEqual(Object.keys(SAMPLE_SIGMA).sort());
    expect(leg(r2, 'PE24700').token).toBe('PE24700');
    expect(r2.atmStrike).toBe(25000);
  });

  it('has no NaN or Infinity anywhere', () => {
    expect(badNumbers(res)).toEqual([]);
  });
});

describe('illiquid leg', () => {
  it('illiquid leg excluded from IV but counted in aggregates', () => {
    const liquid = analyzeChain(sampleChain());
    const res = analyzeChain(sampleChain({ override: { strike: 24800, type: 'PE', patch: { bid: 0, ask: 0, volume: 0 } } }));
    const l = leg(res, 'PE24800');
    expect(l.ivStatus).toBe('NO_PRICE');
    expect(l.iv).toBeNull();
    expect(l.ivSource).toBeNull();
    expect(l.lowConfidence).toBe(false);
    expect(res.cumOi).toBe(liquid.cumOi);
    expect(res.pcrOi).toBe(liquid.pcrOi);
    expect(row(res, 24800).cumOi).toBe(row(liquid, 24800).cumOi);
    expect(row(res, 24800).pcrOi).toBe(row(liquid, 24800).pcrOi);
    expect(row(res, 24800).avgIv).toBe(leg(res, 'CE24800').iv);
    // Greeks fall back to the smile IV: K < F prefers PE, which is invalid, so the CE IV is used.
    const sigma = leg(res, 'CE24800').iv as number;
    const g = greeks('PE', res.forward, SAMPLE_SPOT, 24800, res.T, r, sigma);
    expect(greekList(l)).toEqual([g.delta, g.gamma, g.theta, g.vega, g.itmProb]);
    expect(badNumbers(res)).toEqual([]);
  });
});

describe('expired chain', () => {
  it('expired chain yields EXPIRED status, no NaN', () => {
    const input = sampleChain({ nowMs: Date.parse('2026-11-03T15:29:30+05:30') });
    const res = analyzeChain(input);
    expect(res.T).toBe(0);
    expect(res.forward).toBe(SAMPLE_SPOT);
    expect(res.forwardSource).toBe('SPOT_CARRY');
    expect(res.atmIv).toBeNull();
    for (const q of legsOf(input)) {
      const l = leg(res, q.token);
      expect(l.ivStatus).toBe('EXPIRED');
      expect(l.iv).toBeNull();
      expect(l.ivSource).toBeNull();
      expect(l.lowConfidence).toBe(false);
      expect(greekList(l)).toEqual(nullGreeks);
      expect(l.oiChg).toBe(q.oi - q.prevOi);
    }
    for (const s of res.strikes) {
      expect(s.gexOiCr).toBe(0);
      expect(s.gexVolCr).toBe(0);
      expect(s.avgIv).toBeNull();
      expect(s.painCr).not.toBeNull();
    }
    expect(res.maxPain).not.toBeNull();
    expect(res.cumOi).toBeGreaterThan(0);
    expect(res.pcrOi).not.toBeNull();
    expect(badNumbers(res)).toEqual([]);
  });

  it('just outside the 60 s floor is still live', () => {
    const res = analyzeChain(sampleChain({ nowMs: Date.parse('2026-11-03T15:28:59+05:30') }));
    expect(res.T).toBeGreaterThan(0);
    expect(leg(res, 'CE25000').ivStatus).not.toBe('EXPIRED');
    expect(badNumbers(res)).toEqual([]);
  });
});

describe('smile IV for Greeks when a leg has no IV', () => {
  const noPrice = { bid: null, ask: null, ltp: null, volume: 0 };
  it('K > F: CE without a price borrows the PE IV', () => {
    const res = analyzeChain(sampleChain({ override: { strike: 25200, type: 'CE', patch: noPrice } }));
    const sigma = leg(res, 'PE25200').iv as number;
    expect(leg(res, 'CE25200').vega).toBe(greeks('CE', res.forward, SAMPLE_SPOT, 25200, res.T, r, sigma).vega);
  });
  it('K > F: PE without a price uses the CE IV', () => {
    const res = analyzeChain(sampleChain({ override: { strike: 25200, type: 'PE', patch: noPrice } }));
    const sigma = leg(res, 'CE25200').iv as number;
    expect(leg(res, 'PE25200').vega).toBe(greeks('PE', res.forward, SAMPLE_SPOT, 25200, res.T, r, sigma).vega);
  });
  it('K < F: CE without a price uses the PE IV', () => {
    const res = analyzeChain(sampleChain({ override: { strike: 24800, type: 'CE', patch: noPrice } }));
    const sigma = leg(res, 'PE24800').iv as number;
    expect(leg(res, 'CE24800').vega).toBe(greeks('CE', res.forward, SAMPLE_SPOT, 24800, res.T, r, sigma).vega);
  });
  it('near ATM (|K-F| <= half step): uses the remaining valid IV; both invalid gives null Greeks', () => {
    const one = analyzeChain(sampleChain({ override: { strike: 25000, type: 'CE', patch: noPrice } }));
    const sigma = leg(one, 'PE25000').iv as number;
    expect(leg(one, 'CE25000').gamma).toBe(greeks('CE', one.forward, SAMPLE_SPOT, 25000, one.T, r, sigma).gamma);
    expect(one.atmIv).toBe(sigma);

    const input = sampleChain();
    const s = input.strikes.find((x) => x.strike === 25000) as StrikeQuotes;
    s.ce = { ...(s.ce as LegQuote), ...noPrice };
    s.pe = { ...(s.pe as LegQuote), ...noPrice };
    const none = analyzeChain(input);
    expect(greekList(leg(none, 'PE25000'))).toEqual(nullGreeks);
    expect(greekList(leg(none, 'CE25000'))).toEqual(nullGreeks);
    expect(none.atmIv).toBeNull();
    expect(row(none, 25000).avgIv).toBeNull();
    expect(row(none, 25000).gexOiCr).toBe(0);
    expect(badNumbers(none)).toEqual([]);
  });
});

describe('edge inputs', () => {
  it('missing leg: straddle and per-strike PCR null, missing leg contributes 0', () => {
    const input = sampleChain();
    const s = input.strikes.find((x) => x.strike === 25500) as StrikeQuotes;
    const ce = s.ce as LegQuote;
    s.pe = null;
    const res = analyzeChain(input);
    const rw = row(res, 25500);
    expect([rw.straddle, rw.straddleBid, rw.straddleAsk, rw.strDecay, rw.strDecayPct, rw.pcrOi, rw.pcrVol])
      .toEqual([null, null, null, null, null, null, null]);
    expect(rw.cumOi).toBe(ce.oi);
    const lc = leg(res, ce.token);
    expect(rw.avgIv).toBe(lc.iv);
    expect(rw.gexOiCr).toBe(gexCr({ ce: lc.gamma, pe: null }, { ce: ce.oi, pe: 0 }, SAMPLE_SPOT));
    expect(res.legs[sampleToken('PE', 25500)]).toBeUndefined();
  });

  it('treats OI and volume as quantity whatever oiUnit says (the store normalises lots at ingestion)', () => {
    const qty = analyzeChain(sampleChain());
    const input = sampleChain();
    input.config = { ...input.config, oiUnit: 'lots' };
    const lots = analyzeChain(input);
    expect(lots).toEqual(qty);
    // Max pain pays out in quantity directly: unitsPerOi 1, never the lot size.
    const b = row(qty, 25100);
    const painRows = input.strikes.map((s) => ({ strike: s.strike, ceOi: s.ce?.oi ?? 0, peOi: s.pe?.oi ?? 0 }));
    expect(b.painCr).toBeCloseTo(maxPain(painRows, 1, qty.forward).painRs.get(25100)! / 1e7, 9);
    expect(SAMPLE_LOT).toBeGreaterThan(1); // so a lot-size scaling would have shown
  });

  it('all OI zero: maxPain, painCr and PCR are null', () => {
    const input = sampleChain();
    for (const q of legsOf(input)) { q.oi = 0; q.prevOi = 0; }
    const res = analyzeChain(input);
    expect(res.maxPain).toBeNull();
    expect(res.pcrOi).toBeNull();
    expect(res.cumOi).toBe(0);
    for (const s of res.strikes) { expect(s.painCr).toBeNull(); expect(s.pcrOi).toBeNull(); }
    expect(leg(res, 'CE25000').oiChgPct).toBeNull();
    expect(leg(res, 'CE25000').sense).toBe('NEUTRAL');
    expect(badNumbers(res)).toEqual([]);
  });

  it('under lowConfidenceBelowSec (1 h) to expiry every solved IV is low-confidence, but still computed', () => {
    const res = analyzeChain(sampleChain({ nowMs: Date.parse('2026-11-03T14:31:00+05:30') })); // 59 min left
    const solved = Object.values(res.legs).filter((l) => l.iv !== null);
    expect(solved.length).toBeGreaterThan(0);
    for (const l of solved) {
      expect(l.lowConfidence).toBe(true);
      expect(l.delta).not.toBeNull();
    }
    for (const l of Object.values(res.legs)) if (l.iv === null) expect(l.ivStatus).not.toBe('EXPIRED');
  });

  it('just over 1 h to expiry an ordinary leg is not low-confidence; the threshold comes from config', () => {
    const at = Date.parse('2026-11-03T14:29:00+05:30'); // 61 min left
    expect(leg(analyzeChain(sampleChain({ nowMs: at })), 'CE25000').lowConfidence).toBe(false);
    const input = sampleChain({ nowMs: at });
    input.config = { ...input.config, lowConfidenceBelowSec: 7200 };
    expect(leg(analyzeChain(input), 'CE25000').lowConfidence).toBe(true);
  });

  it('missing prevClose gives NEUTRAL sense; LTP source and low confidence are reported', () => {
    const res = analyzeChain(sampleChain({ override: { strike: 25100, type: 'CE', patch: { prevClose: null } } }));
    expect(leg(res, 'CE25100').sense).toBe('NEUTRAL');
    const lowP = analyzeChain(sampleChain({ override: { strike: 25500, type: 'CE', patch: { bid: null, ask: null, ltp: 0.3, volume: 10 } } }));
    const l = leg(lowP, 'CE25500');
    expect(l.ivSource).toBe('LTP');
    expect(l.lowConfidence).toBe(true);
  });

  it('single strike: step 0 and ATM is that strike', () => {
    const input = sampleChain();
    input.strikes = input.strikes.filter((s) => s.strike === 24900);
    const res = analyzeChain(input);
    expect(res.atmStrike).toBe(24900);
    expect(res.strikes).toHaveLength(1);
    expect(badNumbers(res)).toEqual([]);
  });

  it('ATM tie between two strikes goes to the lower strike', () => {
    const input = sampleChain();
    input.futuresPrice = 25025; // no legs -> FUTURES forward, exactly halfway between 25000 and 25050
    input.strikes = [25050, 25000].map((k) => ({ strike: k, ce: null, pe: null }));
    const res = analyzeChain(input);
    expect(res.forwardSource).toBe('FUTURES');
    expect(res.forward).toBe(25025);
    expect(res.atmStrike).toBe(25000);
    expect(res.atmIv).toBeNull();
    expect(badNumbers(res)).toEqual([]);
  });

  it('warm start from prevIv gives the same IVs', () => {
    const cold = analyzeChain(sampleChain());
    const input = sampleChain();
    input.prevIv = Object.fromEntries(Object.entries(cold.legs).map(([t, l]) => [t, l.iv as number]));
    const warm = analyzeChain(input);
    for (const t of Object.keys(SAMPLE_SIGMA)) {
      expect(Math.abs((leg(warm, t).iv as number) - (leg(cold, t).iv as number))).toBeLessThan(1e-9);
    }
  });

  it('does not mutate its input', () => {
    const input = sampleChain();
    const before = JSON.stringify(input);
    analyzeChain({ ...input, strikes: [...input.strikes].reverse() });
    analyzeChain(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

/** Wall-clock budgets are machine- and load-dependent, so they run only on request: `PERF=1 npx ng test --watch=false`. */
const PERF = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['PERF'] === '1';

describe('performance (150 strikes x 2 legs)', () => {
  it('cold < 50 ms, warm < 10 ms (wall-clock; runs only with PERF=1)', (ctx) => {
    if (!PERF) ctx.skip('wall-clock timing assertions are opt-in: set PERF=1 to run them');
    const { input } = sampleChainWithSigma({ strikeCount: 150 });
    expect(input.strikes).toHaveLength(150);
    analyzeChain(input); // untimed JIT warm-up
    // Wall-clock timing is noisy under parallel test workers: time 7 runs each and budget the minimum.
    const RUNS = 7;
    const timeIt = <T>(fn: () => T): [T, number] => {
      const t0 = performance.now();
      const out = fn();
      return [out, performance.now() - t0];
    };
    const coldTimes: number[] = [];
    let cold = analyzeChain(input);
    for (let i = 0; i < RUNS; i++) {
      const [out, ms] = timeIt(() => analyzeChain(input));
      cold = out;
      coldTimes.push(ms);
    }
    const prevIv: Record<string, number> = {};
    for (const [t, l] of Object.entries(cold.legs)) if (l.iv !== null) prevIv[t] = l.iv;
    const warmInput = { ...input, prevIv, prevForward: cold.forward };
    const warmTimes: number[] = [];
    let warm = cold;
    for (let i = 0; i < RUNS; i++) {
      const [out, ms] = timeIt(() => analyzeChain(warmInput));
      warm = out;
      warmTimes.push(ms);
    }
    const min = (xs: number[]) => Math.min(...xs);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.log(
      `[perf] 150 strikes x ${RUNS} runs: cold min ${min(coldTimes).toFixed(2)} / median ${median(coldTimes).toFixed(2)} ms, ` +
      `warm min ${min(warmTimes).toFixed(2)} / median ${median(warmTimes).toFixed(2)} ms, valid IVs ${Object.keys(prevIv).length}/300`,
    );
    expect(Object.keys(warm.legs)).toHaveLength(300);
    expect(badNumbers(warm)).toEqual([]);
    expect(min(coldTimes)).toBeLessThan(50);
    expect(min(warmTimes)).toBeLessThan(10);
  });
});

describe('smileIv (section 2.5 rule)', () => {
  it('within half a step of F: mean of both, else whichever is valid', () => {
    expect(smileIv(25000, 25010, 50, 0.1, 0.2)).toBeCloseTo(0.15, 15);
    expect(smileIv(25000, 24975, 50, 0.1, 0.2)).toBeCloseTo(0.15, 15);
    expect(smileIv(25000, 25010, 50, null, 0.2)).toBe(0.2);
    expect(smileIv(25000, 25010, 50, 0.1, null)).toBe(0.1);
  });
  it('K > F prefers CE, K < F prefers PE, falling back to the other', () => {
    expect(smileIv(25100, 25010, 50, 0.1, 0.2)).toBe(0.1);
    expect(smileIv(25100, 25010, 50, null, 0.2)).toBe(0.2);
    expect(smileIv(24900, 25010, 50, 0.1, 0.2)).toBe(0.2);
    expect(smileIv(24900, 25010, 50, 0.1, null)).toBe(0.1);
  });
  it('neither valid gives null; step 0 only treats K = F as ATM', () => {
    expect(smileIv(25000, 25010, 50, null, null)).toBeNull();
    expect(smileIv(25000, 25000, 0, 0.1, 0.2)).toBeCloseTo(0.15, 15);
    expect(smileIv(25000, 24990, 0, 0.1, 0.2)).toBe(0.1);
  });
});
