import type { KambalaRestApi } from '../kambala/kambala-rest.client';
import { KambalaError } from '../kambala/kambala.types';
import type {
  IndexListEntry, LinkedScripsResponse, OptionChainRow, OrderLeg, OrderStatusRow, ScripSearchResult,
} from '../kambala/kambala.types';
import { QUICK_UNDERLYINGS } from '../models';
import type { MockMarket } from './mock-market';

/** The mock exchange's per-order quantity limit. */
const MOCK_FREEZE_QTY = 1800;

/** Same public API as `KambalaRestClient`, answered from a `MockMarket` (for `?feed=mock`). */
export class MockKambalaRestClient implements KambalaRestApi {
  private orderSeq = 0;
  /** Mock orders: a market order fills at once; a limit order is open on the first status check, filled after. */
  private readonly orders = new Map<string, { leg: OrderLeg; checks: number; cancelled: boolean }>();

  constructor(private readonly market: MockMarket) {}

  getLinkedScrips(exch: string, token: string): Promise<LinkedScripsResponse> {
    return Promise.resolve(this.market.linkedScrips(exch, token));
  }

  getOptionChain(exch: string, tsym: string, strprc: number, cnt: number): Promise<OptionChainRow[]> {
    return Promise.resolve(this.market.optionChain(exch, tsym, strprc, cnt));
  }

  searchScrip(text: string): Promise<ScripSearchResult[]> {
    return Promise.resolve(this.market.search(text));
  }

  /**
   * Fake margin: a sell costs strike × qty × 0.10, a buy costs prc × qty; a basket with both a buy and a sell is
   * charged 35 % of the sum (a hedge discount).
   */
  getBasketMargin(legs: OrderLeg[]): Promise<number> {
    let sum = 0;
    for (const l of legs) {
      // Mock tsyms end in C/P + strike, e.g. NIFTY25NOV26C22850.
      const strike = Number(/[CP]([\d.]+)$/.exec(l.tsym)?.[1] ?? 0);
      sum += l.trantype === 'S' ? (strike * l.qty) / 10 : l.prc * l.qty;
    }
    const hedged = legs.some((l) => l.trantype === 'B') && legs.some((l) => l.trantype === 'S');
    return Promise.resolve(hedged ? sum * 0.35 : sum);
  }

  placeOrder(leg: OrderLeg): Promise<string> {
    if (leg.qty > MOCK_FREEZE_QTY) return Promise.reject(new KambalaError('Quantity exceeds freeze limit'));
    const no = `MOCK${String(++this.orderSeq).padStart(6, '0')}`;
    this.orders.set(no, { leg, checks: 0, cancelled: false });
    return Promise.resolve(no);
  }

  orderStatus(norenordno: string): Promise<OrderStatusRow> {
    const o = this.orders.get(norenordno);
    if (!o) return Promise.reject(new KambalaError('Order not found'));
    o.checks++;
    const qty = String(o.leg.qty);
    if (o.cancelled) return Promise.resolve({ norenordno, status: 'CANCELED', qty, fillshares: '0', cancelqty: qty });
    if (o.leg.prctyp === 'LMT' && o.checks < 2) return Promise.resolve({ norenordno, status: 'OPEN', qty, fillshares: '0' });
    return Promise.resolve({ norenordno, status: 'COMPLETE', qty, fillshares: qty, avgprc: o.leg.prc.toFixed(2) });
  }

  cancelOrder(norenordno: string): Promise<void> {
    const o = this.orders.get(norenordno);
    if (!o) return Promise.reject(new KambalaError('Order not found to cancel'));
    if (o.leg.prctyp === 'LMT' && o.checks < 2) o.cancelled = true;
    else return Promise.reject(new KambalaError('Order is already complete'));
    return Promise.resolve();
  }

  /** The quick underlyings' built-in tokens, named as Kambala names them ("Nifty 50", "SENSEX"). */
  getIndexList(exch: string): Promise<IndexListEntry[]> {
    const names: Record<string, string> = { NIFTY: 'Nifty 50', SENSEX: 'SENSEX' };
    return Promise.resolve(
      QUICK_UNDERLYINGS.filter((u) => u.exch === exch).map((u) => ({ idxname: names[u.sym] ?? u.name, token: u.token })),
    );
  }
}
