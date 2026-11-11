import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { OrderLeg } from '../data-access/kambala/kambala.types';
import { OPTION_CHAIN_USER_ID } from '../feature-shell/option-chain.providers';
import { MARGIN_DEBOUNCE_MS, StrategyMarginService, toOrderLeg } from './strategy-margin.service';
import { LegContract, Strategy, StrategyLeg } from './strategy.models';
import { StrategyStore } from './strategy.store';

interface Pending {
  legs: OrderLeg[];
  resolve: (n: number) => void;
  reject: (e: unknown) => void;
}

const contract = (token: string, tsym: string, lotSize = 65): LegContract => ({
  token, tsym, exch: 'NFO', expiryIso: '2026-11-25', strike: 23000, type: 'CE', lotSize, ltp: 100,
});

describe('StrategyMarginService', () => {
  let store: StrategyStore;
  let service: StrategyMarginService;
  let live: ReturnType<typeof signal<ReadonlyMap<string, number>>>;
  let calls: Pending[];
  let timers: { cb: () => void; ms: number; cancelled: boolean }[];

  const advance = () => {
    for (const t of timers.filter((x) => !x.cancelled)) {
      t.cancelled = true;
      t.cb();
    }
  };
  const firstId = () => store.current().legs[0]!.id;
  const call = (i: number) => calls[i]!;
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  beforeEach(() => {
    sessionStorage.clear();
    calls = [];
    timers = [];
    TestBed.configureTestingModule({
      providers: [
        StrategyStore,
        StrategyMarginService,
        { provide: OPTION_CHAIN_USER_ID, useValue: 'u1' },
        {
          provide: CHAIN_FEED_SCHEDULER,
          useValue: (cb: () => void, ms: number) => {
            const t = { cb, ms, cancelled: false };
            timers.push(t);
            return () => { t.cancelled = true; };
          },
        },
        {
          provide: KambalaRestClient,
          useValue: {
            getBasketMargin: (legs: OrderLeg[]) =>
              new Promise<number>((resolve, reject) => calls.push({ legs, resolve, reject })),
          },
        },
      ],
    });
    store = TestBed.inject(StrategyStore);
    store.setUnderlying('NIFTY');
    service = TestBed.inject(StrategyMarginService);
    live = signal<ReadonlyMap<string, number>>(new Map());
    service.setLivePrices(live);
    TestBed.tick();
  });

  it('no included legs → empty, no request', () => {
    expect(service.state()).toEqual({ status: 'empty' });
    store.toggle(contract('NFO|1', 'A'));
    store.update(firstId(), { included: false });
    TestBed.tick();
    advance();
    expect(calls.length).toBe(0);
    expect(service.state()).toEqual({ status: 'empty' });
  });

  it('requests 400 ms after the last change, combined plus one per leg, hedgeBenefit = Σ single − combined', async () => {
    store.toggle(contract('NFO|1', 'A'));
    TestBed.tick();
    expect(service.state()).toEqual({ status: 'loading' });
    store.toggle(contract('NFO|2', 'B'));
    TestBed.tick();
    expect(timers.filter((t) => !t.cancelled).length).toBe(1);
    expect(timers.at(-1)!.ms).toBe(MARGIN_DEBOUNCE_MS);
    expect(calls.length).toBe(0);

    advance();
    expect(calls.map((c) => c.legs.length)).toEqual([2, 1, 1]);
    call(0).resolve(52323);
    call(1).resolve(148525);
    call(2).resolve(972);
    await flush();
    expect(service.state()).toEqual({ status: 'ready', margin: 52323, hedgeBenefit: 97174 });
  });

  it('a single leg makes one request and hedgeBenefit 0', async () => {
    store.toggle(contract('NFO|1', 'A'));
    TestBed.tick();
    advance();
    expect(calls.length).toBe(1);
    call(0).resolve(5000);
    await flush();
    expect(service.state()).toEqual({ status: 'ready', margin: 5000, hedgeBenefit: 0 });
  });

  it("a newer request's answer wins even when the older one resolves last", async () => {
    store.toggle(contract('NFO|1', 'A'));
    TestBed.tick();
    advance();
    const older = call(0);
    store.update(firstId(), { lots: 2 });
    TestBed.tick();
    advance();
    const newer = call(1);
    newer.resolve(222);
    await flush();
    older.resolve(111);
    await flush();
    expect(service.state()).toEqual({ status: 'ready', margin: 222, hedgeBenefit: 0 });
  });

  it('a price tick alone does not re-request', async () => {
    store.toggle(contract('NFO|1', 'A'));
    store.update(firstId(), { priceType: 'MKT' });
    TestBed.tick();
    advance();
    call(0).resolve(5000);
    await flush();
    live.set(new Map([['NFO|1', 123]]));
    TestBed.tick();
    advance();
    expect(calls.length).toBe(1);
    expect(service.state().status).toBe('ready');
  });

  it('failure → error; retry() requests again', async () => {
    store.toggle(contract('NFO|1', 'A'));
    TestBed.tick();
    advance();
    call(0).reject(new Error('boom'));
    await flush();
    expect(service.state()).toEqual({ status: 'error' });

    service.retry();
    expect(service.state()).toEqual({ status: 'loading' });
    expect(calls.length).toBe(2);
    call(1).resolve(7000);
    await flush();
    expect(service.state()).toEqual({ status: 'ready', margin: 7000, hedgeBenefit: 0 });
  });

  it('destroy with a pending timer: no request later, retry is a no-op', () => {
    store.toggle(contract('NFO|1', 'A'));
    TestBed.tick();
    TestBed.resetTestingModule();
    advance();
    service.retry();
    expect(calls.length).toBe(0);
  });

  it('an in-flight answer resolving after destroy does not change state', async () => {
    store.toggle(contract('NFO|1', 'A'));
    TestBed.tick();
    advance();
    TestBed.resetTestingModule();
    call(0).resolve(9999);
    await flush();
    expect(service.state()).toEqual({ status: 'loading' });
  });

  it('while inactive (pop-up closed) nothing is requested; activating requests at once', async () => {
    const active = signal(false);
    service.setActive(active);
    TestBed.tick();
    store.toggle(contract('NFO|1', 'A'));
    TestBed.tick();
    advance();
    service.retry();
    expect(calls.length).toBe(0);
    expect(service.state()).toEqual({ status: 'empty' });

    active.set(true);
    TestBed.tick();
    expect(calls.length).toBe(1); // no debounce on opening
    expect(service.state()).toEqual({ status: 'loading' });

    // Closing drops the answer still in flight; while closed, edits request nothing.
    active.set(false);
    TestBed.tick();
    call(0).resolve(5000);
    await flush();
    expect(service.state()).toEqual({ status: 'empty' });
    store.update(firstId(), { lots: 2 });
    TestBed.tick();
    advance();
    expect(calls.length).toBe(1);

    // Open again: edits are debounced as before.
    active.set(true);
    TestBed.tick();
    expect(calls.length).toBe(2);
    store.update(firstId(), { lots: 3 });
    TestBed.tick();
    expect(calls.length).toBe(2);
    advance();
    expect(calls.length).toBe(3);
  });

  it('MKT legs are sent at the live price', () => {
    store.toggle(contract('NFO|1', 'A'));
    store.update(firstId(), { priceType: 'MKT' });
    live.set(new Map([['NFO|1', 88.5]]));
    TestBed.tick();
    advance();
    expect(call(0).legs[0]).toMatchObject({ prctyp: 'MKT', prc: 88.5 });
  });
});

