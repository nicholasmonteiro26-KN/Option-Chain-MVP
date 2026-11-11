import { KambalaError, OrderLeg } from '../data-access/kambala/kambala.types';
import { toOrderLeg } from './strategy-margin.service';
import { BFO_MKT, isBfoMarket, isSendable, LegResult, Strategy } from './strategy.models';

const UNKNOWN_FAILURE = 'Could not place the order. Check the order book before retrying.';
export { BFO_MKT };

/**
 * Places the included legs one at a time: buys first, then sells, each group in listed order. Stops at the first
 * rejection: that leg is `rejected`, every later leg `not-sent`, earlier legs stay `placed`.
 * Results are keyed by leg id (included legs only). `onProgress` gets a snapshot after each leg. Once `cancelled()`
 * is true (e.g. the page is gone) no further leg is sent: the rest are `not-sent`.
 */
export async function executeStrategy(
  s: Strategy,
  live: ReadonlyMap<string, number>,
  place: (o: OrderLeg) => Promise<string>,
  onProgress?: (r: ReadonlyMap<string, LegResult>) => void,
  cancelled: () => boolean = () => false,
): Promise<Map<string, LegResult>> {
  // A leg already placed is never sent again (the store also takes it out of the strategy).
  const included = s.legs.filter(isSendable);
  const ordered = [...included.filter((l) => l.side === 'B'), ...included.filter((l) => l.side === 'S')];
  const results = new Map<string, LegResult>();
  let halted = false;

  for (const leg of ordered) {
    if (halted || cancelled()) {
      results.set(leg.id, { status: 'not-sent' });
    } else if (isBfoMarket(leg)) {
      // BFO market orders need mkt_protection (not agreed yet): never sent as MKT.
      halted = true;
      results.set(leg.id, { status: 'rejected', reason: BFO_MKT });
    } else {
      try {
        const orderNo: unknown = await place(toOrderLeg(leg, s, live.get(leg.token) ?? null, false));
        results.set(leg.id, { status: 'placed', orderNo: typeof orderNo === 'string' ? orderNo : '' });
      } catch (e) {
        halted = true;
        results.set(leg.id, { status: 'rejected', reason: e instanceof KambalaError ? e.message : UNKNOWN_FAILURE });
      }
    }
    onProgress?.(new Map(results));
  }
  return results;
}
