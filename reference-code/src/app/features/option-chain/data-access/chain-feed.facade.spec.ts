import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KambalaRestClient } from './kambala/kambala-rest.client';
import { KambalaError, OptionChainRow, SessionExpiredError } from './kambala/kambala.types';
import { FEED_TRANSPORT } from './feed/transport';
import { MockFeedTransport } from './feed/mock-feed.transport';
import { TickBuffer } from './feed/tick-buffer';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER, ChainFeedFacade } from './chain-feed.facade';
import { OptionChainStore } from './option-chain.store';
import { QUICK_UNDERLYINGS, Underlying } from './models';
import { chainRows, NIFTY_LINKED, NOW_MS, range } from './testing/chain-fixtures';

const NIFTY = QUICK_UNDERLYINGS.find((u) => u.sym === 'NIFTY') as Underlying;
const SPOT_KEY = 'NSE|26000';
/** The other quick-switch underlying, subscribed for the page's lifetime (D18). */
const SENSEX_KEY = 'BSE|1';

const ROWS_03 = chainRows('NIFTY03NOV26', 'NFO', range(23900, 24100, 50), 300);
const ROWS_10 = chainRows('NIFTY10NOV26', 'NFO', range(23900, 24100, 50), 1000);
const ROWS_17 = chainRows('NIFTY17NOV26', 'NFO', range(23800, 24200, 100), 1700);

const keysOf = (rows: OptionChainRow[]) => rows.map((r) => `${r.exch}|${r.token}`);
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

interface SetupOpts {
  spotless?: boolean;
  silentKeys?: string[];
  subscriptionLimit?: number;
  limitReportDelayMs?: number;
  chain?: (tsym: string) => Promise<OptionChainRow[]>;
  /** Clock -> TickBuffer; default a synchronous one (flush on every push). */
  buffer?: (clock: () => number) => TickBuffer;
}

function setup(opts: SetupOpts = {}) {
  let now = NOW_MS;
  const timers: { cb: () => void; ms: number; cancelled: boolean }[] = [];
  const scheduler = (cb: () => void, ms: number) => {
    const h = { cb, ms, cancelled: false };
    timers.push(h);
    return () => { h.cancelled = true; };
  };
  const fire = (ms: number) => {
    const due = timers.filter((t) => t.ms === ms && !t.cancelled);
    due.forEach((t) => { timers.splice(timers.indexOf(t), 1); t.cb(); });
  };
  /** The mock transport's own timers (its 50 ms tick loop is never fired). */
  const mockTimers: { cb: () => void; ms: number }[] = [];
  const fireMock = (ms: number) => {
    const due = mockTimers.filter((t) => t.ms === ms);
    due.forEach((t) => { mockTimers.splice(mockTimers.indexOf(t), 1); t.cb(); });
  };

  const transport = new MockFeedTransport({
    seed: (key): Record<string, string> | null => {
      if (key === SPOT_KEY) return opts.spotless ? null : { lp: '24010', o: '23900', h: '24100', l: '23850', c: '23950' };
      if (opts.silentKeys?.includes(key)) return null;
      return { lp: '100', ti: '0.05', ls: '75', v: '0', oi: '1000' };
    },
    scheduler: (cb, ms) => { mockTimers.push({ cb, ms }); return () => undefined; }, // ticks (50 ms) are never fired
    subscriptionLimit: opts.subscriptionLimit,
    limitReportDelayMs: opts.limitReportDelayMs,
  });

  const byTsym: Record<string, OptionChainRow[]> = {
    NIFTY03NOV26P24000: ROWS_03, NIFTY10NOV26P24000: ROWS_10, NIFTY17NOV26P24000: ROWS_17,
  };
  const rest = {
    getLinkedScrips: vi.fn(async () => NIFTY_LINKED),
    getOptionChain: vi.fn(async (_exch: string, tsym: string, _strprc: number, _cnt: number) =>
      opts.chain ? opts.chain(tsym) : byTsym[tsym] ?? []),
  };
  const buffer = opts.buffer ? opts.buffer(() => now) : new TickBuffer(() => now, (fn) => fn(), 0);

  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: KambalaRestClient, useValue: rest },
      { provide: FEED_TRANSPORT, useValue: transport },
      { provide: TickBuffer, useValue: buffer },
      { provide: CHAIN_FEED_SCHEDULER, useValue: scheduler },
      { provide: CHAIN_FEED_CLOCK, useValue: () => now },
      OptionChainStore,
      ChainFeedFacade,
    ],
  });
  const facade = TestBed.inject(ChainFeedFacade);
  const store = TestBed.inject(OptionChainStore);
  return {
    facade, store, transport, rest, buffer, timers, fire, fireMock,
    setNow: (ms: number) => { now = ms; },
  };
}

