import { selectPrice } from './iv';
import { nearestStrikeIndex } from './strikes';
import type { ForwardSource, LegQuote, StrikeQuotes } from './types';

const MAX_DEV = 0.03;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Forward from put-call parity (§1.3), with ordered fallbacks and a 3 % sanity check against spot. */
export function estimateForward(args: {
  spot: number; futuresPrice: number | null; strikes: StrikeQuotes[]; T: number; r: number;
  prevForward: number | null; eachSide: number;
}): { forward: number; source: ForwardSource } {
  const { spot, futuresPrice, T, r, prevForward, eachSide } = args;
  const carry = Math.exp(r * T);
  const sane = (f: number) => Number.isFinite(f) && f > 0 && Math.abs(f / spot - 1) <= MAX_DEV;

  const sorted = [...args.strikes].sort((a, b) => a.strike - b.strike);
  let window: StrikeQuotes[] = [];
  if (sorted.length > 0) {
    const ci = nearestStrikeIndex(sorted.map((s) => s.strike), prevForward ?? spot);
    window = sorted.slice(Math.max(0, ci - eachSide), ci + eachSide + 1);
  }

  const parity = (price: (q: LegQuote) => number | null): number | null => {
    const fs: number[] = [];
    for (const s of window) {
      if (!s.ce || !s.pe) continue;
      const c = price(s.ce), p = price(s.pe);
      if (c === null || p === null) continue;
      fs.push(s.strike + carry * (c - p));
    }
    return fs.length > 0 ? median(fs) : null;
  };

  const mid = (q: LegQuote) => { const p = selectPrice(q); return p && p.source === 'MID' ? p.price : null; };
  const ltp = (q: LegQuote) => (q.volume > 0 && q.ltp !== null && q.ltp > 0 ? q.ltp : null);

  const fMid = parity(mid);
  if (fMid !== null && sane(fMid)) return { forward: fMid, source: 'PARITY_MID' };
  if (futuresPrice !== null && futuresPrice > 0 && sane(futuresPrice)) return { forward: futuresPrice, source: 'FUTURES' };
  const fLtp = parity(ltp);
  if (fLtp !== null && sane(fLtp)) return { forward: fLtp, source: 'PARITY_LTP' };
  return { forward: spot * carry, source: 'SPOT_CARRY' };
}
