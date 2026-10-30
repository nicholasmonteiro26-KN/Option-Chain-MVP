import type { LegQuote, OiSense } from './types';

/** OI Sense from the option's own price change and OI change (§8). No dead-band. */
export function oiSense(priceChg: number, oiChg: number): OiSense {
  if (!Number.isFinite(priceChg) || !Number.isFinite(oiChg) || priceChg === 0 || oiChg === 0) return 'NEUTRAL';
  if (priceChg > 0) return oiChg > 0 ? 'LONG_BUILD_UP' : 'SHORT_COVERING';
  return oiChg > 0 ? 'SHORT_BUILD_UP' : 'LONG_UNWINDING';
}

export function oiChange(oi: number, prevOi: number): { chg: number; pct: number | null } {
  const chg = oi - prevOi;
  return { chg, pct: prevOi === 0 ? null : (chg / prevOi) * 100 };
}

/** Max pain over all listed strikes (§6). Ties: nearest to forward, then lower strike. */
export function maxPain(
  rows: { strike: number; ceOi: number; peOi: number }[],
  unitsPerOi: number,
  forward: number,
): { maxPain: number | null; painRs: Map<number, number> } {
  const painRs = new Map<number, number>();
  let anyOi = false;
  for (const r of rows) if (r.ceOi > 0 || r.peOi > 0) anyOi = true;
  for (const x of rows) {
    let pain = 0;
    for (const k of rows) {
      pain += k.ceOi * Math.max(0, x.strike - k.strike) + k.peOi * Math.max(0, k.strike - x.strike);
    }
    painRs.set(x.strike, pain * unitsPerOi);
  }
  if (!anyOi) return { maxPain: null, painRs };
  let best: number | null = null;
  let bestPain = Infinity;
  for (const [strike, pain] of painRs) {
    if (best === null || pain < bestPain) {
      best = strike; bestPain = pain;
    } else if (pain === bestPain) {
      const dNew = Math.abs(strike - forward), dBest = Math.abs(best - forward);
      if (dNew < dBest || (dNew === dBest && strike < best)) best = strike;
    }
  }
  return { maxPain: best, painRs };
}

export function pcr(num: number, den: number): number | null {
  if (!(den > 0)) return null;
  const v = num / den;
  return Number.isFinite(v) ? v : null;
}

const sumPos = (a: number | null, b: number | null): number | null =>
  a === null || b === null || !(a > 0) || !(b > 0) ? null : a + b;

export function straddle(ce: LegQuote, pe: LegQuote): {
  price: number | null; bid: number | null; ask: number | null; decay: number | null; decayPct: number | null;
} {
  const price = sumPos(ce.ltp, pe.ltp);
  const bid = sumPos(ce.bid, pe.bid);
  const ask = sumPos(ce.ask, pe.ask);
  const decay = price === null || ce.prevClose === null || pe.prevClose === null
    ? null : price - (ce.prevClose + pe.prevClose);
  const prevSum = ce.prevClose !== null && pe.prevClose !== null ? ce.prevClose + pe.prevClose : null;
  const decayPct = decay === null || prevSum === null || !(prevSum > 0) ? null : (decay / prevSum) * 100;
  return { price, bid, ask, decay, decayPct };
}

/** GEX in rupees crore per 1% move (§11); null gamma counts as 0. */
export function gexCr(
  spotGamma: { ce: number | null; pe: number | null },
  units: { ce: number; pe: number },
  S: number,
): number {
  const ce = (spotGamma.ce ?? 0) * units.ce;
  const pe = (spotGamma.pe ?? 0) * units.pe;
  return ((ce - pe) * S * S * 0.01) / 1e7;
}
