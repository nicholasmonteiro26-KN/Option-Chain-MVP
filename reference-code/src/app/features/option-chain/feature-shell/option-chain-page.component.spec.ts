import { Location } from '@angular/common';
import { provideLocationMocks, SpyLocation } from '@angular/common/testing';
import { Provider, ProviderToken, provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { analyzeChain } from '@option-analytics/analyze';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_POST_SCHEDULER, AnalyticsBridge, WORKER_FACTORY, WorkerLike } from '../analytics/analytics.bridge';
import type { FromWorker, ToWorker } from '../analytics/protocol';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { MockFeedTransport } from '../data-access/feed/mock-feed.transport';
import { TickBuffer } from '../data-access/feed/tick-buffer';
import { FEED_TRANSPORT, FeedTransport } from '../data-access/feed/transport';
import { SessionExpiredError } from '../data-access/kambala/kambala.types';
import { isNseFoSessionOpen, MARKET_SESSION_RULE } from '../data-access/market-session.service';
import { OptionChainStore } from '../data-access/option-chain.store';
import { PREFS_STORAGE } from '../data-access/prefs.store';
import { KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { MockKambalaRestClient } from '../data-access/testing/mock-kambala-rest.client';
import { MockMarket } from '../data-access/testing/mock-market';
import { UnderlyingBarComponent } from '../ui/underlying-bar/underlying-bar.component';
import { ContractPayload, OptionChainPageComponent } from './option-chain-page.component';
import { OPTION_CHAIN_MOCK_MODE, OPTION_CHAIN_USER_ID, provideOptionChain } from './option-chain.providers';

/** 2026-10-29 11:30 IST. */
const NOW = Date.UTC(2026, 9, 29, 6, 0, 0);

/** Runs the real analysis synchronously, in-process. */
class InProcessWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(m: ToWorker): void {
    this.onmessage?.({ data: { v: 1, kind: 'result', id: m.id, chain: m.chain, result: analyzeChain(m.input) } } as MessageEvent<FromWorker>);
  }
  terminate(): void { /* nothing to free */ }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

interface Ctx {
  fixture: ComponentFixture<OptionChainPageComponent>;
  el: HTMLElement;
  store: OptionChainStore;
  transport: MockFeedTransport;
  storage: Map<string, string>;
  advance: (ms: number) => Promise<void>;
  stable: () => Promise<void>;
  /** Moves the clock without firing timers (the next advance() fires everything now overdue). */
  jump: (ms: number) => void;
  /** A service from the page's own (component) injector, where the feature providers live. */
  get: <T>(token: ProviderToken<T>) => T;
}

interface SetupOpts {
  mock?: boolean;
  now?: number;
  /** Extra component-level providers (override the defaults below). */
  providers?: Provider[];
  /** Hands the page a different transport object around the mock (e.g. one that is not a MockFeedTransport). */
  wrapTransport?: (t: MockFeedTransport) => FeedTransport;
}

async function setup(query: Record<string, string>, opts: SetupOpts = {}): Promise<Ctx> {
  let now = opts.now ?? NOW;
  const timers: { cb: () => void; at: number; live: boolean }[] = [];
  const scheduler = (cb: () => void, ms: number) => {
    const t = { cb, at: now + ms, live: true };
    timers.push(t);
    return () => { t.live = false; };
  };
  const market = new MockMarket({ seed: 7, now: () => now });
  const transport = new MockFeedTransport({
    seed: (k) => market.seed(k),
    marketTick: (keys, random) => market.tick(keys, random),
    random: market.random,
    scheduler: () => () => undefined, // no live ticks: the test drives the feed
  });
  const storage = new Map<string, string>();

  TestBed.configureTestingModule({
    imports: [OptionChainPageComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideLocationMocks(),
      { provide: OPTION_CHAIN_MOCK_MODE, useValue: opts.mock ?? true },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
    ],
  });
  // The feature providers are the page's own (component providers): override them there.
  TestBed.overrideComponent(OptionChainPageComponent, {
    set: {
      providers: [
        ...provideOptionChain(),
        // Real exchange hours (mock mode would otherwise be always open): NOW is a Thursday 11:30 IST.
        { provide: MARKET_SESSION_RULE, useValue: isNseFoSessionOpen },
        { provide: OPTION_CHAIN_USER_ID, useValue: 'u1' },
        { provide: MockMarket, useValue: market },
        { provide: KambalaRestClient, useValue: new MockKambalaRestClient(market) },
        { provide: FEED_TRANSPORT, useValue: opts.wrapTransport ? opts.wrapTransport(transport) : transport },
        { provide: TickBuffer, useValue: new TickBuffer(() => now, (fn) => fn(), 0) },
        { provide: CHAIN_FEED_CLOCK, useValue: () => now },
        { provide: CHAIN_FEED_SCHEDULER, useValue: scheduler },
        { provide: WORKER_FACTORY, useValue: () => new InProcessWorker() },
        { provide: ANALYTICS_POST_SCHEDULER, useValue: (fn: () => void) => fn() },
        {
          provide: PREFS_STORAGE,
          useValue: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) },
        },
        ...(opts.providers ?? []),
      ],
    },
  });
  const fixture = TestBed.createComponent(OptionChainPageComponent);
  const get = <T>(token: ProviderToken<T>): T => fixture.debugElement.injector.get(token);
  const stable = async () => {
    for (let i = 0; i < 5; i++) await settle();
    await fixture.whenStable();
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = Math.max(now, next.at); // overdue timers (after jump) fire at the current time
      next.cb();
    }
    now = end;
    await stable();
  };
  await stable();
  await advance(1000); // one analysis round
  return {
    fixture, el: fixture.nativeElement as HTMLElement, store: get(OptionChainStore), transport, storage,
    advance, stable, jump: (ms: number) => { now += ms; }, get,
  };
}