/** Keys from the transport's sent log, in order, as [type, key] pairs. */
function sentPairs(sent: readonly object[]): [string, string][] {
  return sent.flatMap((m) => {
    const { t, k } = m as { t: string; k: string };
    return k.split('#').map((key) => [t, key] as [string, string]);
  });
}

describe('ChainFeedFacade', () => {
  it('select loads expiries, waits for spot, loads the first expiry and subscribes underlying + contracts', async () => {
    const { facade, store, transport, rest } = setup();
    await facade.select(NIFTY);

    expect(store.underlying()).toBe(NIFTY);
    expect(store.expiries().map((e) => e.iso)).toEqual(['2026-11-03', '2026-11-10', '2026-11-17']);
    expect(store.spot()).toBe(24010);
    expect(store.spotOhlc()).toEqual({ open: 23900, high: 24100, low: 23850, prevClose: 23950 });
    expect(rest.getOptionChain).toHaveBeenCalledWith('NFO', 'NIFTY03NOV26P24000', 24010, 100);
    expect(store.selectedExpiry()?.iso).toBe('2026-11-03');
    expect(store.loadState()).toBe('ready');
    expect(store.partialChain()).toBe(false);
    expect(transport.subscribedKeys().sort()).toEqual([SPOT_KEY, SENSEX_KEY, ...keysOf(ROWS_03)].sort());
    expect(store.quotes().get('NFO|300')!().ltp).toBe(100);
  });

  it('select honours an explicit expiry', async () => {
    const { facade, store } = setup();
    await facade.select(NIFTY, '2026-11-10');
    expect(store.selectedExpiry()?.iso).toBe('2026-11-10');
    expect(store.meta()!.strikes[0]!.ce!.token).toBe('NFO|1000');
  });

  it('discards a stale chain load', async () => {
    const d10 = deferred<OptionChainRow[]>();
    const d17 = deferred<OptionChainRow[]>();
    const { facade, store, transport } = setup({
      chain: (tsym) =>
        tsym.startsWith('NIFTY10NOV') ? d10.promise : tsym.startsWith('NIFTY17NOV') ? d17.promise : Promise.resolve(ROWS_03),
    });
    await facade.select(NIFTY);

    const first = facade.selectExpiry('2026-11-10');
    const second = facade.selectExpiry('2026-11-17');
    d17.resolve(ROWS_17);
    await second;
    d10.resolve(ROWS_10); // the older request resolves last
    await first;

    expect(store.selectedExpiry()!.iso).toBe('2026-11-17');
    expect(store.meta()!.strikes.map((s) => s.strike)).toEqual(range(23800, 24200, 100));
    expect(store.meta()!.expiry.iso).toBe('2026-11-17');
    expect(transport.subscribedKeys().sort()).toEqual([SPOT_KEY, SENSEX_KEY, ...keysOf(ROWS_17)].sort());
    expect(store.loadState()).toBe('ready');
  });

  it('switching expiry sends u for every old key before any t for new keys', async () => {
    const { facade, transport } = setup();
    await facade.select(NIFTY);
    transport.sent.length = 0;

    await facade.selectExpiry('2026-11-10');

    const pairs = sentPairs(transport.sent);
    const firstT = pairs.findIndex(([t]) => t === 't');
    const lastU = pairs.map(([t]) => t).lastIndexOf('u');
    expect(firstT).toBeGreaterThan(-1);
    expect(lastU).toBeGreaterThan(-1);
    expect(lastU).toBeLessThan(firstT);
    expect(pairs.filter(([t]) => t === 'u').map(([, k]) => k).sort()).toEqual(keysOf(ROWS_03).sort());
    expect(pairs.filter(([t]) => t === 't').map(([, k]) => k).sort()).toEqual(keysOf(ROWS_10).sort());
    expect(transport.subscribedKeys()).toContain(SPOT_KEY);
  });

  it('switching underlying unsubscribes the previous underlying before subscribing the new one', async () => {
    const { facade, transport } = setup();
    await facade.select(NIFTY);
    transport.sent.length = 0;
    const other: Underlying = { ...NIFTY, sym: 'BANKNIFTY', token: '26009' };
    void facade.select(other).catch(() => undefined);
    const pairs = sentPairs(transport.sent);
    expect(pairs[pairs.length - 1]).toEqual(['t', 'NSE|26009']);
    expect(pairs.slice(0, -1).every(([t]) => t === 'u')).toBe(true);
    expect(pairs.slice(0, -1).map(([, k]) => k).sort()).toEqual(keysOf(ROWS_03).sort());
    // NIFTY's key is released by the selection but stays on the wire for its quick-switch button.
    expect(transport.subscribedKeys().sort()).toEqual([SENSEX_KEY, SPOT_KEY, 'NSE|26009'].sort());
  });

  it('keeps both quick-switch keys subscribed across selections and on the wire only once', async () => {
    const { facade, transport } = setup();
    expect(transport.subscribedKeys().sort()).toEqual([SENSEX_KEY, SPOT_KEY].sort()); // from construction
    await facade.select(NIFTY);
    await facade.select({ ...NIFTY, sym: 'BANKNIFTY', token: '26009' }).catch(() => undefined);
    await facade.select(QUICK_UNDERLYINGS[1]!).catch(() => undefined);
    const keys = transport.subscribedKeys();
    expect(keys).toContain(SPOT_KEY);
    expect(keys).toContain(SENSEX_KEY);
    const subs = sentPairs(transport.sent).filter(([t, k]) => t === 't' && (k === SPOT_KEY || k === SENSEX_KEY));
    expect(subs).toHaveLength(2); // each sent once, at construction
  });

  it('quick prices follow ticks on both quick keys; re-selecting NIFTY gets its spot at once from them', async () => {
    const { facade, store } = setup();
    expect(store.quickPrices()).toEqual({
      NIFTY: { ltp: 24010, prevClose: 23950 },
      SENSEX: { ltp: 100, prevClose: null },
    });
    await facade.select(NIFTY);
    await facade.select({ ...NIFTY, sym: 'BANKNIFTY', token: '26009' });
    await facade.select(NIFTY); // NIFTY's key never left the wire: no new ack, spot comes from the quick cache
    expect(store.spot()).toBe(24010);
    expect(store.spotOhlc()).toEqual({ open: 23900, high: 24100, low: 23850, prevClose: 23950 });
    expect(store.loadState()).toBe('ready');
  });

  it('markStale returns only contract keys with no tick for 30 s (never-ticked counts from chain load)', async () => {
    const { facade, buffer, setNow } = setup({ silentKeys: ['NFO|301'] });
    await facade.select(NIFTY); // every leg except NFO|301 acked at NOW_MS

    expect(facade.markStale(NOW_MS + 10_000)).toEqual([]);
    expect(facade.markStale(NOW_MS + 30_000)).toEqual([]);

    setNow(NOW_MS + 20_000);
    buffer.push({ t: 'tf', e: 'NFO', tk: '300', lp: '101' });

    const stale = facade.markStale(NOW_MS + 30_001);
    expect(stale).not.toContain('NFO|300');
    expect(stale).toContain('NFO|301');
    expect(stale.sort()).toEqual(keysOf(ROWS_03).filter((k) => k !== 'NFO|300').sort());
    expect(stale).not.toContain(SPOT_KEY);

    expect(facade.markStale(NOW_MS + 50_001)).toContain('NFO|300');
  });

  it('subscription limit 40: re-subscribes ±9 strikes around ATM and flags a partial chain', async () => {
    const strikes = range(23000, 25000, 50); // 41 strikes = 82 legs
    const rows = chainRows('NIFTY03NOV26', 'NFO', strikes, 5000);
    const { facade, store, transport } = setup({ subscriptionLimit: 40, chain: async () => rows });

    await facade.select(NIFTY);

    expect(transport.limitReached()).toBe(40);
    expect(store.partialChain()).toBe(true);
    const window = range(23550, 24450, 50); // ATM 24000 (spot 24010) ± 9 strikes
    const expected = rows.filter((r) => window.includes(+r.strprc)).map((r) => `NFO|${r.token}`);
    expect(expected).toHaveLength(38);
    const subscribed = transport.subscribedKeys();
    expect(subscribed).toHaveLength(40); // the SENSEX quick key counts against the limit too
    expect(subscribed.sort()).toEqual([SPOT_KEY, SENSEX_KEY, ...expected].sort());
    expect(store.meta()!.strikes).toHaveLength(41);
    expect(store.loadState()).toBe('ready');
  });

  it('retries a failing REST call twice, then sets the error state', async () => {
    const { facade, store, rest } = setup();
    rest.getLinkedScrips.mockRejectedValue(new KambalaError('boom'));
    await facade.select(NIFTY);
    expect(rest.getLinkedScrips).toHaveBeenCalledTimes(3);
    expect(store.loadState()).toBe('error');
    expect(store.sessionExpired()).toBe(false);
  });

  it('recovers when a retry succeeds', async () => {
    const { facade, store, rest } = setup();
    rest.getOptionChain.mockRejectedValueOnce(new KambalaError('blip'));
    await facade.select(NIFTY);
    expect(rest.getOptionChain).toHaveBeenCalledTimes(2);
    expect(store.loadState()).toBe('ready');
  });

  it('SessionExpiredError sets sessionExpired without retrying', async () => {
    const { facade, store, rest } = setup();
    rest.getOptionChain.mockRejectedValue(new SessionExpiredError());
    await facade.select(NIFTY);
    expect(rest.getOptionChain).toHaveBeenCalledTimes(1);
    expect(store.sessionExpired()).toBe(true);
    expect(store.loadState()).toBe('error');
  });

  it('REST session expiry unsubscribes every key and stops further loads', async () => {
    const { facade, store, rest, transport } = setup();
    await facade.select(NIFTY);
    transport.sent.length = 0;
    rest.getOptionChain.mockRejectedValue(new SessionExpiredError());

    await facade.selectExpiry('2026-11-10');

    const unsent = sentPairs(transport.sent).filter(([t]) => t === 'u').map(([, k]) => k);
    expect(unsent.sort()).toEqual([SPOT_KEY, SENSEX_KEY, ...keysOf(ROWS_03)].sort());
    expect(sentPairs(transport.sent).some(([t]) => t === 't')).toBe(false);
    expect(transport.subscribedKeys()).toEqual([]);
    expect(store.sessionExpired()).toBe(true);
    expect(store.loadState()).toBe('error');

    rest.getOptionChain.mockClear();
    await facade.selectExpiry('2026-11-17');
    expect(rest.getOptionChain).not.toHaveBeenCalled();
  });

  it('REST session expiry during select unsubscribes the underlying', async () => {
    const { facade, store, rest, transport } = setup();
    rest.getLinkedScrips.mockRejectedValue(new SessionExpiredError());
    await facade.select(NIFTY);
    expect(rest.getLinkedScrips).toHaveBeenCalledTimes(1);
    expect(transport.subscribedKeys()).toEqual([]);
    expect(store.sessionExpired()).toBe(true);
    expect(store.loadState()).toBe('error');
  });

  it('WS session expiry (transport status session-expired) sets sessionExpired and unsubscribes all', async () => {
    const { facade, store, transport } = setup();
    await facade.select(NIFTY);
    expect(store.sessionExpired()).toBe(false);

    transport.expireSession();
    TestBed.tick();

    expect(store.sessionExpired()).toBe(true);
    expect(transport.subscribedKeys()).toEqual([]);
  });

  it('subscription limit reported asynchronously still trims to ±N strikes and flags a partial chain', async () => {
    const strikes = range(23000, 25000, 50);
    const rows = chainRows('NIFTY03NOV26', 'NFO', strikes, 5000);
    const { facade, store, transport, fireMock } = setup({
      subscriptionLimit: 40, limitReportDelayMs: 7, chain: async () => rows,
    });

    await facade.select(NIFTY);
    TestBed.tick();
    // subscribe() has returned without reporting the limit: the facade cannot know yet.
    expect(transport.limitReached()).toBeNull();
    expect(store.partialChain()).toBe(false);
    expect(transport.subscribedKeys()).toHaveLength(40);

    fireMock(7); // the "server" reports the limit later
    TestBed.tick();

    expect(transport.limitReached()).toBe(40);
    expect(store.partialChain()).toBe(true);
    const window = range(23550, 24450, 50);
    const expected = rows.filter((r) => window.includes(+r.strprc)).map((r) => `NFO|${r.token}`);
    expect(transport.subscribedKeys().sort()).toEqual([SPOT_KEY, SENSEX_KEY, ...expected].sort());
    expect(facade.markStale(NOW_MS).sort()).toEqual([]);
  });

  it('selectExpiry during an in-progress select returns without changing state', async () => {
    const { facade, store, rest } = setup({ spotless: true });
    void facade.select(NIFTY);
    await settle(); // expiries loaded, waiting for spot
    expect(store.loadState()).toBe('loading');

    await facade.selectExpiry('2026-11-10');

    expect(store.loadState()).toBe('loading');
    expect(store.selectedExpiry()).toBeNull();
    expect(rest.getOptionChain).not.toHaveBeenCalled();
  });

  it('sets the error state when no spot tick arrives within 5 s', async () => {
    const { facade, store, rest, fire, timers } = setup({ spotless: true });
    const done = facade.select(NIFTY);
    await settle();
    expect(store.loadState()).toBe('loading');
    expect(timers.some((t) => t.ms === 5000 && !t.cancelled)).toBe(true);
    fire(5000);
    await done;
    expect(store.loadState()).toBe('error');
    expect(rest.getOptionChain).not.toHaveBeenCalled();
  });

  it('cancels the spot timeout once spot arrives', async () => {
    const { facade, timers } = setup();
    await facade.select(NIFTY);
    expect(timers.filter((t) => t.ms === 5000 && !t.cancelled)).toHaveLength(0);
  });
});

