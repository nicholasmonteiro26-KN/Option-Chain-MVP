import type { ChainInput } from '../analyze';
import { black76 } from '../black76';
import { DEFAULT_CONFIG } from '../config';
import { expiryInstantMs, yearsToExpiry } from '../time';
import type { LegQuote, OptType, StrikeQuotes } from '../types';

export const SAMPLE_SPOT = 24978.5;
export const SAMPLE_EXPIRY = '2026-11-03';
export const SAMPLE_NOW_MS = Date.parse('2026-10-29T10:00:00+05:30');
export const SAMPLE_LOT = 65;
export const SAMPLE_TICK = 0.05;
export const SAMPLE_STEP = 50;
const HALF_SPREAD = 0.05;

export interface SampleChainOpts {
  /** Number of strikes, centred on 25000 with step 50 (default 21: 24500..25500). */
  strikeCount?: number;
  /** Clock put on the input (default SAMPLE_NOW_MS). Prices are always generated at SAMPLE_NOW_MS. */
  nowMs?: number;
  /** Patch one leg after generation. */
  override?: { strike: number; type: OptType; patch: Partial<LegQuote> };
}

/** The generating forward: spot carried at r from SAMPLE_NOW_MS to expiry. */
export function sampleForward(): number {
  const T = yearsToExpiry(SAMPLE_NOW_MS, expiryInstantMs(SAMPLE_EXPIRY));
  return SAMPLE_SPOT * Math.exp(DEFAULT_CONFIG.riskFreeRate * T);
}

/** Generating smile: sigma(K) = 0.12 + 0.6 x^2 - 0.05 x, with x = ln(K/F). */
export function sampleSigma(K: number, F = sampleForward()): number {
  const x = Math.log(K / F);
  return 0.12 + 0.6 * x * x - 0.05 * x;
}

export const sampleToken = (type: OptType, strike: number): string => `${type}${strike}`;

/**
 * A NIFTY chain priced with Black-76 at a known forward and smile. bid/ask = price -/+ 0.05 (qty 65), so the
 * mid is the model price and put-call parity recovers F exactly. Legs whose price is <= 0.05 (only in long
 * chains) get no quote and trade on LTP. Returns the generating sigma per token alongside the input.
 */
export function sampleChainWithSigma(opts: SampleChainOpts = {}): { input: ChainInput; sigma: Record<string, number> } {
  const n = opts.strikeCount ?? 21;
  const r = DEFAULT_CONFIG.riskFreeRate;
  const T = yearsToExpiry(SAMPLE_NOW_MS, expiryInstantMs(SAMPLE_EXPIRY));
  const F = sampleForward();
  const first = 25000 - SAMPLE_STEP * Math.floor((n - 1) / 2);
  const sigma: Record<string, number> = {};
  const strikes: StrikeQuotes[] = [];

  for (let i = 0; i < n; i++) {
    const K = first + i * SAMPLE_STEP;
    const s = sampleSigma(K, F);
    const mk = (type: OptType): LegQuote => {
      const price = black76(type, F, K, T, r, s).price;
      const token = sampleToken(type, K);
      sigma[token] = s;
      // OI peaks ~150 points OTM on each side; CE OI rose today, PE OI fell.
      const otm = type === 'CE' ? K - F : F - K;
      const oi = 65 * (Math.round(30_000 * Math.exp(-(((otm - 150) / 500) ** 2))) + 100 + i);
      const prevOi = 65 * Math.round((oi / 65) * (type === 'CE' ? 0.9 : 1.1));
      const quoted = price - HALF_SPREAD > 0;
      return {
        token, type, strike: K, lotSize: SAMPLE_LOT, tickSize: SAMPLE_TICK,
        ltp: price,
        bid: quoted ? price - HALF_SPREAD : null,
        ask: quoted ? price + HALF_SPREAD : null,
        bidQty: quoted ? SAMPLE_LOT : 0,
        askQty: quoted ? SAMPLE_LOT : 0,
        volume: oi * 3,
        oi, prevOi,
        // CE fell on the day, PE rose.
        prevClose: price * (type === 'CE' ? 1.08 : 0.95),
        open: price, high: price * 1.1, low: price * 0.9, lastTickMs: SAMPLE_NOW_MS,
      };
    };
    strikes.push({ strike: K, ce: mk('CE'), pe: mk('PE') });
  }

  const o = opts.override;
  if (o) {
    const row = strikes.find((x) => x.strike === o.strike);
    const key = o.type === 'CE' ? 'ce' : 'pe';
    const leg = row?.[key];
    if (!row || !leg) throw new Error(`sampleChain: no ${o.type} leg at ${o.strike}`);
    row[key] = { ...leg, ...o.patch };
  }

  return {
    sigma,
    input: {
      spot: SAMPLE_SPOT, futuresPrice: null, strikes, expiryIso: SAMPLE_EXPIRY,
      nowMs: opts.nowMs ?? SAMPLE_NOW_MS, prevForward: null, prevIv: {}, config: { ...DEFAULT_CONFIG },
    },
  };
}

export function sampleChain(opts: SampleChainOpts = {}): ChainInput {
  return sampleChainWithSigma(opts).input;
}

/** Generating sigma per token for the default 21-strike chain. */
export const SAMPLE_SIGMA: Readonly<Record<string, number>> = Object.freeze(sampleChainWithSigma().sigma);
