import { black76 } from './black76';
import { normPdf } from './normal';
import type { IvStatus, LegQuote, OptType } from './types';

const SIGMA_MIN = 0.001;
const SIGMA_MAX = 5.0;
const MAX_ITER = 100;
const EPS_INTRINSIC = 1e-9;

/** Mid if the quote is valid, else LTP when traded today, else null (§2.5). */
export function selectPrice(q: LegQuote): { price: number; source: 'MID' | 'LTP' } | null {
  const { bid, ask } = q;
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid && q.bidQty > 0 && q.askQty > 0) {
    const mid = (bid + ask) / 2;
    if (ask - bid <= Math.max(5 * q.tickSize, 0.1 * mid)) return { price: mid, source: 'MID' };
  }
  if (q.volume > 0 && q.ltp !== null && q.ltp > 0) return { price: q.ltp, source: 'LTP' };
  return null;
}

/** True when the price is below 0.50 or below 4 ticks. */
export function isLowConfidence(price: number, tickSize: number): boolean {
  return price < 0.5 || price < 4 * tickSize;
}

type Result = { iv: number | null; status: IvStatus; iterations: number };
const fail = (status: IvStatus, iterations = 0): Result => ({ iv: null, status, iterations });

/** Safeguarded Newton on the undiscounted price P' = price * e^{rT} (§2.3). Never returns a clamped sigma. */
export function solveIv(
  type: OptType, price: number, F: number, K: number, T: number, r: number, warm?: number,
): Result {
  if (!(price > 0) || !Number.isFinite(price) || !(F > 0) || !(K > 0)) return fail('NO_PRICE');
  if (!(T > 0)) return fail('NO_CONVERGENCE');

  const target = price * Math.exp(r * T);
  const intrinsic = type === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const upper = type === 'CE' ? F : K;
  if (target <= intrinsic + EPS_INTRINSIC) return fail('BELOW_INTRINSIC');
  if (target >= upper) return fail('ABOVE_MAX');

  const px = (s: number) => black76(type, F, K, T, 0, s).price;
  if (target < px(SIGMA_MIN)) return fail('BELOW_MIN_VOL');
  if (target > px(SIGMA_MAX)) return fail('ABOVE_MAX_VOL');

  const sqrtT = Math.sqrt(T);
  const lnFK = Math.log(F / K);
  let sigma: number;
  if (warm !== undefined && Number.isFinite(warm) && warm >= SIGMA_MIN && warm <= SIGMA_MAX) {
    sigma = warm;
  } else if (Math.abs(lnFK) < 0.02) {
    sigma = Math.min(3, Math.max(0.05, Math.sqrt((2 * Math.PI) / T) * (target / F)));
  } else {
    sigma = Math.min(3, Math.max(0.05, Math.sqrt((2 * Math.abs(lnFK)) / T)));
  }

  let lo = SIGMA_MIN, hi = SIGMA_MAX;
  for (let i = 1; i <= MAX_ITER; i++) {
    const { price: p, d1 } = black76(type, F, K, T, 0, sigma);
    const diff = p - target;
    if (Math.abs(diff) < 1e-8 * Math.max(1, target)) return { iv: sigma, status: 'OK', iterations: i };
    if (diff > 0) hi = sigma; else lo = sigma;
    const vega = F * normPdf(d1) * sqrtT;
    let next = sigma - diff / vega;
    if (vega < 1e-12 || !(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - sigma) < 1e-10) return { iv: next, status: 'OK', iterations: i };
    sigma = next;
  }
  return fail('NO_CONVERGENCE', MAX_ITER);
}
