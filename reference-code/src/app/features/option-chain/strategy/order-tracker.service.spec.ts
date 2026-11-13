import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { FEED_TRANSPORT } from '../data-access/feed/transport';
import { KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { OrderStatusRow, SessionExpiredError } from '../data-access/kambala/kambala.types';
import { OrderTracker, TRACK_FAST_MS, TRACK_SLOW_MS } from './order-tracker.service';
import { isOpenOrder, isRetryable, resultText, StrategyLeg, toOrderState } from './strategy.models';
import { StrategyStore } from './strategy.store';

describe('toOrderState (SingleOrdHist / WS om → Open, Partly filled, Filled, Rejected, Cancelled)', () => {
  it.each([
    [{ status: 'OPEN', qty: '130', fillshares: '0' }, 'open', 0],
    [{ status: 'PENDING', qty: '130' }, 'open', 0],
    [{ status: 'New', qty: '130' }, 'open', 0], // WS spelling
    [{ status: 'OPEN', qty: '130', fillshares: '65', avgprc: '12.30' }, 'partial', 65],
    [{ status: 'COMPLETE', qty: '130', fillshares: '130', avgprc: '12.30' }, 'filled', 130],
    [{ status: 'Complete', qty: '130' }, 'filled', 130], // no fillshares: the whole order
    [{ status: 'REJECTED', qty: '130', rejreason: 'RMS: margin exceeds' }, 'rejected', 0],
    [{ status: 'CANCELED', qty: '130', fillshares: '65' }, 'cancelled', 65],
    [{ status: 'SOMETHING_NEW', qty: '130' }, 'open', 0],
  ])('%o → %s', (row, phase, filled) => {
    const o = toOrderState(row as OrderStatusRow);
    expect(o.phase).toBe(phase);
    expect(o.filledQty).toBe(filled);
  });

  it('keeps the rejection reason and the average price', () => {
    expect(toOrderState({ status: 'REJECTED', rejreason: 'RMS: margin exceeds' }).reason).toBe('RMS: margin exceeds');
    expect(toOrderState({ status: 'COMPLETE', qty: '65', fillshares: '65', avgprc: '12.30' }).avgPrice).toBe(12.3);
  });
});

describe('isRetryable / isOpenOrder / resultText with order states', () => {
  const placed = (order?: ReturnType<typeof toOrderState>): Pick<StrategyLeg, 'result'> =>
    ({ result: { status: 'placed', orderNo: '7', ...(order ? { order } : {}) } });
  it('retries rejected, not sent and cancelled-unfilled legs; never filled or partly filled ones', () => {
    expect(isRetryable({ result: { status: 'rejected', reason: 'x' } })).toBe(true);
    expect(isRetryable({ result: { status: 'not-sent' } })).toBe(true);
    expect(isRetryable(placed(toOrderState({ status: 'REJECTED', qty: '65' })))).toBe(true);
    expect(isRetryable(placed(toOrderState({ status: 'CANCELED', qty: '65', fillshares: '0' })))).toBe(true);
    expect(isRetryable(placed(toOrderState({ status: 'CANCELED', qty: '130', fillshares: '65' })))).toBe(false);
    expect(isRetryable(placed(toOrderState({ status: 'COMPLETE', qty: '65' })))).toBe(false);
    expect(isRetryable(placed())).toBe(false);
    expect(isRetryable({})).toBe(false);
  });

  it('an order is open until it is final', () => {
    expect(isOpenOrder(placed())).toBe(true);
    expect(isOpenOrder(placed(toOrderState({ status: 'OPEN', qty: '130', fillshares: '65' })))).toBe(true);
    expect(isOpenOrder(placed(toOrderState({ status: 'COMPLETE', qty: '65' })))).toBe(false);
    expect(isOpenOrder({ result: { status: 'placed', orderNo: '' } })).toBe(false); // nothing to cancel by
  });

  it('row results read the order state', () => {
    const r = (row: OrderStatusRow) => resultText({ status: 'placed', orderNo: '7', order: toOrderState(row) });
    expect(r({ status: 'COMPLETE', qty: '65' })).toBe('Filled #7');
    expect(r({ status: 'OPEN', qty: '130', fillshares: '65' })).toBe('Partly filled 65/130 #7');
    expect(r({ status: 'CANCELED', qty: '130', fillshares: '65' })).toBe('Partly filled 65/130, rest cancelled #7');
    expect(r({ status: 'REJECTED', rejreason: 'RMS' })).toBe('Rejected: RMS');
  });
});

describe('OrderTracker', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(orderStatus: (no: string) => Promise<OrderStatusRow>) {
    const messages = new Subject<object>();
    const timers: { cb: () => void; ms: number; live: boolean }[] = [];
    const setOrderState = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        OrderTracker,
        { provide: CHAIN_FEED_CLOCK, useValue: () => 0 },
        {
          provide: CHAIN_FEED_SCHEDULER,
          useValue: (cb: () => void, ms: number) => {
            const t = { cb, ms, live: true };
            timers.push(t);
            return () => { t.live = false; };
          },
        },
        { provide: FEED_TRANSPORT, useValue: { messages: messages.asObservable() } },
        { provide: KambalaRestClient, useValue: { orderStatus: vi.fn(orderStatus) } },
        { provide: StrategyStore, useValue: { setOrderState } },
      ],
    });
    const tracker = TestBed.inject(OrderTracker);
    const fire = async (): Promise<void> => {
      const t = timers.find((x) => x.live)!;
      t.live = false;
      t.cb();
      await new Promise((r) => setTimeout(r));
    };
    return { tracker, messages, timers, setOrderState, fire };
  }

  it('checks placed orders now and every 2 s until each is final, then stops', async () => {
    let calls = 0;
    const { tracker, timers, setOrderState, fire } = setup(async (no) =>
      (++calls <= 1 ? { norenordno: no, status: 'OPEN', qty: '65' } : { norenordno: no, status: 'COMPLETE', qty: '65' }));
    tracker.track('NSE|26000', [{ legId: 'leg-1', orderNo: '7' }]);
    await new Promise((r) => setTimeout(r));
    expect(setOrderState).toHaveBeenLastCalledWith('NSE|26000', 'leg-1', expect.objectContaining({ phase: 'open' }));
    expect(timers.filter((t) => t.live).map((t) => t.ms)).toEqual([TRACK_FAST_MS]);
    await fire();
    expect(setOrderState).toHaveBeenLastCalledWith('NSE|26000', 'leg-1', expect.objectContaining({ phase: 'filled' }));
    expect(tracker.size).toBe(0);
    expect(timers.filter((t) => t.live)).toHaveLength(0);
    expect(TRACK_SLOW_MS).toBeGreaterThan(TRACK_FAST_MS);
  });

  it('applies a WS order update (t: "om") for a followed order at once', async () => {
    const { tracker, messages, setOrderState } = setup(async (no) => ({ norenordno: no, status: 'OPEN', qty: '65' }));
    tracker.track('K', [{ legId: 'leg-2', orderNo: '9' }]);
    await new Promise((r) => setTimeout(r));
    messages.next({ t: 'om', norenordno: '9', status: 'Rejected', qty: '65', rejreason: 'RMS' });
    expect(setOrderState).toHaveBeenLastCalledWith('K', 'leg-2', expect.objectContaining({ phase: 'rejected', reason: 'RMS' }));
    messages.next({ t: 'om', norenordno: '404', status: 'Complete' }); // not ours
    expect(setOrderState).toHaveBeenCalledTimes(2);
    expect(tracker.size).toBe(0);
  });

  it('a session expiry stops following (the page handles the re-login); other errors keep trying', async () => {
    let fail: Error = new Error('network');
    const { tracker, timers, fire } = setup(async () => { throw fail; });
    tracker.track('K', [{ legId: 'leg-1', orderNo: '7' }]);
    await new Promise((r) => setTimeout(r));
    expect(tracker.size).toBe(1);
    expect(timers.some((t) => t.live)).toBe(true);
    fail = new SessionExpiredError();
    await fire();
    expect(tracker.size).toBe(0);
    expect(timers.some((t) => t.live)).toBe(false);
  });
});
