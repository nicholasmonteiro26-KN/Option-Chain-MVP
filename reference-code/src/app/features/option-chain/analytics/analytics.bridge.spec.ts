import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { analyzeChain } from '@option-analytics/analyze';
import type { ChainAnalytics } from '@option-analytics/analyze';
import { sampleChain, SAMPLE_EXPIRY } from '@option-analytics/testing/sample-chain';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { FEED_TRANSPORT } from '../data-access/feed/transport';
import type { FeedStatus } from '../data-access/feed/transport';
import { MarketSessionService } from '../data-access/market-session.service';
import { ChainMeta, ContractRef, QUICK_UNDERLYINGS, Underlying } from '../data-access/models';
import { OptionChainStore } from '../data-access/option-chain.store';
import { ANALYTICS_POST_SCHEDULER, AnalyticsBridge, WATCHDOG_INTERVALS, WORKER_FACTORY, WorkerLike } from './analytics.bridge';
import type { FromWorker, ToWorker } from './protocol';

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: ToWorker[] = [];
  terminated = false;
  /** When set, every post is answered synchronously by this function. */
  auto: ((m: ToWorker) => FromWorker) | null = null;
  postMessage(m: ToWorker): void {
    this.posted.push(m);
    if (this.auto) this.onmessage?.({ data: this.auto(m) } as MessageEvent<FromWorker>);
  }
  terminate(): void { this.terminated = true; }
  reply(data: FromWorker): void { this.onmessage?.({ data } as MessageEvent<FromWorker>); }
  crash(): void { this.onerror?.(new ErrorEvent("error")); }
}

const NIFTY = QUICK_UNDERLYINGS[0] as Underlying;
const ref = (token: string): ContractRef => ({ token, tsym: token, lotSize: 75, tickSize: 0.05, pricePrecision: 2 });
const META: ChainMeta = {
  underlying: NIFTY,
  expiry: { iso: '2026-11-10', exd: '10-NOV-2026', sampleTsym: 'X', foExch: 'NFO' },
  strikes: [{ strike: 24000, ce: ref('NFO|1'), pe: ref('NFO|2') }, { strike: 24050, ce: ref('NFO|3'), pe: null }],
  strikeStep: 50,
};
/** Chain identity of META. */
const CHAIN = 'NSE|26000|2026-11-10';

function fakeResult(forward: number, legs: Record<string, number | null> = {}): ChainAnalytics {
  const l: Record<string, unknown> = {};
  for (const [t, iv] of Object.entries(legs)) l[t] = { token: t, iv };
  return { forward, legs: l } as unknown as ChainAnalytics;
}