/** The last URL the page wrote (SpyLocation keeps the query apart from path()). */
const url = () => (TestBed.inject(Location) as SpyLocation).urlChanges.at(-1) ?? '';
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const q = (ctx: Ctx, sel: string) => ctx.el.querySelector<HTMLElement>(sel);

describe('OptionChainPageComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('?underlying=BSE:SENSEX loads SENSEX and its chain', async () => {
    const ctx = await setup({ underlying: 'BSE:SENSEX' });
    expect(ctx.store.underlying()?.sym).toBe('SENSEX');
    expect(text(q(ctx, '.und-bar'))).toContain('SENSEX');
    expect(ctx.store.loadState()).toBe('ready');
    expect(ctx.el.querySelectorAll('table.oc tbody tr:not(.spot)')).toHaveLength(16);
    expect(q(ctx, '[data-testid="spot-row"]')).not.toBeNull();
    expect(url()).toContain('underlying=BSE:SENSEX');
    expect(url()).toContain('expiry=2026-11-05');
  });

  it('?underlying=XYZ falls back to NIFTY', async () => {
    const ctx = await setup({ underlying: 'XYZ' });
    expect(ctx.store.underlying()?.sym).toBe('NIFTY');
    expect(text(q(ctx, '.und-bar'))).toContain('NIFTY');
    expect(text(q(ctx, '.und-bar'))).toContain('Lot 65');
  });

  it('resolves a stock from the URL through search, and honours ?expiry', async () => {
    const ctx = await setup({ underlying: 'NSE:SBIN', expiry: '2026-12-29' });
    expect(ctx.store.underlying()).toMatchObject({ sym: 'SBIN', exch: 'NSE', foExch: 'NFO', isIndex: false });
    expect(ctx.store.selectedExpiry()?.iso).toBe('2026-12-29');
    expect(text(q(ctx, '.und-bar'))).toContain('Lot 750');
  });

  it('selecting the 28 Jan 2027 SENSEX expiry shows Lot 25 and updates the URL', async () => {
    const ctx = await setup({ underlying: 'BSE:SENSEX' });
    expect(text(q(ctx, '.und-bar'))).toContain('Lot 20');
    q(ctx, '[data-testid="expiry-2027-01-28"]')!.click();
    await ctx.stable();
    expect(ctx.store.selectedExpiry()?.iso).toBe('2027-01-28');
    expect(text(q(ctx, '.und-bar'))).toContain('Lot 25');
    expect(url()).toContain('expiry=2027-01-28');
  });

  it('shows header stats from the analysis', async () => {
    const ctx = await setup({});
    expect(ctx.store.analytics()).not.toBeNull();
    const strip = text(q(ctx, 'oc-expiry-strip'));
    expect(strip).toMatch(/ATM IV\s*\d+\.\d\d/);
    expect(strip).toMatch(/Max Pain\s*[\d,]+/);
    expect(text(q(ctx, 'oc-footer-actions'))).toMatch(/Fwd \d+\.\d · ATM \d+ · 03 Nov 2026/);
  });

  it('preset Greeks puts IV in the header and saves the preset', async () => {
    const ctx = await setup({});
    q(ctx, '[data-testid="preset-greeks"]')!.click();
    await ctx.stable();
    expect(text(q(ctx, 'table.oc thead'))).toContain('IV');
    expect(JSON.parse(ctx.storage.get('ts.optionChain.prefs.v1:u1')!).preset).toBe('greeks');
  });

  it('choosing Custom shows the editor; Done collapses it to Edit columns; Price hides it', async () => {
    const ctx = await setup({});
    expect(q(ctx, '[data-testid="custom-editor"]')).toBeNull();
    q(ctx, '[data-testid="preset-custom"]')!.click();
    await ctx.stable();
    expect(q(ctx, '[data-testid="custom-editor"]')).not.toBeNull();
    const done = [...ctx.el.querySelectorAll<HTMLButtonElement>('[data-testid="custom-editor"] button')].find((b) => text(b) === 'Done')!;
    done.click();
    await ctx.stable();
    expect(q(ctx, '[data-testid="custom-editor"]')).toBeNull();
    const edit = [...ctx.el.querySelectorAll<HTMLButtonElement>('oc-view-toolbar button')].find((b) => text(b) === 'Edit columns')!;
    edit.click();
    await ctx.stable();
    expect(q(ctx, '[data-testid="custom-editor"]')).not.toBeNull();
    q(ctx, '[data-testid="preset-price"]')!.click();
    await ctx.stable();
    expect(q(ctx, '[data-testid="custom-editor"]')).toBeNull();
  });

  it('unticking a Custom column removes it from the table and persists it', async () => {
    const ctx = await setup({});
    q(ctx, '[data-testid="preset-custom"]')!.click();
    await ctx.stable();
    expect(text(q(ctx, 'table.oc thead'))).toContain('OI Chg');
    const box = ctx.el.querySelector<HTMLInputElement>('[data-testid="custom-editor"] input[type="checkbox"][value="oiChg"]')!;
    box.click();
    await ctx.stable();
    expect(text(q(ctx, 'table.oc thead'))).not.toContain('OI Chg');
    const saved = JSON.parse(ctx.storage.get('ts.optionChain.prefs.v1:u1')!);
    expect(saved.preset).toBe('custom');
    expect(saved.custom.columns).not.toContain('oiChg');
  });

  it('search sets resultsFor to the trimmed query and shows results; choosing one switches underlying', async () => {
    const ctx = await setup({});
    const input = q(ctx, '[data-testid="underlying-search"]') as HTMLInputElement;
    input.value = ' SBI';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300)); // the bar's 250 ms debounce
    await ctx.stable();
    const bar = ctx.fixture.debugElement.query(By.directive(UnderlyingBarComponent)).componentInstance as UnderlyingBarComponent;
    expect(bar.resultsFor()).toBe('SBI');
    const options = [...ctx.el.querySelectorAll('[role="option"]')];
    expect(options.map(text).some((t) => t.includes('SBIN'))).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await ctx.stable();
    expect(ctx.store.underlying()?.sym).toBe('SBIN');
    expect(url()).toContain('underlying=NSE:SBIN');
  });

  it('quick switch to SENSEX selects it', async () => {
    const ctx = await setup({});
    const btn = [...ctx.el.querySelectorAll<HTMLButtonElement>('.qbtn')].find((b) => text(b).startsWith('SENSEX'))!;
    btn.click();
    await ctx.stable();
    expect(ctx.store.underlying()?.sym).toBe('SENSEX');
  });

  it('CSV downloads optionchain_<SYM>_<YYYYMMDD>_<HHMM>.csv', async () => {
    const ctx = await setup({});
    const created: Blob[] = [];
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn((b: Blob) => { created.push(b); return 'blob:x'; });
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
    const csv = [...ctx.el.querySelectorAll<HTMLButtonElement>('oc-view-toolbar button')].find((b) => text(b).includes('CSV'))!;
    csv.click();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe('optionchain_NIFTY_20261103_1130.csv');
    expect(created[0]!.type).toContain('text/csv');
  });

  it('trade in mock mode shows the order-window status line', async () => {
    const ctx = await setup({});
    const b = ctx.el.querySelector<HTMLButtonElement>('table.oc .acts.ce .b')!;
    b.click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toMatch(
      /^Opens the order window: BUY NIFTY 03 Nov \d+ CE @ \d+\.\d\d · lot 65$/,
    );
  });

  it('checkboxes count into the footer and Add to Basket reports in mock mode', async () => {
    const ctx = await setup({});
    const boxes = ctx.el.querySelectorAll<HTMLInputElement>('table.oc td.chk input');
    boxes[0]!.click();
    boxes[1]!.click();
    await ctx.stable();
    expect(text(q(ctx, 'oc-footer-actions'))).toContain('Add to Basket (2)');
    const basket = [...ctx.el.querySelectorAll<HTMLButtonElement>('oc-footer-actions button')].find((x) => text(x).startsWith('Add to Basket'))!;
    basket.click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toContain('basket');
  });

  it('a feed drop shows the reconnecting banner, which clears on reconnect', async () => {
    const ctx = await setup({});
    expect(q(ctx, '[data-testid="status-banner"]')).toBeNull();
    ctx.transport.drop();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-banner"]'))).toContain('Reconnecting');
  });

  it('session expiry shows the error banner', async () => {
    const ctx = await setup({});
    ctx.transport.expireSession();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-banner"]'))).toContain('Could not load the option chain for NIFTY');
  });

  it('asks for a fresh analysis on every chain change (expiry switch), market open or not', async () => {
    const ctx = await setup({});
    const bridge = ctx.get(AnalyticsBridge);
    const spy = vi.spyOn(bridge, 'requestAnalysis');
    q(ctx, '[data-testid="expiry-2026-11-10"]')!.click();
    await ctx.stable();
    expect(spy).toHaveBeenCalled();
  });

  it('exposes window.__mockFeed and window.__ocMetrics in mock mode only', async () => {
    const ctx = await setup({});
    const w = window as unknown as { __mockFeed?: { drop(): void; setSpot(v: number): void }; __ocMetrics?: { lastRoundTripMs: number | null } };
    expect(typeof w.__mockFeed?.drop).toBe('function');
    expect(typeof w.__mockFeed?.setSpot).toBe('function');
    expect(w.__ocMetrics?.lastRoundTripMs).toBe(0);
    ctx.fixture.destroy();
    expect(w.__mockFeed).toBeUndefined();
    TestBed.resetTestingModule();
    await setup({}, { mock: false });
    expect(w.__mockFeed).toBeUndefined();
  });

  it('marks stale legs every 5 s', async () => {
    const ctx = await setup({});
    await ctx.advance(36_000); // never-ticked legs go stale 30 s after the chain load; checked every 5 s
    expect(ctx.el.querySelectorAll('table.oc td.stale').length).toBeGreaterThan(0);
  });

  it('shows the underlying LTP and change, and live prices on both quick buttons', async () => {
    const ctx = await setup({});
    expect(text(q(ctx, '[data-testid="underlying-ltp"]'))).toBe('22,873.40');
    expect(text(q(ctx, '.und-bar .chg'))).toBe('+166.55 (+0.73%)');
    const quick = [...ctx.el.querySelectorAll('.qbtn')].map(text);
    expect(quick[0]).toMatch(/^NIFTY 22,873\.40 \+0\.73%$/);
    expect(quick[1]).toMatch(/^SENSEX 73,830\.29 \+0\.80%$/); // not selected, still live (D18)
  });

  it('a stale spot-line window never hides the line: the spot row stays in view for SENSEX Jan-27', async () => {
    const ctx = await setup({ underlying: 'BSE:SENSEX', expiry: '2027-01-28' });
    const rows = [...ctx.el.querySelectorAll('table.oc tbody tr')];
    const spotAt = rows.findIndex((r) => r.classList.contains('spot'));
    expect(spotAt).toBe(8); // 8 strike rows, then the line, then 8 more
    expect(rows).toHaveLength(17);
  });

  it('applying a saved Custom view makes it the working view and saves it', async () => {
    const ctx = await setup({});
    q(ctx, '[data-testid="preset-custom"]')!.click();
    await ctx.stable();
    const name = ctx.el.querySelector<HTMLInputElement>('[data-testid="custom-editor"] .new input[type="text"]')!;
    name.value = 'Straddles';
    name.dispatchEvent(new Event('input'));
    // Switch to strike columns, keep only Straddle, save as a view.
    [...ctx.el.querySelectorAll<HTMLButtonElement>('[data-testid="custom-editor"] button')].find((b) => text(b) === 'Strike columns')!.click();
    await ctx.stable();
    ctx.el.querySelector<HTMLInputElement>('[data-testid="custom-editor"] input[type="checkbox"][value="straddle"]')!.click();
    await ctx.stable();
    [...ctx.el.querySelectorAll<HTMLButtonElement>('[data-testid="custom-editor"] button')].find((b) => text(b) === 'New')!.click();
    await ctx.stable();
    // Go back to side columns, then apply the saved view.
    [...ctx.el.querySelectorAll<HTMLButtonElement>('[data-testid="custom-editor"] button')].find((b) => text(b) === 'Side columns')!.click();
    await ctx.stable();
    expect(text(q(ctx, 'table.oc thead'))).toContain('Calls');
    q(ctx, '[aria-label="Apply Straddles"]')!.click();
    await ctx.stable();
    expect(text(q(ctx, 'table.oc thead'))).not.toContain('Calls');
    expect(text(q(ctx, 'table.oc thead'))).toContain('Straddle');
    const saved = JSON.parse(ctx.storage.get('ts.optionChain.prefs.v1:u1')!);
    expect(saved.custom).toEqual({ mode: 'strike', columns: ['straddle'] });
  });

  it('outside mock mode a trade shows no simulated hand-off', async () => {
    const ctx = await setup({}, { mock: false });
    ctx.el.querySelector<HTMLButtonElement>('table.oc .acts.ce .b')!.click();
    await ctx.stable();
    expect(q(ctx, '[data-testid="status-line"]')).toBeNull();
  });

  it('destroying the page closes the transport and unsubscribes every key', async () => {
    const ctx = await setup({});
    expect(ctx.transport.subscribedKeys().length).toBeGreaterThan(2);
    ctx.fixture.destroy();
    expect(ctx.transport.status()).toBe('closed');
    expect(ctx.transport.subscribedKeys()).toEqual([]);
  });

  it('closes a non-mock transport (e.g. the Noren socket) on destroy too', async () => {
    const close = vi.fn();
    const ctx = await setup({}, {
      mock: false,
      wrapTransport: (t) => ({
        connect: () => t.connect(), close: () => { close(); t.close(); }, send: (m) => t.send(m),
        subscribe: (k) => t.subscribe(k), unsubscribe: (k) => t.unsubscribe(k),
        messages: t.messages, status: t.status, limitReached: t.limitReached,
      }),
    });
    expect(ctx.store.loadState()).toBe('ready');
    ctx.fixture.destroy();
    expect(close).toHaveBeenCalledTimes(1);
    expect(ctx.transport.subscribedKeys()).toEqual([]);
  });

  // ---- market session (exchange hours, not the feed status) ----

  it('after hours the banner says Market closed, one analysis still runs, and nothing is marked stale', async () => {
    const ctx = await setup({}, { now: Date.parse('2026-10-29T16:00:00+05:30') });
    expect(ctx.transport.status()).toBe('open'); // the socket is up: the banner follows exchange hours
    expect(text(q(ctx, '[data-testid="status-banner"]'))).toContain('Market closed');
    expect(ctx.store.analytics()).not.toBeNull();
    await ctx.advance(36_000);
    expect(ctx.el.querySelectorAll('table.oc td.stale')).toHaveLength(0);
  });

  it('after hours, acks that arrive after the chain is set still reach the analysis (ATM IV, Max Pain, Cum OI)', async () => {
    const held: object[] = [];
    let release = () => { /* set by wrapTransport */ };
    const ctx = await setup({}, {
      now: Date.parse('2026-10-29T16:00:00+05:30'),
      wrapTransport: (t) => {
        const out = new Subject<object>();
        let holding = true;
        t.messages.subscribe((m) => {
          // Hold the option contracts' acks (the underlying's goes through, so spot is known); release them later.
          if (holding && (m as { e?: string }).e === 'NFO') held.push(m);
          else out.next(m);
        });
        release = () => { holding = false; for (const m of held.splice(0)) out.next(m); };
        return {
          connect: () => t.connect(), close: () => t.close(), send: (m) => t.send(m),
          subscribe: (k) => t.subscribe(k), unsubscribe: (k) => t.unsubscribe(k),
          messages: out.asObservable(), status: t.status, limitReached: t.limitReached,
        };
      },
    });
    expect(held.length).toBeGreaterThan(0);
    release();
    await ctx.stable();
    await ctx.advance(2000);
    const a = ctx.store.analytics();
    expect(a?.atmIv).not.toBeNull();
    expect(a?.maxPain).not.toBeNull();
    expect(a?.cumOi).toBeGreaterThan(0);
  });

  it('the banner flips to Market closed on the 30 s session tick at 15:30 IST', async () => {
    const ctx = await setup({}, { now: Date.parse('2026-10-29T15:29:40+05:30') });
    expect(q(ctx, '[data-testid="status-banner"]')).toBeNull();
    await ctx.advance(30_000);
    expect(text(q(ctx, '[data-testid="status-banner"]'))).toContain('Market closed');
  });

  it('a feed drop still shows Reconnecting after hours (reconnecting outranks closed)', async () => {
    const ctx = await setup({}, { now: Date.parse('2026-10-31T11:00:00+05:30') }); // Saturday
    expect(text(q(ctx, '[data-testid="status-banner"]'))).toContain('Market closed');
    ctx.transport.drop();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-banner"]'))).toContain('Reconnecting');
  });

  it('an expiry passing 15:30 while open leaves the strip and the next one is selected (session tick)', async () => {
    const ctx = await setup({});
    expect(ctx.store.selectedExpiry()?.iso).toBe('2026-11-03');
    ctx.jump(Date.parse('2026-11-03T15:30:30+05:30') - Date.parse('2026-10-29T11:30:01+05:30'));
    await ctx.advance(30_000);
    expect(ctx.store.expiries().map((e) => e.iso)).not.toContain('2026-11-03');
    expect(ctx.store.selectedExpiry()?.iso).toBe('2026-11-10');
    expect(q(ctx, '[data-testid="expiry-2026-11-03"]')).toBeNull();
    expect(url()).toContain('expiry=2026-11-10');
  });

  // ---- session expiry and recovery ----

  it('Retry after a session expiry reconnects the transport and reloads the chain', async () => {
    const ctx = await setup({});
    ctx.transport.expireSession();
    await ctx.stable();
    expect(ctx.transport.status()).toBe('session-expired');
    const retry = ctx.el.querySelector<HTMLButtonElement>('[data-testid="status-banner"] button')!;
    retry.click();
    await ctx.stable();
    expect(ctx.transport.status()).toBe('open');
    expect(ctx.store.sessionExpired()).toBe(false);
    expect(ctx.store.loadState()).toBe('ready');
    expect(ctx.store.selectedExpiry()?.iso).toBe('2026-11-03');
    expect(ctx.el.querySelectorAll('table.oc tbody tr:not(.spot)').length).toBeGreaterThan(0);
    expect(q(ctx, '[data-testid="status-banner"]')).toBeNull();
  });

  it('a session expiry during search sets sessionExpired (not swallowed as no match)', async () => {
    const ctx = await setup({});
    vi.spyOn(ctx.get(KambalaRestClient), 'searchScrip').mockRejectedValue(new SessionExpiredError());
    const input = q(ctx, '[data-testid="underlying-search"]') as HTMLInputElement;
    input.value = 'SBI';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300)); // the bar's 250 ms debounce
    await ctx.stable();
    expect(ctx.store.sessionExpired()).toBe(true);
    expect(text(q(ctx, '[data-testid="status-banner"]'))).toContain('Could not load the option chain');
  });

  it('a session expiry while resolving the URL underlying is flagged; Retry resolves it again', async () => {
    vi.spyOn(MockKambalaRestClient.prototype, 'searchScrip').mockRejectedValueOnce(new SessionExpiredError());
    const ctx = await setup({ underlying: 'NSE:SBIN' });
    expect(ctx.store.sessionExpired()).toBe(true);
    expect(ctx.store.underlying()).toBeNull(); // not silently replaced by NIFTY
    ctx.el.querySelector<HTMLButtonElement>('[data-testid="status-banner"] button')!.click();
    await ctx.stable();
    expect(ctx.store.underlying()?.sym).toBe('SBIN');
    expect(ctx.store.loadState()).toBe('ready');
  });

  it('watchlist / basket items carry exch and the raw token besides the feed key', async () => {
    const ctx = await setup({});
    const boxes = ctx.el.querySelectorAll<HTMLInputElement>('table.oc td.chk input');
    boxes[0]!.click();
    await ctx.stable();
    const items = (ctx.fixture.componentInstance as unknown as { checkedContracts(): ContractPayload[] }).checkedContracts();
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.exch).toBe('NFO');
    expect(item!.token).toBe(`NFO|${item!.rawToken}`);
    expect(item!.rawToken).not.toContain('|');
    expect(item!.tsym).toMatch(/^NIFTY/);
  });
});

