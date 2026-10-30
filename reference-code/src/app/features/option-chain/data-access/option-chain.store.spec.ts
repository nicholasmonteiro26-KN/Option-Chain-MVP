import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FEED_TRANSPORT } from './feed/transport';
import { MockFeedTransport } from './feed/mock-feed.transport';
import { ChainMeta, ContractRef, QUICK_UNDERLYINGS, Underlying } from './models';
import type { ChainAnalytics } from '@option-analytics/analyze';
import { DEFAULT_CONFIG } from '@option-analytics/config';
import { OPTION_CHAIN_CONFIG, OptionChainStore } from './option-chain.store';

const NIFTY = QUICK_UNDERLYINGS[0] as Underlying;

function ref(token: string, lotSize = 75): ContractRef {
  return { token, tsym: token, lotSize, tickSize: 0.05, pricePrecision: 2 };
}

const META: ChainMeta = {
  underlying: NIFTY,
  expiry: { iso: '2026-11-10', exd: '10-NOV-2026', sampleTsym: 'X', foExch: 'NFO' },
  strikes: [
    { strike: 24000, ce: ref('NFO|1'), pe: ref('NFO|2') },
    { strike: 24050, ce: ref('NFO|3'), pe: null },
  ],
  strikeStep: 50,
};

describe('OptionChainStore', () => {
  let store: OptionChainStore;
  let transport: MockFeedTransport;

  beforeEach(() => {
    transport = new MockFeedTransport({ seed: () => null, scheduler: () => () => undefined });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: FEED_TRANSPORT, useValue: transport }, OptionChainStore],
    });
    store = TestBed.inject(OptionChainStore);
  });

  it('setChain creates a default LegQuote per contract', () => {
    store.setChain(META);
    expect(store.meta()).toBe(META);
    expect([...store.quotes().keys()]).toEqual(['NFO|1', 'NFO|2', 'NFO|3']);
    expect(store.quotes().get('NFO|2')!()).toEqual({
      token: 'NFO|2', type: 'PE', strike: 24000, lotSize: 75, tickSize: 0.05,
      ltp: null, bid: null, ask: null, bidQty: 0, askQty: 0, volume: 0, oi: 0, prevOi: 0,
      prevClose: null, open: null, high: null, low: null, lastTickMs: 0,
    });
  });

  it('analytics are null right after setChain (and clearChain): the old chain\'s never show on the new one', () => {
    store.setChain(META);
    store.setAnalytics({ forward: 24010 } as ChainAnalytics);
    expect(store.analytics()).not.toBeNull();
    store.setChain({ ...META, expiry: { ...META.expiry, iso: '2026-11-17' } });
    expect(store.analytics()).toBeNull();
    store.setAnalytics({ forward: 24020 } as ChainAnalytics);
    store.clearChain();
    expect(store.analytics()).toBeNull();
  });

  it("oiUnit 'qty' (default): OI, prevOi and volume are stored as received", () => {
    store.setChain(META);
    store.applyTicks(new Map([['NFO|1', { token: 'NFO|1', oi: 10, prevOi: 8, volume: 3 }]]));
    expect(store.quotes().get('NFO|1')!()).toMatchObject({ oi: 10, prevOi: 8, volume: 3 });
  });

  it('setChain builds a fresh quotes map per load', () => {
    store.setChain(META);
    const first = store.quotes();
    store.setChain(META);
    expect(store.quotes()).not.toBe(first);
  });

  it('applyTicks merges partials into a new object without clearing fields', () => {
    store.setChain(META);
    const leg = store.quotes().get('NFO|1')!;
    store.applyTicks(new Map([['NFO|1', { token: 'NFO|1', ltp: 101, oi: 500, lastTickMs: 10 }]]));
    const after1 = leg();
    store.applyTicks(new Map([['NFO|1', { token: 'NFO|1', bid: 100.5, lastTickMs: 20 }]]));
    const after2 = leg();
    expect(after2).not.toBe(after1);
    expect(after2).toMatchObject({ ltp: 101, oi: 500, bid: 100.5, lastTickMs: 20, type: 'CE', strike: 24000 });
    expect(store.quotes().get('NFO|2')!().ltp).toBeNull();
  });

  it('applyTicks sets spot and merges spotOhlc for the underlying key; unknown keys are ignored', () => {
    store.underlying.set(NIFTY);
    store.setChain(META);
    store.applyTicks(new Map([['NSE|26000', { token: 'NSE|26000', ltp: 24010, open: 23900, prevClose: 23950 }]]));
    store.applyTicks(new Map([
      ['NSE|26000', { token: 'NSE|26000', ltp: 24020, high: 24100 }],
      ['NFO|999', { token: 'NFO|999', ltp: 1 }],
    ]));
    expect(store.spot()).toBe(24020);
    expect(store.spotOhlc()).toEqual({ open: 23900, high: 24100, low: null, prevClose: 23950 });
    expect(store.quotes().has('NFO|999')).toBe(false);
  });

  it('dataVersion increments on setChain and clearChain', () => {
    const v0 = store.dataVersion();
    store.setChain(META);
    const v1 = store.dataVersion();
    expect(v1).toBeGreaterThan(v0);
    store.clearChain();
    expect(store.dataVersion()).toBeGreaterThan(v1);
  });

  it('dataVersion increments once per batch that touches a contract or the underlying', () => {
    store.underlying.set(NIFTY);
    store.setChain(META);
    const v0 = store.dataVersion();
    store.applyTicks(new Map([
      ['NFO|1', { token: 'NFO|1', ltp: 1 }],
      ['NFO|2', { token: 'NFO|2', ltp: 2 }],
    ]));
    expect(store.dataVersion()).toBe(v0 + 1);
    store.applyTicks(new Map([['NSE|26000', { token: 'NSE|26000', ltp: 24010 }]]));
    expect(store.dataVersion()).toBe(v0 + 2);
  });

  it('dataVersion does not change for unknown-key-only or quick-only batches', () => {
    store.underlying.set(NIFTY);
    store.setChain(META);
    const v0 = store.dataVersion();
    store.applyTicks(new Map([['NFO|999', { token: 'NFO|999', ltp: 1 }]]));
    store.applyTicks(new Map([['BSE|1', { token: 'BSE|1', ltp: 73830 }]]));
    expect(store.dataVersion()).toBe(v0);
  });

  it('quickPrices tracks both quick-switch keys from ticks, whatever the selected underlying', () => {
    expect(store.quickPrices()).toEqual({});
    store.applyTicks(new Map([
      ['NSE|26000', { token: 'NSE|26000', ltp: 22873.4, prevClose: 22706.85 }],
      ['BSE|1', { token: 'BSE|1', ltp: 73830.29 }],
      ['NSE|2885', { token: 'NSE|2885', ltp: 1420 }],
    ]));
    expect(store.quickPrices()).toEqual({
      NIFTY: { ltp: 22873.4, prevClose: 22706.85 },
      SENSEX: { ltp: 73830.29, prevClose: null },
    });
    store.applyTicks(new Map([['BSE|1', { token: 'BSE|1', ltp: 73900, prevClose: 73246.03 }]]));
    expect(store.quickPrices()['SENSEX']).toEqual({ ltp: 73900, prevClose: 73246.03 });
    expect(store.quickPrices()['NIFTY']).toEqual({ ltp: 22873.4, prevClose: 22706.85 });
    expect(store.spot()).toBeNull(); // no underlying selected: quick ticks do not touch spot
  });

  it('primeSpotFromCache restores spot and OHLC of a quick underlying from its cached ticks', () => {
    store.applyTicks(new Map([['NSE|26000', { token: 'NSE|26000', ltp: 22873.4, open: 22700, high: 22900, low: 22650, prevClose: 22706.85 }]]));
    store.underlying.set(NIFTY);
    store.primeSpotFromCache();
    expect(store.spot()).toBe(22873.4);
    expect(store.spotOhlc()).toEqual({ open: 22700, high: 22900, low: 22650, prevClose: 22706.85 });
  });

  it('feedStatus mirrors the transport status', async () => {
    expect(store.feedStatus()).toBe('closed');
    await transport.connect();
    expect(store.feedStatus()).toBe('open');
  });

  it('reset clears the chain state', () => {
    store.underlying.set(NIFTY);
    store.setChain(META);
    store.spot.set(1);
    store.loadState.set('ready');
    store.partialChain.set(true);
    store.reset();
    expect(store.underlying()).toBeNull();
    expect(store.meta()).toBeNull();
    expect(store.quotes().size).toBe(0);
    expect(store.spot()).toBeNull();
    expect(store.loadState()).toBe('idle');
    expect(store.partialChain()).toBe(false);
  });
});

