export const MAX_LEGS = 10;
export type Product = 'I' | 'M';
export type LegResult =
  | { status: 'placed'; orderNo: string }
  | { status: 'rejected'; reason: string }
  | { status: 'not-sent' };

/** A contract as offered by the chain or a picker. */
export interface LegContract {
  /** Feed key "EXCH|token", e.g. "NFO|43651". */
  token: string;
  tsym: string;
  exch: string;
  expiryIso: string;
  strike: number;
  type: 'CE' | 'PE';
  lotSize: number;
  /** Price step of the contract (Kambala `ti`); 0.05 when unknown (e.g. legs stored before it was kept). */
  tickSize?: number;
  ltp: number | null;
}

export const DEFAULT_TICK = 0.05;

/** Why a market leg on BFO is never sent (BFO market orders need mkt_protection, not agreed yet). */
export const BFO_MKT = 'Market orders are not available on BFO. Use a limit price.';

/** A market order on BFO: the panel blocks Execute all and `executeStrategy` never sends it. */
export function isBfoMarket(leg: Pick<StrategyLeg, 'exch' | 'priceType'>): boolean {
  return leg.exch === 'BFO' && leg.priceType === 'MKT';
}

/** Execute all may send this leg: included and not already placed (a placed leg is never sent again). */
export function isSendable(leg: Pick<StrategyLeg, 'included' | 'result'>): boolean {
  return leg.included && leg.result?.status !== 'placed';
}

/** `price` rounded to the nearest multiple of `tick` (Kambala rejects off-tick limit prices). */
export function roundToTick(price: number, tick: number = DEFAULT_TICK): number {
  const t = tick > 0 ? tick : DEFAULT_TICK;
  return Number((Math.round(price / t) * t).toFixed(6));
}

/** One order result as a short line, e.g. "Placed #26110900123", "Rejected: RMS: insufficient margin". */
export function resultText(r: LegResult): string {
  switch (r.status) {
    case 'placed': return r.orderNo ? `Placed #${r.orderNo}` : 'Placed (order no. unavailable)';
    case 'rejected': return `Rejected: ${r.reason}`;
    default: return 'Not sent';
  }
}

export interface StrategyLeg extends Omit<LegContract, 'ltp'> {
  id: string;
  side: 'B' | 'S';
  lots: number;
  priceType: 'LMT' | 'MKT';
  price: number;
  included: boolean;
  result?: LegResult;
}

export interface Strategy {
  legs: StrategyLeg[];
  lotMultiplier: number;
  product: Product;
}

export type LegEdit = Partial<Pick<StrategyLeg, 'side' | 'lots' | 'priceType' | 'price' | 'included'>>;


/** lots × lotMultiplier × lotSize */
export function legQty(leg: StrategyLeg, lotMultiplier: number): number {
  return leg.lots * lotMultiplier * leg.lotSize;
}

/** Σ over included legs of (S ? +1 : −1) × px × qty; px = live[feed key] for MKT (falls back to price), else price. */
export function netPremium(s: Strategy, live: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const leg of s.legs) {
    if (!leg.included) continue;
    const px = leg.priceType === 'MKT' ? (live.get(leg.token) ?? leg.price) : leg.price;
    sum += (leg.side === 'S' ? 1 : -1) * px * legQty(leg, s.lotMultiplier);
  }
  return sum;
}