describe('OptionChainPageComponent lifetime (real feature providers, mock feed)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const waitFor = async (cond: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };

  it('each page instance gets its own feed; destroying one closes it, a fresh one works', async () => {
    TestBed.configureTestingModule({
      imports: [OptionChainPageComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideLocationMocks(),
        { provide: OPTION_CHAIN_MOCK_MODE, useValue: true },
        { provide: WORKER_FACTORY, useValue: () => new InProcessWorker() },
        { provide: ANALYTICS_POST_SCHEDULER, useValue: (fn: () => void) => fn() },
        { provide: PREFS_STORAGE, useValue: { getItem: () => null, setItem: () => undefined } },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } },
      ],
    });
    const first = TestBed.createComponent(OptionChainPageComponent);
    const store1 = first.debugElement.injector.get(OptionChainStore);
    const feed1 = first.debugElement.injector.get(FEED_TRANSPORT) as MockFeedTransport;
    expect(await waitFor(() => store1.loadState() === 'ready')).toBe(true);
    expect(feed1.status()).toBe('open');
    first.destroy();
    expect(feed1.status()).toBe('closed');
    expect(feed1.subscribedKeys()).toEqual([]);

    const second = TestBed.createComponent(OptionChainPageComponent);
    const store2 = second.debugElement.injector.get(OptionChainStore);
    const feed2 = second.debugElement.injector.get(FEED_TRANSPORT) as MockFeedTransport;
    expect(feed2).not.toBe(feed1);
    expect(store2).not.toBe(store1);
    expect(await waitFor(() => store2.loadState() === 'ready')).toBe(true);
    expect(feed2.status()).toBe('open');
    expect(store2.spot()).not.toBeNull();
    second.destroy();
    expect(feed2.status()).toBe('closed');
  });
});
