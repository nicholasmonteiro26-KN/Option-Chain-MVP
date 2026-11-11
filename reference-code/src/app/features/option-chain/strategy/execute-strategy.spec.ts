import { KambalaError, OrderLeg } from '../data-access/kambala/kambala.types';
import { executeStrategy } from './execute-strategy';
import { LegResult, Strategy, StrategyLeg } from './strategy.models';

const leg = (id: string, side: 'B' | 'S', over: Partial<StrategyLeg> = {}): StrategyLeg => ({
  id, side, lots: 1, priceType: 'LMT', price: 100, included: true,
  token: `NFO|${id}`, tsym: `SYM-${id}`, exch: 'NFO', expiryIso: '2026-11-25', strike: 23000, type: 'CE', lotSize: 65,
  ...over,
});

const strat = (legs: StrategyLeg[]): Strategy => ({ legs, lotMultiplier: 2, product: 'M' });
const live = new Map<string, number>();

describe('executeStrategy', () => {
  it('places buys before sells, keeping listed order within each group', async () => {
    const seen: string[] = [];
    const s = strat([leg('S1', 'S'), leg('B1', 'B'), leg('S2', 'S'), leg('B2', 'B')]);
    const res = await executeStrategy(s, live, async (o: OrderLeg) => {
      seen.push(o.tsym);
      return `ord-${o.tsym}`;
    });
    expect(seen).toEqual(['SYM-B1', 'SYM-B2', 'SYM-S1', 'SYM-S2']);
    expect(res.get('S1')).toEqual({ status: 'placed', orderNo: 'ord-SYM-S1' });
    expect(res.size).toBe(4);
  });

  it('never re-sends a leg already placed, even if it is included', async () => {
    const sent: string[] = [];
    const s = strat([leg('B1', 'B', { result: { status: 'placed', orderNo: 'old' } }), leg('S1', 'S')]);
    const res = await executeStrategy(s, live, async (o) => { sent.push(o.tsym); return 'n2'; });
    expect(sent).toEqual(['SYM-S1']);
    expect(res.has('B1')).toBe(false);
  });

  it('a BFO market order is never sent: rejected with a reason, the rest not-sent', async () => {
    const sent: string[] = [];
    const s = strat([leg('B1', 'B', { exch: 'BFO', priceType: 'MKT' }), leg('S1', 'S')]);
    const res = await executeStrategy(s, live, async (o) => { sent.push(o.tsym); return 'n'; });
    expect(sent).toEqual([]);
    expect(res.get('B1')).toEqual({ status: 'rejected', reason: 'Market orders are not available on BFO. Use a limit price.' });
    expect(res.get('S1')).toEqual({ status: 'not-sent' });
  });

  it('an order number that is missing comes back as an empty string, never undefined', async () => {
    const res = await executeStrategy(strat([leg('B1', 'B')]), live, async () => undefined as unknown as string);
    expect(res.get('B1')).toEqual({ status: 'placed', orderNo: '' });
  });

  it('once cancelled (page gone), sends no further leg: the rest not-sent', async () => {
    let cancelled = false;
    const sent: string[] = [];
    const s = strat([leg('S1', 'S'), leg('B1', 'B'), leg('B2', 'B')]);
    const res = await executeStrategy(s, live, async (o: OrderLeg) => {
      sent.push(o.tsym);
      cancelled = true; // e.g. the page is destroyed while this order is in flight
      return 'n1';
    }, undefined, () => cancelled);
    expect(sent).toEqual(['SYM-B1']);
    expect(res.get('B1')).toEqual({ status: 'placed', orderNo: 'n1' });
    expect(res.get('B2')).toEqual({ status: 'not-sent' });
    expect(res.get('S1')).toEqual({ status: 'not-sent' });
  });

  it('stops at the first rejection: that leg rejected with emsg, the rest not-sent, earlier ones placed', async () => {
    const s = strat([leg('S1', 'S'), leg('B1', 'B'), leg('B2', 'B'), leg('S2', 'S')]);
    const place = jasmineOrVitestFn(async (o: OrderLeg) => {
      if (o.tsym === 'SYM-B2') throw new KambalaError('Insufficient funds');
      return 'n1';
    });
    const res = await executeStrategy(s, live, place.fn);
    expect(res.get('B1')).toEqual({ status: 'placed', orderNo: 'n1' });
    expect(res.get('B2')).toEqual({ status: 'rejected', reason: 'Insufficient funds' });
    expect(res.get('S1')).toEqual({ status: 'not-sent' });
    expect(res.get('S2')).toEqual({ status: 'not-sent' });
    expect(place.calls).toBe(2);
  });

  it('uses a safe reason for a thrown non-Kambala error', async () => {
    const res = await executeStrategy(strat([leg('B1', 'B')]), live, async () => {
      throw new Error('secret token abc');
    });
    expect(res.get('B1')).toEqual({
      status: 'rejected',
      reason: 'Could not place the order. Check the order book before retrying.',
    });
  });

  it('excluded legs are not placed and get no result', async () => {
    const seen: string[] = [];
    const s = strat([leg('B1', 'B', { included: false }), leg('B2', 'B')]);
    const res = await executeStrategy(s, live, async (o) => {
      seen.push(o.tsym);
      return 'x';
    });
    expect(seen).toEqual(['SYM-B2']);
    expect(res.has('B1')).toBe(false);
    expect(res.size).toBe(1);
  });

  it('MKT legs are sent with prctyp MKT and prc 0', async () => {
    const sent: OrderLeg[] = [];
    const s = strat([leg('B1', 'B', { priceType: 'MKT', price: 55 })]);
    await executeStrategy(s, new Map([['NFO|B1', 57]]), async (o) => {
      sent.push(o);
      return 'x';
    });
    expect(sent[0]!.prctyp).toBe('MKT');
    expect(sent[0]!.prc).toBe(0);
    expect(sent[0]!.qty).toBe(130);
    expect(sent[0]!.prd).toBe('M');
  });

  it('onProgress is called after each leg with the results so far', async () => {
    const snaps: ReadonlyMap<string, LegResult>[] = [];
    const s = strat([leg('B1', 'B'), leg('B2', 'B')]);
    await executeStrategy(s, live, async () => 'x', (r) => snaps.push(new Map(r)));
    expect(snaps.length).toBe(2);
    expect([...snaps[0]!.keys()]).toEqual(['B1']);
    expect([...snaps[1]!.keys()]).toEqual(['B1', 'B2']);
  });
});

function jasmineOrVitestFn(impl: (o: OrderLeg) => Promise<string>) {
  const state = { calls: 0 };
  return {
    fn: (o: OrderLeg) => {
      state.calls++;
      return impl(o);
    },
    get calls() {
      return state.calls;
    },
  };
}