describe('AnalyticsBridge', () => {
  let store: OptionChainStore;
  let bridge: AnalyticsBridge;
  let workers: FakeWorker[];
  /** Market session (exchange hours) open; drives the closed-market data-version rule. */
  let open: ReturnType<typeof signal<boolean>>;
  let now: number;
  let timers: { cb: () => void; at: number; live: boolean }[];
  /** ANALYTICS_POST_SCHEDULER: synchronous unless a test swaps it. */
  let afterFrame: (fn: () => void) => void;

  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.cb();
    }
    now = end;
  };
  const cur = (): FakeWorker => workers[workers.length - 1]!;
  const posts = (): number => workers.reduce((n, w) => n + w.posted.length, 0);

  beforeEach(() => {
    workers = [];
    timers = [];
    afterFrame = (fn) => fn();
    now = 1_000_000;
    open = signal(true);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: FEED_TRANSPORT, useValue: { status: signal<FeedStatus>('open') } },
        { provide: MarketSessionService, useValue: { isOpen: open } },
        { provide: CHAIN_FEED_CLOCK, useValue: () => now },
        {
          provide: CHAIN_FEED_SCHEDULER,
          useValue: (cb: () => void, ms: number) => {
            const t = { cb, at: now + ms, live: true };
            timers.push(t);
            return () => { t.live = false; };
          },
        },
        { provide: WORKER_FACTORY, useValue: () => { const w = new FakeWorker(); workers.push(w); return w; } },
        { provide: ANALYTICS_POST_SCHEDULER, useValue: (fn: () => void) => afterFrame(fn) },
        OptionChainStore,
        AnalyticsBridge,
      ],
    });
    store = TestBed.inject(OptionChainStore);
    bridge = TestBed.inject(AnalyticsBridge);
    store.setChain(META);
    store.selectedExpiry.set(META.expiry);
    store.spot.set(24020);
  });

  it('posts once per interval and skips (never queues) while a request is in flight', () => {
    bridge.start();
    advance(1000);
    expect(cur().posted).toHaveLength(1);
    advance(2500); // no reply: in flight the whole time
    expect(cur().posted).toHaveLength(1);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24025) });
    advance(1000);
    expect(cur().posted).toHaveLength(2);
    expect(cur().posted[1]!.id).not.toBe(cur().posted[0]!.id);
  });

  it('posts through ANALYTICS_POST_SCHEDULER (just after a frame), once, with a snapshot taken then', () => {
    const queued: (() => void)[] = [];
    afterFrame = (fn) => { queued.push(fn); };
    bridge.start();
    advance(1000);
    expect(queued).toHaveLength(1);
    expect(posts()).toBe(0);
    bridge.requestAnalysis(); // already waiting for the frame: no second post
    expect(queued).toHaveLength(1);
    store.spot.set(24040);
    queued.shift()!();
    expect(posts()).toBe(1);
    expect(cur().posted[0]!.input.spot).toBe(24040);
  });

  it('a post waiting for the frame is dropped when the bridge stops', () => {
    const queued: (() => void)[] = [];
    afterFrame = (fn) => { queued.push(fn); };
    bridge.start();
    advance(1000);
    const w = cur();
    bridge.stop();
    queued.shift()!();
    expect(w.posted).toHaveLength(0);
  });

  it('a result updates store.analytics()', () => {
    bridge.start();
    advance(1000);
    const result = fakeResult(24025);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result });
    expect(store.analytics()).toBe(result);
  });

  it('ignores a result whose id is not the in-flight one', () => {
    bridge.start();
    advance(1000);
    const id = cur().posted[0]!.id;
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: id + 99, result: fakeResult(1) });
    expect(store.analytics()).toBeNull();
    advance(1000);
    expect(cur().posted).toHaveLength(1); // still in flight
  });

  it('first crash recreates the worker and continues; second sets analyticsUnavailable and stops posting', () => {
    bridge.start();
    advance(1000);
    const first = cur();
    first.crash();
    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(bridge.analyticsUnavailable()).toBe(false);
    advance(1000);
    expect(workers[1]!.posted).toHaveLength(1);

    workers[1]!.reply({ v: 1, kind: 'error', chain: CHAIN, id: workers[1]!.posted[0]!.id, message: 'boom' });
    expect(workers[1]!.terminated).toBe(true);
    expect(bridge.analyticsUnavailable()).toBe(true);
    expect(workers).toHaveLength(2); // no third worker
    const before = posts();
    advance(5000);
    expect(posts()).toBe(before);
  });

  it('runs exactly one analysis while the market is closed, and another once it opens', () => {
    open.set(false);
    bridge.start();
    advance(1000);
    expect(cur().posted).toHaveLength(1);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24025) });
    advance(5000);
    expect(cur().posted).toHaveLength(1);
    open.set(true);
    advance(1000);
    expect(cur().posted).toHaveLength(2);
  });

  it('while closed, re-analyses when the chain data changes, then stays quiet until it changes again', () => {
    open.set(false);
    bridge.start();
    advance(1000); // empty default quotes: the first (provisional) analysis
    expect(posts()).toBe(1);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24025) });
    // The acks arrive later (network round trip + flush).
    store.applyTicks(new Map([['NFO|1', { token: 'NFO|1', ltp: 55, oi: 900 }]]));
    advance(1000);
    expect(posts()).toBe(2);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[1]!.id, result: fakeResult(24026) });
    advance(5000);
    expect(posts()).toBe(2);
    store.applyTicks(new Map([['NFO|2', { token: 'NFO|2', ltp: 60, oi: 100 }]]));
    advance(1000);
    expect(posts()).toBe(3);
  });

  it('while closed, a quick-key-only or unknown-key batch does not trigger a re-post', () => {
    open.set(false);
    bridge.start();
    advance(1000);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24025) });
    store.applyTicks(new Map([['BSE|1', { token: 'BSE|1', ltp: 73830 }], ['NFO|999', { token: 'NFO|999', ltp: 1 }]]));
    advance(5000);
    expect(posts()).toBe(1);
  });

  it('requestAnalysis() clears the closed-market gate and posts at once when idle', () => {
    open.set(false);
    bridge.start();
    advance(1000);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24025) });
    advance(3000);
    expect(cur().posted).toHaveLength(1);
    bridge.requestAnalysis();
    expect(cur().posted).toHaveLength(2);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[1]!.id, result: fakeResult(24026) });
    advance(3000);
    expect(cur().posted).toHaveLength(2); // no new data: gated again until the next request
  });

  it('requestAnalysis() while a request is in flight posts on the next interval after the reply, not at once', () => {
    open.set(false);
    bridge.start();
    advance(1000);
    bridge.requestAnalysis();
    expect(cur().posted).toHaveLength(1);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24025) });
    advance(1000);
    expect(cur().posted).toHaveLength(2);
    advance(3000);
    expect(cur().posted).toHaveLength(2);
  });

  it('requestAnalysis() does nothing before start()', () => {
    bridge.requestAnalysis();
    expect(workers).toHaveLength(0);
  });

  it('retries the closed-market analysis if the worker crashed before answering', () => {
    open.set(false);
    bridge.start();
    advance(1000);
    cur().crash();
    advance(1000);
    expect(cur().posted).toHaveLength(1);
    expect(workers).toHaveLength(2);
  });

  it('does not post while spot is null, then posts once it arrives', () => {
    store.spot.set(null);
    bridge.start();
    advance(3000);
    expect(posts()).toBe(0);
    store.spot.set(24020);
    advance(1000);
    expect(posts()).toBe(1);
  });

  it('does not post without meta or selected expiry', () => {
    store.clearChain();
    bridge.start();
    advance(2000);
    expect(posts()).toBe(0);
  });

  it('maps the store snapshot to a ChainInput (first input has no warm state)', () => {
    store.quotes().get('NFO|1')!.update((q) => ({ ...q, ltp: 55 }));
    bridge.start();
    advance(1000);
    const m = cur().posted[0]!;
    expect(m.v).toBe(1);
    expect(m.kind).toBe('analyze');
    expect(m.input).toMatchObject({
      spot: 24020, futuresPrice: null, expiryIso: '2026-11-10', nowMs: 1_001_000, prevForward: null, prevIv: {},
    });
    expect(m.input.strikes.map((s) => [s.strike, s.ce?.token ?? null, s.pe?.token ?? null])).toEqual([
      [24000, 'NFO|1', 'NFO|2'], [24050, 'NFO|3', null],
    ]);
    expect(m.input.strikes[0]!.ce!.ltp).toBe(55);
  });

  it('passes prevForward and non-null prevIv from the previous result into the next input', () => {
    bridge.start();
    advance(1000);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24031.5, { 'NFO|1': 0.14, 'NFO|2': null }) });
    advance(1000);
    const input = cur().posted[1]!.input;
    expect(input.prevForward).toBe(24031.5);
    expect(input.prevIv).toEqual({ 'NFO|1': 0.14 });
  });

  it('records lastRoundTripMs as clock at result minus clock at post', () => {
    expect(bridge.lastRoundTripMs()).toBeNull();
    bridge.start();
    advance(1000);
    advance(37);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(1) });
    expect(bridge.lastRoundTripMs()).toBe(37);
  });

  it('counts accepted results (resultCount), not stale ones', () => {
    bridge.start();
    expect(bridge.resultCount).toBe(0);
    advance(1000);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: 999, result: fakeResult(1) }); // stale id
    expect(bridge.resultCount).toBe(0);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(1) });
    expect(bridge.resultCount).toBe(1);
  });

  it('stop() cancels the interval and terminates the worker', () => {
    bridge.start();
    advance(1000);
    const w = cur();
    bridge.stop();
    expect(w.terminated).toBe(true);
    advance(5000);
    expect(posts()).toBe(1);
  });

  it('tags each post with the chain identity (underlyingKey|expiry.iso)', () => {
    bridge.start();
    advance(1000);
    expect(cur().posted[0]!.chain).toBe(CHAIN);
  });

  it('drops a reply for the old chain that arrives after setChain, and analyses the new chain at once', () => {
    bridge.start();
    advance(1000);
    const old = cur().posted[0]!;
    const META_17: ChainMeta = { ...META, expiry: { ...META.expiry, iso: '2026-11-17', exd: '17-NOV-2026' } };
    store.setChain(META_17);
    store.selectedExpiry.set(META_17.expiry);
    expect(store.analytics()).toBeNull();
    cur().reply({ v: 1, kind: 'result', chain: old.chain, id: old.id, result: fakeResult(24025, { 'NFO|1': 0.2 }) });
    expect(store.analytics()).toBeNull(); // never attached to the new chain
    expect(bridge.resultCount).toBe(0);
    expect(cur().posted).toHaveLength(2); // the new chain is analysed right away
    expect(cur().posted[1]!.chain).toBe('NSE|26000|2026-11-17');
    expect(cur().posted[1]!.input.prevForward).toBeNull();
    expect(cur().posted[1]!.input.prevIv).toEqual({});
  });

  it('prevForward and prevIv are null / empty on the first post for a new chain', () => {
    bridge.start();
    advance(1000);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(24031.5, { 'NFO|1': 0.14 }) });
    advance(1000);
    expect(cur().posted[1]!.input.prevForward).toBe(24031.5); // same chain: warm
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[1]!.id, result: fakeResult(24032, { 'NFO|1': 0.15 }) });
    const OTHER: ChainMeta = { ...META, underlying: QUICK_UNDERLYINGS[1]!, expiry: { ...META.expiry, foExch: 'BFO' } };
    store.setChain(OTHER);
    bridge.requestAnalysis(); // what the page does on every chain change
    const first = cur().posted[2]!;
    expect(first.chain).toBe('BSE|1|2026-11-10');
    expect(first.input.prevForward).toBeNull();
    expect(first.input.prevIv).toEqual({});
  });

  it(`treats no reply within ${WATCHDOG_INTERVALS} intervals as a crash (restart once, then unavailable)`, () => {
    bridge.start();
    advance(1000);
    const first = cur();
    advance(WATCHDOG_INTERVALS * 1000 - 1);
    expect(first.terminated).toBe(false);
    advance(1);
    expect(first.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(bridge.analyticsUnavailable()).toBe(false);
    advance(1000);
    expect(workers[1]!.posted).toHaveLength(1);
    advance(WATCHDOG_INTERVALS * 1000);
    expect(bridge.analyticsUnavailable()).toBe(true);
  });

  it('a timely reply cancels the watchdog', () => {
    bridge.start();
    advance(1000);
    cur().reply({ v: 1, kind: 'result', chain: CHAIN, id: cur().posted[0]!.id, result: fakeResult(1) });
    workers[0]!.auto = (m) => ({ v: 1, kind: 'result', chain: m.chain, id: m.id, result: fakeResult(1) });
    advance(20_000);
    expect(workers).toHaveLength(1);
    expect(bridge.analyticsUnavailable()).toBe(false);
  });

  it('produces a valid analysis from a real chain through the snapshot mapping', () => {
    const fixture = sampleChain();
    const chainMeta: ChainMeta = {
      underlying: NIFTY,
      expiry: { iso: SAMPLE_EXPIRY, exd: '03-NOV-2026', sampleTsym: 'X', foExch: 'NFO' },
      strikes: fixture.strikes.map((s) => ({
        strike: s.strike, ce: s.ce ? ref(s.ce.token) : null, pe: s.pe ? ref(s.pe.token) : null,
      })),
      strikeStep: 50,
    };
    store.setChain(chainMeta);
    store.selectedExpiry.set(chainMeta.expiry);
    store.spot.set(fixture.spot);
    for (const s of fixture.strikes) {
      for (const leg of [s.ce, s.pe]) if (leg) store.quotes().get(leg.token)!.set(leg);
    }
    now = fixture.nowMs - 1000; // the snapshot's nowMs is the fixture's pricing time
    bridge.start();
    // The fake worker runs the real analyzeChain in-process.
    workers[0]!.auto = (m) => ({ v: 1, kind: 'result', chain: m.chain, id: m.id, result: analyzeChain(m.input) });
    advance(1000);
    const a = store.analytics();
    expect(a).not.toBeNull();
    expect(a!.forward).toBeGreaterThan(24900);
    expect(Object.keys(a!.legs)).toHaveLength(42);
    expect(a!.legs['CE25000']!.iv).toBeGreaterThan(0.05);
    expect(a!.strikes).toHaveLength(21);
  });
});
