import { normCdf, normPdf } from './normal';
import type { OptType } from './types';

export function black76(
  type: OptType, F: number, K: number, T: number, r: number, sigma: number,
): { price: number; d1: number; d2: number } {
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sd;
  const d2 = d1 - sd;
  const D = Math.exp(-r * T);
  const price = type === 'CE'
    ? D * (F * normCdf(d1) - K * normCdf(d2))
    : D * (K * normCdf(-d2) - F * normCdf(-d1));
  return { price, d1, d2 };
}

/** Delta and gamma are spot terms (dF/dS = F/S); theta holds F fixed, per calendar day; vega per 1 vol point. */
export function greeks(
  type: OptType, F: number, S: number, K: number, T: number, r: number, sigma: number,
): { delta: number; gamma: number; theta: number; vega: number; itmProb: number } {
  const { price, d1, d2 } = black76(type, F, K, T, r, sigma);
  const sqrtT = Math.sqrt(T);
  const D = Math.exp(-r * T);
  const nd1 = normPdf(d1);
  const k = F / S;
  const delta = type === 'CE' ? D * normCdf(d1) * k : -D * normCdf(-d1) * k;
  const gamma = ((D * nd1) / (F * sigma * sqrtT)) * k * k;
  const theta = ((-D * F * nd1 * sigma) / (2 * sqrtT) + r * price) / 365;
  const vega = (D * F * nd1 * sqrtT) / 100;
  const itmProb = type === 'CE' ? normCdf(d2) : normCdf(-d2);
  return { delta, gamma, theta, vega, itmProb };
}