describe('ChainFeedFacade: background tab, recovery, expiry roll-off', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a chain opened in a hidden tab (no animation frames) still loads: spot resolves from the ack itself', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    vi.stubGlobal('requestAnimationFrame', undefined);
    // The default frame scheduler: in a hidden tab it falls back to a 250 ms timer (real timers here).
    const { facade, store } = setup({ buffer: () => new TickBuffer(Date.now) }); // a moving clock for the throttle
    await facade.select(NIFTY);
    expect(store.spot()).toBe(24010);
    expect(store.loadState()).toBe('ready');
    expect(store.selectedExpiry()?.iso).toBe('2026-11-03');
    // Contract acks reach the store on the hidden-tab timer, without any frame.
    await new Promise((r) => setTimeout(r, 300));
    expect(store.quotes().get('NFO|300')!().ltp).toBe(100);
  });

  it('even when frames never come, the underlying ack resolves the spot wait directly', async () => {
    const { facade, store } = setup({ buffer: (clock) => new TickBuffer(clock, () => undefined, 0) });
    await facade.select(NIFTY);
    expect(store.loadState()).toBe('ready');
    expect(store.spot()).toBe(24010);
  });

  it('reconnect() after a WS session expiry reconnects the transport and reloads the chain', async () => {
    const { facade, store, transport, rest } = setup();
    await facade.select(NIFTY, '2026-11-10');
    transport.expireSession();
    TestBed.tick();
    expect(store.sessionExpired()).toBe(true);
    expect(transport.subscribedKeys()).toEqual([]);
    const connect = vi.spyOn(transport, 'connect');
    rest.getOptionChain.mockClear();

    await facade.reconnect();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(transport.status()).toBe('open');
    expect(store.sessionExpired()).toBe(false);
    expect(store.loadState()).toBe('ready');
    expect(store.selectedExpiry()?.iso).toBe('2026-11-10'); // same underlying and expiry
    expect(rest.getOptionChain).toHaveBeenCalledTimes(1);
    expect(transport.subscribedKeys().sort()).toEqual([SPOT_KEY, SENSEX_KEY, ...keysOf(ROWS_10)].sort());
  });

  it('reconnect() after a REST session expiry (socket still open) reloads without reconnecting', async () => {
    const { facade, store, transport, rest } = setup();
    await facade.select(NIFTY);
    rest.getOptionChain.mockRejectedValueOnce(new SessionExpiredError());
    await facade.selectExpiry('2026-11-10');
    expect(store.sessionExpired()).toBe(true);
    const connect = vi.spyOn(transport, 'connect');
    await facade.reconnect();
    expect(connect).not.toHaveBeenCalled();
    expect(store.sessionExpired()).toBe(false);
    expect(store.loadState()).toBe('ready');
    expect(store.selectedExpiry()?.iso).toBe('2026-11-03');
  });

  it('reconnect() swallows a failed connect and still re-selects', async () => {
    const { facade, store, transport } = setup();
    await facade.select(NIFTY);
    transport.close();
    vi.spyOn(transport, 'connect').mockRejectedValueOnce(new Error('rejected'));
    await expect(facade.reconnect()).resolves.toBeUndefined();
    expect(store.underlying()).toBe(NIFTY);
  });

  it('markSessionExpired() (search / URL resolve saw an expired session) stops the view like a REST expiry', async () => {
    const { facade, store, transport } = setup();
    await facade.select(NIFTY);
    facade.markSessionExpired();
    expect(store.sessionExpired()).toBe(true);
    expect(transport.subscribedKeys()).toEqual([]);
  });

  it('pruneExpired drops an expiry past 15:30 IST and moves a selected one to the next expiry', async () => {
    const { facade, store, rest } = setup();
    await facade.select(NIFTY);
    expect(store.selectedExpiry()?.iso).toBe('2026-11-03');
    facade.pruneExpired(Date.parse('2026-11-03T15:00:00+05:30'));
    expect(store.expiries()).toHaveLength(3); // still trading
    rest.getOptionChain.mockClear();

    facade.pruneExpired(Date.parse('2026-11-03T15:30:00+05:30'));
    await settle();

    expect(store.expiries().map((e) => e.iso)).toEqual(['2026-11-10', '2026-11-17']);
    expect(store.selectedExpiry()?.iso).toBe('2026-11-10');
    expect(rest.getOptionChain).toHaveBeenCalledWith('NFO', 'NIFTY10NOV26P24000', 24010, 100);
  });

  it('pruneExpired leaves an unaffected selection alone', async () => {
    const { facade, store, rest } = setup();
    await facade.select(NIFTY, '2026-11-17');
    rest.getOptionChain.mockClear();
    facade.pruneExpired(Date.parse('2026-11-04T10:00:00+05:30'));
    expect(store.expiries().map((e) => e.iso)).toEqual(['2026-11-10', '2026-11-17']);
    expect(store.selectedExpiry()?.iso).toBe('2026-11-17');
    expect(rest.getOptionChain).not.toHaveBeenCalled();
  });
});
