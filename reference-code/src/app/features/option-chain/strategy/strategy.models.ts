export const MAX_LEGS = 10;
export type Product = 'I' | 'M';
/** Where a placed order stands at the exchange (from SingleOrdHist or a WS order update). */
export type OrderPhase = 'open' | 'partial' | 'filled' | 'rejected' | 'cancelled';
export interface OrderState {
  phase: OrderPhase;
  qty: number;
  filledQty: number;
  avgPrice: number | null;
  /** Kambala's rejection reason, for `rejected`. */
  reason?: string;
}
/** Final: the order will not change any more (no need to keep checking). */
export const isFinalPhase = (p: OrderPhase): boolean => p === 'filled' || p === 'rejected' || p === 'cancelled';

/** A SingleOrdHist row / WS `om` update as an OrderState. Unknown statuses count as open. */
export function toOrderState(row: { status?: string; qty?: string; fillshares?: string; avgprc?: string; rejreason?: string }): OrderState {
  const n = (v: string | undefined): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  const qty = n(row.qty);
  const filledQty = n(row.fillshares);
  const avg = n(row.avgprc);
  const avgPrice = filledQty > 0 && avg > 0 ? avg : null;
  const st = (row.status ?? '').toUpperCase();
  if (st === 'COMPLETE') return { phase: 'filled', qty, filledQty: filledQty || qty, avgPrice };
  if (st === 'REJECTED') return { phase: 'rejected', qty, filledQty: 0, avgPrice: null, reason: row.rejreason || 'Rejected by the exchange' };
  if (st === 'CANCELED' || st === 'CANCELLED') return { phase: 'cancelled', qty, filledQty, avgPrice };
  return { phase: filledQty > 0 ? 'partial' : 'open', qty, filledQty, avgPrice };
}

export type LegResult =
  | { status: 'placed'; orderNo: string; order?: OrderState }
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
  /** Best bid / ask when known: a new limit leg is priced where it would trade now (see `entryPrice`). */
  bid?: number | null;
  ask?: number | null;
}

export const DEFAULT_TICK = 0.05;

/** Why a market leg on BFO is never sent (BFO market orders need mkt_protection, not agreed yet). */
export const BFO_MKT = 'Market orders are not available on BFO. Use a limit price.';

/** A market order on BFO: the panel blocks Execute all and `executeStrategy` never sends it. */
export function isBfoMarket(leg: Pick<StrategyLeg, 'exch' | 'priceType'>): boolean {
  return leg.exch === 'BFO' && leg.priceType === 'MKT';
}

/**
 * Retry failed legs may send this leg again: rejected or not sent, or placed and then rejected or cancelled with
 * nothing filled. A partly filled order is never retried (the rest is handled in the order book).
 */
export function isRetryable(leg: Pick<StrategyLeg, 'result'>): boolean {
  const r = leg.result;
  if (!r) return false;
  if (r.status !== 'placed') return true;
  const o = r.order;
  return !!o && (o.phase === 'rejected' || (o.phase === 'cancelled' && o.filledQty === 0));
}

/** A placed order that can still fill (open or partly filled): Cancel open orders applies to it. */
export function isOpenOrder(leg: Pick<StrategyLeg, 'result'>): boolean {
  const r = leg.result;
  return r?.status === 'placed' && !!r.orderNo && (!r.order || r.order.phase === 'open' || r.order.phase === 'partial');
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
    case 'placed': {
      if (!r.orderNo) return 'Placed (order no. unavailable)';
      const o = r.order;
      if (!o) return `Placed #${r.orderNo}`;
      switch (o.phase) {
        case 'filled': return `Filled #${r.orderNo}`;
        case 'open': return `Open #${r.orderNo}`;
        case 'partial': return `Partly filled ${o.filledQty}/${o.qty} #${r.orderNo}`;
        case 'rejected': return `Rejected: ${o.reason ?? 'by the exchange'}`;
        default:
          return o.filledQty > 0
            ? `Partly filled ${o.filledQty}/${o.qty}, rest cancelled #${r.orderNo}`
            : `Cancelled #${r.orderNo}`;
      }
    }
    case 'rejected': return `Rejected: ${r.reason}`;
    default: return 'Not sent';
  }
}

/**
 * Default limit price for a leg: what it would trade at now — the best ask for a buy, the best bid for a sell — else
 * the last traded price, else 0 ("waiting for a price"). Rounded to the contract's tick.
 */
export function entryPrice(
  side: 'B' | 'S', q: { ltp?: number | null; bid?: number | null; ask?: number | null }, tick?: number,
): number {
  const touch = side === 'B' ? q.ask : q.bid;
  const px = touch != null && touch > 0 ? touch : q.ltp != null && q.ltp > 0 ? q.ltp : 0;
  return px > 0 ? roundToTick(px, tick) : 0;
}

/** Buy legs first, then sells, each in the order they were added (the order Execute all sends them in). */
export function buysFirst<T extends { side: 'B' | 'S' }>(legs: readonly T[]): T[] {
  return [...legs.filter((l) => l.side === 'B'), ...legs.filter((l) => l.side === 'S')];
}

export interface StrategyLeg extends Omit<LegContract, 'ltp' | 'bid' | 'ask'> {
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
