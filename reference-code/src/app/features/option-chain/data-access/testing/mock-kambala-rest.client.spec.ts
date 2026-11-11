import { KambalaError, OrderLeg } from '../kambala/kambala.types';
import { MockKambalaRestClient } from './mock-kambala-rest.client';
import { MockMarket } from './mock-market';

const leg = (tsym: string, qty: number, prc: number, trantype: 'B' | 'S'): OrderLeg =>
  ({ exch: 'NFO', tsym, qty, prc, prctyp: 'LMT', trantype, prd: 'I' });

describe('MockKambalaRestClient orders', () => {
  let client: MockKambalaRestClient;

  beforeEach(() => {
    client = new MockKambalaRestClient(new MockMarket());
  });

  it('basket margin: each sell is strike × qty × 0.10, each buy is prc × qty, and a basket holding both a buy and a sell is charged 35 % of the sum', async () => {
    // sell only: 22850 * 65 * 0.10
    expect(await client.getBasketMargin([leg('NIFTY25NOV26C22850', 65, 100, 'S')])).toBe(148525);
    // buy only: 14.95 * 130
    expect(await client.getBasketMargin([leg('NIFTY25NOV26C22850', 130, 14.95, 'B')])).toBeCloseTo(1943.5, 6);
    // hedged: (148525 + 10 * 65) * 0.35
    const hedged = await client.getBasketMargin([
      leg('NIFTY25NOV26C22850', 65, 100, 'S'),
      leg('NIFTY25NOV26C23000', 65, 10, 'B'),
    ]);
    expect(hedged).toBeCloseTo((148525 + 650) * 0.35, 6);
  });

  it('placeOrder returns MOCK-prefixed increasing order numbers', async () => {
    expect(await client.placeOrder(leg('NIFTY25NOV26C22850', 65, 10, 'B'))).toBe('MOCK000001');
    expect(await client.placeOrder(leg('NIFTY25NOV26C22850', 65, 10, 'B'))).toBe('MOCK000002');
  });

  it('placeOrder rejects quantities above 1800 with "Quantity exceeds freeze limit"', async () => {
    const err = await client.placeOrder(leg('NIFTY25NOV26C22850', 1801, 10, 'B')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KambalaError);
    expect((err as Error).message).toBe('Quantity exceeds freeze limit');
    expect(await client.placeOrder(leg('NIFTY25NOV26C22850', 1800, 10, 'B'))).toBe('MOCK000001');
  });
});