describe("OptionChainStore with oiUnit 'lots'", () => {
  let store: OptionChainStore;

  beforeEach(() => {
    const transport = new MockFeedTransport({ seed: () => null, scheduler: () => () => undefined });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: FEED_TRANSPORT, useValue: transport },
        { provide: OPTION_CHAIN_CONFIG, useValue: { ...DEFAULT_CONFIG, oiUnit: 'lots' } },
        OptionChainStore,
      ],
    });
    store = TestBed.inject(OptionChainStore);
    store.setChain({ ...META, strikes: [{ strike: 24000, ce: ref('NFO|1', 75), pe: ref('NFO|2', 20) }] });
  });

  it('normalises OI, prevOi and volume to quantity at ingestion, by each contract\'s lot size', () => {
    store.applyTicks(new Map([
      ['NFO|1', { token: 'NFO|1', oi: 10, prevOi: 8, volume: 3, ltp: 101.5 }],
      ['NFO|2', { token: 'NFO|2', oi: 4 }],
    ]));
    expect(store.quotes().get('NFO|1')!()).toMatchObject({ oi: 750, prevOi: 600, volume: 225, ltp: 101.5 });
    expect(store.quotes().get('NFO|2')!()).toMatchObject({ oi: 80, prevOi: 0, volume: 0 });
  });

  it('a partial tick scales only the fields it carries, and a tick lot size (ls) wins', () => {
    store.applyTicks(new Map([['NFO|1', { token: 'NFO|1', oi: 10, volume: 3 }]]));
    store.applyTicks(new Map([['NFO|1', { token: 'NFO|1', ltp: 99 }]])); // no OI: left as is (not re-scaled)
    expect(store.quotes().get('NFO|1')!()).toMatchObject({ oi: 750, volume: 225 });
    store.applyTicks(new Map([['NFO|1', { token: 'NFO|1', oi: 2, lotSize: 65 }]]));
    expect(store.quotes().get('NFO|1')!()).toMatchObject({ oi: 130, lotSize: 65, volume: 225 });
  });

  it('does not scale the underlying spot', () => {
    store.underlying.set(NIFTY);
    store.applyTicks(new Map([['NSE|26000', { token: 'NSE|26000', ltp: 24010, volume: 5 }]]));
    expect(store.spot()).toBe(24010);
  });
});
