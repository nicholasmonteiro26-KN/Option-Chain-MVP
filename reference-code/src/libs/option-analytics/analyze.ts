import { gexCr, maxPain, oiChange, oiSense, pcr, straddle } from './aggregates';
import { greeks } from './black76';
import type { OptionChainConfig } from './config';
import { estimateForward } from './forward';
import { isLowConfidence, selectPrice, solveIv } from './iv';
import { minStrikeStep } from './strikes';
import { expiryInstantMs, isExpired, yearsToExpiry } from './time';
import type { ForwardSource, IvStatus, LegQuote, OiSense, StrikeQuotes } from './types';

export interface ChainInput {
  spot: number; futuresPrice: number | null; strikes: StrikeQuotes[]; expiryIso: string; nowMs: number;
  prevForward: number | null; prevIv: Record<string, number>; config: OptionChainConfig;
}
export interface LegAnalytics {
  token: string; iv: number | null; ivStatus: IvStatus; ivSource: 'MID' | 'LTP' | null; lowConfidence: boolean;
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null; itmProb: number | null;
  oiChg: number; oiChgPct: number | null; sense: OiSense;
}
export interface StrikeAnalytics {
  strike: number; straddle: number | null; straddleBid: number | null; straddleAsk: number | null;
  strDecay: number | null; strDecayPct: number | null; cumOi: number; avgIv: number | null;
  pcrOi: number | null; pcrVol: number | null; painCr: number | null; gexOiCr: number; gexVolCr: number;
}
export interface ChainAnalytics {
  forward: number; forwardSource: ForwardSource; T: number; atmStrike: number; atmIv: number | null;
  maxPain: number | null; pcrOi: number | null; pcrVol: number | null; cumOi: number;
  legs: Record<string, LegAnalytics>; strikes: StrikeAnalytics[];
}

interface IvResult { iv: number | null; status: IvStatus; source: 'MID' | 'LTP' | null; lowConfidence: boolean }

const EXPIRED_IV: IvResult = { iv: null, status: 'EXPIRED', source: null, lowConfidence: false };
const NO_GREEKS = { delta: null, gamma: null, theta: null, vega: null, itmProb: null } as const;

/** Mean of the non-null values, or null when there are none. */
function meanOf(a: number | null, b: number | null): number | null {
  if (a !== null && b !== null) return (a + b) / 2;
  return a ?? b;
}

/** IV used for a strike's Greeks when a leg has none (§2.5): OTM side first, mean near ATM. */
export function smileIv(K: number, F: number, step: number, ce: number | null, pe: number | null): number | null {
  if (Math.abs(K - F) <= 0.5 * step) return meanOf(ce, pe);
  return K > F ? ce ?? pe : pe ?? ce;
}

/**
 * Full analytics for one expiry (§2–§14). Pure: never mutates the input; every numeric output is finite
 * or null. Runs once per recalculation inside the worker.
 */