describe('toOrderLeg', () => {
  const leg: StrategyLeg = {
    id: 'leg-1', token: 'NFO|43651', tsym: 'NIFTY25NOV26C22850', exch: 'NFO', expiryIso: '2026-11-25',
    strike: 22850, type: 'CE', lotSize: 65, side: 'S', lots: 2, priceType: 'LMT', price: 14.95, included: true,
  };
  const s = (over: Partial<Strategy> = {}): Strategy => ({ legs: [leg], lotMultiplier: 3, product: 'M', ...over });

  it('qty = lots × multiplier × lotSize, prd from the strategy, LMT keeps its price', () => {
    expect(toOrderLeg(leg, s(), null, true)).toEqual({
      exch: 'NFO', tsym: 'NIFTY25NOV26C22850', qty: 390, prc: 14.95, prctyp: 'LMT', trantype: 'S', prd: 'M',
    });
    expect(toOrderLeg(leg, s({ product: 'I' }), null, false).prd).toBe('I');
  });

  it('MKT → live price for margin, 0 for orders', () => {
    const mkt = { ...leg, priceType: 'MKT' as const };
    expect(toOrderLeg(mkt, s(), 21.5, true)).toMatchObject({ prctyp: 'MKT', prc: 21.5 });
    expect(toOrderLeg(mkt, s(), 21.5, false)).toMatchObject({ prctyp: 'MKT', prc: 0 });
  });
});