export function analyzeChain(input: ChainInput): ChainAnalytics {
  const { spot, config } = input;
  const r = config.riskFreeRate;
  const sorted = [...input.strikes].sort((a, b) => a.strike - b.strike);

  const expiryMs = expiryInstantMs(input.expiryIso);
  const expired = isExpired(input.nowMs, expiryMs, config.minTimeToExpirySec);
  const T = expired ? 0 : yearsToExpiry(input.nowMs, expiryMs);
  const { forward: F, source: forwardSource } = expired
    ? { forward: spot, source: 'SPOT_CARRY' as const }
    : estimateForward({
      spot, futuresPrice: input.futuresPrice, strikes: sorted, T, r,
      prevForward: input.prevForward, eachSide: config.forwardStrikesEachSide,
    });

  // OI and volume are always quantity here: the store normalises `oiUnit: 'lots'` at ingestion (one source of units).
  const step = minStrikeStep(sorted.map((s) => s.strike));
  // Spec §6: under `lowConfidenceBelowSec` to expiry every solved IV is flagged low-confidence.
  const nearExpiry = !expired && (expiryMs - input.nowMs) / 1000 < config.lowConfidenceBelowSec;

  const solve = (q: LegQuote | null): IvResult | null => {
    if (!q) return null;
    if (expired) return EXPIRED_IV;
    const sel = selectPrice(q);
    if (!sel) return { iv: null, status: 'NO_PRICE', source: null, lowConfidence: false };
    const res = solveIv(q.type, sel.price, F, q.strike, T, r, input.prevIv[q.token]);
    const lowConfidence = isLowConfidence(sel.price, q.tickSize) || (nearExpiry && res.iv !== null);
    return { iv: res.iv, status: res.status, source: sel.source, lowConfidence };
  };

  const legAnalytics = (q: LegQuote, iv: IvResult, smile: number | null): LegAnalytics => {
    const sigma = iv.iv ?? smile;
    const g = sigma !== null && T > 0 ? greeks(q.type, F, spot, q.strike, T, r, sigma) : NO_GREEKS;
    const { chg, pct } = oiChange(q.oi, q.prevOi);
    const priceChg = q.prevClose !== null && q.ltp !== null ? q.ltp - q.prevClose : 0;
    return {
      token: q.token, iv: iv.iv, ivStatus: iv.status, ivSource: iv.source, lowConfidence: iv.lowConfidence,
      delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, itmProb: g.itmProb,
      oiChg: chg, oiChgPct: pct, sense: oiSense(priceChg, chg),
    };
  };

  const legs: Record<string, LegAnalytics> = {};
  const painRows: { strike: number; ceOi: number; peOi: number }[] = [];
  const partial: Omit<StrikeAnalytics, 'painCr'>[] = [];
  let ceOiSum = 0, peOiSum = 0, ceVolSum = 0, peVolSum = 0;
  let atmStrike = sorted.length > 0 ? (sorted[0] as StrikeQuotes).strike : 0;
  let atmIv: number | null = null;
  let atmDist = Infinity;

  for (const s of sorted) {
    const { ce, pe } = s;
    const ceIv = solve(ce), peIv = solve(pe);
    const ceOwn = ceIv?.iv ?? null, peOwn = peIv?.iv ?? null;
    const smile = smileIv(s.strike, F, step, ceOwn, peOwn);
    const ceA = ce && ceIv ? legAnalytics(ce, ceIv, smile) : null;
    const peA = pe && peIv ? legAnalytics(pe, peIv, smile) : null;
    if (ce && ceA) legs[ce.token] = ceA;
    if (pe && peA) legs[pe.token] = peA;

    const ceOi = ce?.oi ?? 0, peOi = pe?.oi ?? 0;
    ceOiSum += ceOi; peOiSum += peOi;
    ceVolSum += ce?.volume ?? 0; peVolSum += pe?.volume ?? 0;
    painRows.push({ strike: s.strike, ceOi, peOi });

    const avgIv = meanOf(ceOwn, peOwn);
    // Strict '<' over ascending strikes keeps the lower strike on a tie.
    const dist = Math.abs(s.strike - F);
    if (dist < atmDist) { atmDist = dist; atmStrike = s.strike; atmIv = avgIv; }

    const sd = ce && pe ? straddle(ce, pe) : null;
    const gammas = { ce: ceA?.gamma ?? null, pe: peA?.gamma ?? null };
    partial.push({
      strike: s.strike,
      straddle: sd?.price ?? null, straddleBid: sd?.bid ?? null, straddleAsk: sd?.ask ?? null,
      strDecay: sd?.decay ?? null, strDecayPct: sd?.decayPct ?? null,
      cumOi: ceOi + peOi,
      avgIv,
      pcrOi: ce && pe ? pcr(pe.oi, ce.oi) : null,
      pcrVol: ce && pe ? pcr(pe.volume, ce.volume) : null,
      gexOiCr: gexCr(gammas, { ce: ceOi, pe: peOi }, spot),
      gexVolCr: gexCr(gammas, { ce: ce?.volume ?? 0, pe: pe?.volume ?? 0 }, spot),
    });
  }

  const mp = maxPain(painRows, 1, F);
  const strikes: StrikeAnalytics[] = partial.map((p) => {
    const pain = mp.painRs.get(p.strike);
    return { ...p, painCr: mp.maxPain === null || pain === undefined ? null : pain / 1e7 };
  });

  return {
    forward: F, forwardSource, T, atmStrike, atmIv,
    maxPain: mp.maxPain,
    pcrOi: pcr(peOiSum, ceOiSum),
    pcrVol: pcr(peVolSum, ceVolSum),
    cumOi: ceOiSum + peOiSum,
    legs, strikes,
  };
}
