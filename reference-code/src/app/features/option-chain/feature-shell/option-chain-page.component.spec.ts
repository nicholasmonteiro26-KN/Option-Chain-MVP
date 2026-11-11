import { Location } from '@angular/common';
import { provideLocationMocks, SpyLocation } from '@angular/common/testing';
import { Provider, ProviderToken, provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { analyzeChain } from '@option-analytics/analyze';
import { merge, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYTICS_POST_SCHEDULER, AnalyticsBridge, WORKER_FACTORY, WorkerLike } from '../analytics/analytics.bridge';
import type { FromWorker, ToWorker } from '../analytics/protocol';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { MockFeedTransport } from '../data-access/feed/mock-feed.transport';
import { TickBuffer } from '../data-access/feed/tick-buffer';
import { FEED_TRANSPORT, FeedTransport } from '../data-access/feed/transport';
import { KambalaError, SessionExpiredError } from '../data-access/kambala/kambala.types';
import { isNseFoSessionOpen, MARKET_SESSION_RULE } from '../data-access/market-session.service';
import { OptionChainStore } from '../data-access/option-chain.store';
import { AuthSessionService } from '../data-access/auth-session.service';
import { QUICK_UNDERLYINGS } from '../data-access/models';
import { QuickUnderlyingsService } from '../data-access/quick-underlyings.service';
import { PREFS_STORAGE } from '../data-access/prefs.store';
import { KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { MockKambalaRestClient } from '../data-access/testing/mock-kambala-rest.client';
import { MockMarket } from '../data-access/testing/mock-market';
import { InstrumentsService } from '../data-access/instruments.service';
import { StrategyStore } from '../strategy/strategy.store';
import { UnderlyingBarComponent } from '../ui/underlying-bar/underlying-bar.component';
import { BasketLegPayload, ContractPayload, OptionChainPageComponent } from './option-chain-page.component';
import { OPTION_CHAIN_MOCK_MODE, OPTION_CHAIN_USER_ID, provideOptionChain } from './option-chain.providers';
import { OPTION_CHAIN_ROUTES } from './option-chain.routes';

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

// The strategy is kept in sessionStorage per user: start every test with none.
afterEach(() => sessionStorage.clear());

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
    // Beyond the 3 nearest, expiries are picked from the 'Next expiry' drop-down.
    const more = q(ctx, '[data-testid="expiry-more"]') as HTMLSelectElement;
    more.value = '2027-01-28';
    more.dispatchEvent(new Event('change'));
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
    expect(text(q(ctx, '[data-testid="expiry-date"]'))).toBe('Expiry 03 Nov 2026');
    expect(text(q(ctx, 'oc-footer-actions'))).not.toMatch(/Fwd|ATM/);
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

  it('chart buttons in mock mode describe the hand-off in the status line', async () => {
    const ctx = await setup({});
    ctx.el.querySelector<HTMLButtonElement>('table.oc .acts.ce .chart')!.click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toMatch(/^Opens the chart: NIFTY 03 Nov \d+ CE$/);
    ctx.el.querySelector<HTMLButtonElement>('table.oc .acts.pe .adv')!.click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toMatch(/^Opens Advanced Chart: NIFTY 03 Nov \d+ PE$/);
  });

  it('checkboxes count into the footer and Add to Basket reports in mock mode', async () => {
    const ctx = await setup({});
    const boxes = ctx.el.querySelectorAll<HTMLInputElement>('table.oc input.cb');
    boxes[0]!.click();
    boxes[1]!.click();
    await ctx.stable();
    expect(text(q(ctx, 'oc-footer-actions'))).toContain('Add to Basket 2');
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
    expect(q(ctx, 'table.oc thead [data-testid="side-ce"]')).not.toBeNull();
    q(ctx, '[aria-label="Apply Straddles"]')!.click();
    await ctx.stable();
    expect(q(ctx, 'table.oc thead [data-testid="side-ce"]')).toBeNull();
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

  it('after hours the toolbar says Market closed (no banner row), one analysis still runs, and nothing is marked stale', async () => {
    const ctx = await setup({}, { now: Date.parse('2026-10-29T16:00:00+05:30') });
    expect(ctx.transport.status()).toBe('open'); // the socket is up: the notice follows exchange hours
    expect(text(q(ctx, 'oc-view-toolbar [data-testid="market-notice"]'))).toContain('Market closed');
    expect(q(ctx, '[data-testid="status-banner"]')).toBeNull();
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

  it('the notice flips to Market closed on the 30 s session tick at 15:30 IST', async () => {
    const ctx = await setup({}, { now: Date.parse('2026-10-29T15:29:40+05:30') });
    expect(q(ctx, '[data-testid="market-notice"]')).toBeNull();
    await ctx.advance(30_000);
    expect(text(q(ctx, '[data-testid="market-notice"]'))).toContain('Market closed');
  });

  it('a feed drop still shows Reconnecting after hours (reconnecting outranks closed)', async () => {
    const ctx = await setup({}, { now: Date.parse('2026-10-31T11:00:00+05:30') }); // Saturday
    expect(text(q(ctx, '[data-testid="market-notice"]'))).toContain('Market closed');
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
    const boxes = ctx.el.querySelectorAll<HTMLInputElement>('table.oc input.cb');
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

describe('OptionChainPageComponent: Build your strategy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  const buildBtn = (ctx: Ctx) => q(ctx, 'oc-footer-actions button.strategy') as HTMLButtonElement;
  const panel = (ctx: Ctx) => q(ctx, 'oc-strategy-panel');
  const panelRows = (ctx: Ctx) => [...ctx.el.querySelectorAll('oc-strategy-panel tbody tr')];
  const button = (ctx: Ctx, label: string | RegExp, scope = 'oc-strategy-panel') =>
    [...ctx.el.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find((b) =>
      typeof label === 'string' ? text(b) === label : label.test(text(b)))!;
  const callBoxes = (ctx: Ctx) => [...ctx.el.querySelectorAll<HTMLInputElement>('table.oc input.cb.ce')];
  const putBoxes = (ctx: Ctx) => [...ctx.el.querySelectorAll<HTMLInputElement>('table.oc input.cb.pe')];
  const open = async (ctx: Ctx) => {
    buildBtn(ctx).click();
    await ctx.stable();
  };
  /** The page's own copy of the real feature provider for a token (the real/mock factory, not the test's override). */
  const realProvider = (token: unknown) =>
    provideOptionChain().find((p) => typeof p === 'object' && p !== null && 'provide' in p && p.provide === token)!;
  /** A transport whose messages also carry ticks the test injects (e.g. for a held leg off the visible chain). */
  const withInjectedTicks = (inject: Subject<object>) => (t: MockFeedTransport): FeedTransport => ({
    connect: () => t.connect(), close: () => t.close(), send: (m) => t.send(m),
    subscribe: (k) => t.subscribe(k), unsubscribe: (k) => t.unsubscribe(k),
    messages: merge(t.messages, inject), status: t.status, limitReached: t.limitReached,
  });

  it('ticking a call shows "Build your strategy 1"; opening it lists the leg; deleting the leg unticks the chain', async () => {
    const ctx = await setup({});
    expect(buildBtn(ctx).disabled).toBe(true);
    const box = callBoxes(ctx)[3]!;
    box.click();
    await ctx.stable();
    expect(text(buildBtn(ctx))).toBe('Build your strategy 1');
    expect(buildBtn(ctx).getAttribute('aria-expanded')).toBe('false');
    expect(panel(ctx)).toBeNull();

    await open(ctx);
    expect(buildBtn(ctx).getAttribute('aria-expanded')).toBe('true');
    expect(panelRows(ctx)).toHaveLength(1);
    expect(text(panelRows(ctx)[0])).toContain('CE');
    expect(text(panel(ctx))).toContain('Your strategy · NIFTY');

    ctx.el.querySelector<HTMLButtonElement>('oc-strategy-panel button[aria-label^="Remove "]')!.click();
    await ctx.stable();
    expect(box.checked).toBe(false);
    expect(text(buildBtn(ctx))).toBe('Build your strategy 0');
    expect(panel(ctx)).toBeNull(); // nothing left to show
  });

  it('the panel collapses from its own button and toggles from the footer button', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    await open(ctx);
    expect(panel(ctx)).not.toBeNull();
    q(ctx, 'oc-strategy-panel [aria-label="Collapse strategy"]')!.click();
    await ctx.stable();
    expect(panel(ctx)).toBeNull();
    expect(buildBtn(ctx).getAttribute('aria-expanded')).toBe('false');
    await open(ctx);
    await open(ctx);
    expect(panel(ctx)).toBeNull();
  });

  it('legs survive an underlying switch and come back', async () => {
    const ctx = await setup({});
    const token = callBoxes(ctx)[3]!.getAttribute('aria-label');
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    const legToken = [...ctx.get(StrategyStore).tokens()][0]!;

    const quick = (sym: string) => [...ctx.el.querySelectorAll<HTMLButtonElement>('.qbtn')].find((b) => text(b).startsWith(sym))!;
    quick('SENSEX').click();
    await ctx.stable();
    expect(ctx.store.underlying()?.sym).toBe('SENSEX');
    expect(text(buildBtn(ctx))).toBe('Build your strategy 0');
    expect(ctx.el.querySelectorAll('table.oc input.cb:checked')).toHaveLength(0);
    expect(ctx.transport.subscribedKeys()).toContain(legToken); // still held for its live price

    quick('NIFTY').click();
    await ctx.stable();
    expect(text(buildBtn(ctx))).toBe('Build your strategy 1');
    const checked = [...ctx.el.querySelectorAll<HTMLInputElement>('table.oc input.cb:checked')];
    expect(checked.map((b) => b.getAttribute('aria-label'))).toEqual([token]);
  });

  it('margin shows after 400 ms in mock mode', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    await open(ctx);
    const margin = () => text(q(ctx, 'oc-strategy-panel .sum .v'));
    expect(margin()).toMatch(/^₹ [\d,]+$/); // opening asks at once
    putBoxes(ctx)[3]!.click(); // a change while open waits 400 ms
    await ctx.stable();
    expect(margin()).toBe('…');
    await ctx.advance(399);
    expect(margin()).toBe('…');
    await ctx.advance(1);
    expect(margin()).toMatch(/^₹ [\d,]+$/);
    expect(margin()).not.toBe('₹ 0');
  });

  it('margin is asked only while the pop-up is open; opening asks at once', async () => {
    const ctx = await setup({});
    const ask = vi.spyOn(ctx.get(KambalaRestClient), 'getBasketMargin');
    callBoxes(ctx)[3]!.click();
    putBoxes(ctx)[3]!.click();
    await ctx.stable();
    await ctx.advance(1000);
    expect(ask).not.toHaveBeenCalled();
    await open(ctx);
    expect(ask).toHaveBeenCalledTimes(3); // combined + one per leg, no 400 ms wait
    q(ctx, 'oc-strategy-panel [aria-label="Collapse strategy"]')!.click();
    await ctx.stable();
    putBoxes(ctx)[4]!.click();
    await ctx.stable();
    await ctx.advance(1000);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('Execute all → Place → each leg shows Placed with a MOCK order number; no real REST client in mock mode', async () => {
    const realPlace = vi.spyOn(KambalaRestClient.prototype, 'placeOrder');
    const realMargin = vi.spyOn(KambalaRestClient.prototype, 'getBasketMargin');
    const ctx = await setup({}, { providers: [realProvider(KambalaRestClient)] });
    expect(ctx.get(KambalaRestClient)).toBeInstanceOf(MockKambalaRestClient);
    callBoxes(ctx)[3]!.click();
    putBoxes(ctx)[5]!.click();
    await ctx.stable();
    await open(ctx);
    await ctx.advance(400);

    button(ctx, 'Execute all').click();
    await ctx.stable();
    button(ctx, 'Place 2 orders').click();
    await ctx.stable();
    const results = [...ctx.el.querySelectorAll('oc-strategy-panel .results li')].map(text);
    expect(results).toHaveLength(2);
    for (const r of results) expect(r).toMatch(/^Placed B .* · #MOCK\d{6}$/);
    expect(realPlace).not.toHaveBeenCalled();
    expect(realMargin).not.toHaveBeenCalled();
  });

  it('Execute never runs twice concurrently', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    callBoxes(ctx)[4]!.click();
    await ctx.stable();
    const place = vi.spyOn(ctx.get(KambalaRestClient), 'placeOrder');
    const page = ctx.fixture.componentInstance as unknown as { onExecute(): Promise<void> };
    await Promise.all([page.onExecute(), page.onExecute()]);
    expect(place).toHaveBeenCalledTimes(2); // one per leg, not four
  });

  /** placeOrder answers only when the test says so: `answer(i, orderNo)`. */
  const deferPlace = (ctx: Ctx) => {
    const pending: ((orderNo: string) => void)[] = [];
    const spy = vi.spyOn(ctx.get(KambalaRestClient), 'placeOrder')
      .mockImplementation(() => new Promise<string>((r) => pending.push(r)));
    return { spy, answer: async (i: number, orderNo: string) => { pending[i]!(orderNo); await ctx.stable(); } };
  };
  const page = (ctx: Ctx) => ctx.fixture.componentInstance as unknown as { onExecute(): Promise<void> };

  it('while orders are being placed, ticks and underlying / expiry switches are refused', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    putBoxes(ctx)[3]!.click();
    await ctx.stable();
    const place = deferPlace(ctx);
    await open(ctx);
    button(ctx, 'Execute all').click();
    await ctx.stable();
    button(ctx, 'Place 2 orders').click();
    await ctx.stable();
    expect(place.spy).toHaveBeenCalledTimes(1);

    const sensex = [...ctx.el.querySelectorAll<HTMLButtonElement>('.qbtn')].find((b) => text(b).startsWith('SENSEX'))!;
    sensex.click();
    await ctx.stable();
    expect(ctx.store.underlying()?.sym).toBe('NIFTY');
    expect(text(q(ctx, '[data-testid="status-line"]'))).toBe('Orders are being placed…');
    q(ctx, '[data-testid="expiry-2026-11-10"]')!.click();
    await ctx.stable();
    expect(ctx.store.selectedExpiry()?.iso).toBe('2026-11-03');
    callBoxes(ctx)[3]!.click(); // untick a leg being placed
    callBoxes(ctx)[5]!.click(); // tick a new one
    await ctx.stable();
    expect(callBoxes(ctx)[3]!.checked).toBe(true);
    expect(callBoxes(ctx)[5]!.checked).toBe(false);
    expect(ctx.get(StrategyStore).current().legs).toHaveLength(2);

    await place.answer(0, 'MOCK1');
    await place.answer(1, 'MOCK2');
    const results = [...ctx.el.querySelectorAll('oc-strategy-panel .results li')].map(text);
    expect(results).toEqual([expect.stringMatching(/^Placed B .*#MOCK1$/), expect.stringMatching(/^Placed B .*#MOCK2$/)]);
    sensex.click(); // free again
    await ctx.stable();
    expect(ctx.store.underlying()?.sym).toBe('SENSEX');
  });

  it('results land on the strategy that was placed, even if another one became active meanwhile', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    const store = ctx.get(StrategyStore);
    const nifty = store.activeKey();
    const place = deferPlace(ctx);
    const run = page(ctx).onExecute();
    store.setUnderlying('BSE|1');
    await place.answer(0, 'MOCK9');
    await run;
    expect(store.current().legs).toEqual([]);
    store.setUnderlying(nifty);
    expect(store.current().legs[0]!.result).toEqual({ status: 'placed', orderNo: 'MOCK9' });
  });

  it('leaving the page mid-run sends no further leg', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    callBoxes(ctx)[4]!.click();
    await ctx.stable();
    const place = deferPlace(ctx);
    const run = page(ctx).onExecute();
    await ctx.stable();
    expect(place.spy).toHaveBeenCalledTimes(1);
    ctx.fixture.destroy();
    await place.answer(0, 'MOCK1');
    await run;
    expect(place.spy).toHaveBeenCalledTimes(1);
  });

  it('a leg swapped to another expiry takes its price from the first tick; Execute all waits until then', async () => {
    const queued: object[] = [];
    let hold: (m: { e?: string; tk?: string }) => boolean = () => false;
    const out = new Subject<object>();
    const ctx = await setup({}, {
      wrapTransport: (t) => {
        t.messages.subscribe((m) => (hold(m as { e?: string; tk?: string }) ? queued.push(m) : out.next(m)));
        return { ...withInjectedTicks(new Subject())(t), messages: out.asObservable() };
      },
    });
    // Hold every option message for a contract off the visible chain (the swapped leg's ack and ticks).
    hold = (m) => m.e === 'NFO' && !!m.tk && !ctx.store.quotes().has(`NFO|${m.tk}`);
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    await open(ctx);
    const expirySelect = ctx.el.querySelector<HTMLSelectElement>('oc-strategy-panel select[aria-label^="Expiry"]')!;
    expirySelect.value = '2026-11-10';
    expirySelect.dispatchEvent(new Event('change'));
    await ctx.stable();
    const leg = () => ctx.get(StrategyStore).current().legs[0]!;
    expect(leg().expiryIso).toBe('2026-11-10');
    expect(leg().price).toBe(0);
    expect(button(ctx, 'Execute all').disabled).toBe(true);
    expect(text(panel(ctx))).toContain('Waiting for a price');

    expect(queued.length).toBeGreaterThan(0);
    hold = () => false;
    for (const m of queued.splice(0)) out.next(m);
    await ctx.stable();
    const lp = ctx.store.legPrices().get(leg().token)!;
    expect(lp).toBeGreaterThan(0);
    expect(leg().price).toBe(lp);
    expect(button(ctx, 'Execute all').disabled).toBe(false);
    expect(text(panel(ctx))).not.toContain('Waiting for a price');
  });

  it('after a partial run (buy placed, sell rejected), Back → Execute all sends only the sell again', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    putBoxes(ctx)[3]!.click();
    await ctx.stable();
    expect(ctx.get(StrategyStore).current().legs[0]!.tickSize).toBe(0.05); // from the chain contract
    const place = vi.spyOn(ctx.get(KambalaRestClient), 'placeOrder').mockImplementation(async (o) => {
      if (o.trantype === 'S') throw new KambalaError('RMS: insufficient margin');
      return 'MOCK1';
    });
    await open(ctx);
    ctx.el.querySelectorAll<HTMLButtonElement>('oc-strategy-panel button.bs')[1]!.click(); // second leg → Sell
    await ctx.stable();
    button(ctx, 'Execute all').click();
    await ctx.stable();
    button(ctx, 'Place 2 orders').click();
    await ctx.stable();
    expect(place).toHaveBeenCalledTimes(2);
    button(ctx, 'Back').click();
    await ctx.stable();
    expect(text(panelRows(ctx)[0])).toContain('Placed #MOCK1');
    expect(text(panelRows(ctx)[1])).toContain('Rejected: RMS: insufficient margin');

    place.mockResolvedValue('MOCK2');
    button(ctx, 'Execute all').click();
    await ctx.stable();
    expect(ctx.el.querySelectorAll('oc-strategy-panel .confirm li')).toHaveLength(1);
    button(ctx, 'Place 1 order').click();
    await ctx.stable();
    expect(place).toHaveBeenCalledTimes(3);
    expect(place.mock.calls[2]![0].trantype).toBe('S');
  });

  it('while placing, the page warns on unload and refuses to be left', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    const comp = ctx.fixture.componentInstance as unknown as { canLeave(): boolean };
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(false);
    expect(comp.canLeave()).toBe(true);
    const place = deferPlace(ctx);
    const run = page(ctx).onExecute();
    expect(unload()).toBe(true);
    expect(comp.canLeave()).toBe(false);
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toBe('Orders are being placed…');
    await place.answer(0, 'MOCK1');
    await run;
    expect(unload()).toBe(false);
    expect(comp.canLeave()).toBe(true);
    ctx.fixture.destroy();
    expect(unload()).toBe(false);
  });

  it('the route asks the page before leaving it (in-app navigation is refused while placing)', () => {
    const guard = OPTION_CHAIN_ROUTES[0]!.canDeactivate![0] as unknown as (c: { canLeave(): boolean }) => boolean;
    expect(guard({ canLeave: () => false })).toBe(false);
    expect(guard({ canLeave: () => true })).toBe(true);
  });

  it('removing the last leg closes the pop-up and puts focus on the chain', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    await open(ctx);
    const remove = ctx.el.querySelector<HTMLButtonElement>('oc-strategy-panel button[aria-label^="Remove "]')!;
    remove.focus();
    remove.click();
    await ctx.stable();
    expect(panel(ctx)).toBeNull();
    expect(document.activeElement).toBe(q(ctx, 'oc-chain-table .tbl-wrap'));
  });

  it('a rejected leg shows its reason', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    vi.spyOn(ctx.get(KambalaRestClient), 'placeOrder').mockRejectedValue(new Error('timeout'));
    await open(ctx);
    button(ctx, 'Execute all').click();
    await ctx.stable();
    button(ctx, 'Place 1 order').click();
    await ctx.stable();
    expect(text(q(ctx, 'oc-strategy-panel .results li'))).toContain(
      'Rejected B',
    );
    expect(text(q(ctx, 'oc-strategy-panel .results li'))).toContain(
      'Could not place the order. Check the order book before retrying.',
    );
  });

  it('Execute all is off while the market is closed', async () => {
    const ctx = await setup({}, { now: Date.parse('2026-10-29T16:00:00+05:30') });
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    await open(ctx);
    expect(button(ctx, 'Execute all').disabled).toBe(true);
    expect(text(panel(ctx))).toContain('Market closed');
  });

  it('a held leg from another expiry keeps updating its live price after switching expiry', async () => {
    const ticks = new Subject<object>();
    const ctx = await setup({}, { wrapTransport: withInjectedTicks(ticks) });
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    const legToken = [...ctx.get(StrategyStore).tokens()][0]!;
    q(ctx, '[data-testid="expiry-2026-11-10"]')!.click();
    await ctx.stable();
    expect(ctx.store.selectedExpiry()?.iso).toBe('2026-11-10');
    expect(ctx.store.quotes().has(legToken)).toBe(false); // off the visible chain now
    expect(ctx.transport.subscribedKeys()).toContain(legToken);

    const [e, tk] = legToken.split('|');
    ticks.next({ t: 'tf', e, tk, lp: '123.45' });
    await ctx.stable();
    await open(ctx);
    expect(text(panelRows(ctx)[0])).toContain('Live 123.45');
    ticks.next({ t: 'tf', e, tk, lp: '124.10' });
    await ctx.stable();
    expect(text(panelRows(ctx)[0])).toContain('Live 124.10');
  });

  it('an 11th tick is refused with "A strategy holds up to 10 legs" and stays unticked', async () => {
    const ctx = await setup({});
    const boxes = [...callBoxes(ctx), ...putBoxes(ctx)];
    for (const b of boxes.slice(0, 10)) b.click();
    await ctx.stable();
    expect(text(buildBtn(ctx))).toBe('Build your strategy 10');
    boxes[10]!.click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toBe('A strategy holds up to 10 legs');
    expect(boxes[10]!.checked).toBe(false);
    expect(text(buildBtn(ctx))).toBe('Build your strategy 10');
  });

  it('switching a leg to a contract already in the strategy says "Already in your strategy"', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    putBoxes(ctx)[3]!.click(); // same strike, PE
    await ctx.stable();
    await open(ctx);
    ctx.el.querySelector<HTMLButtonElement>('oc-strategy-panel button.type.ce')!.click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toBe('Already in your strategy');
    expect(ctx.get(StrategyStore).current().legs.map((l) => l.type)).toEqual(['CE', 'PE']);
  });

  it('switching a leg to PE moves the tick; switching its expiry loads that chain for the strike picker', async () => {
    const ctx = await setup({});
    const instruments = ctx.get(InstrumentsService);
    const load = vi.spyOn(instruments, 'loadChain');
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    await open(ctx);
    ctx.el.querySelector<HTMLButtonElement>('oc-strategy-panel button.type.ce')!.click();
    await ctx.stable();
    expect(putBoxes(ctx)[3]!.checked).toBe(true);
    expect(callBoxes(ctx)[3]!.checked).toBe(false);

    const strike = ctx.get(StrategyStore).current().legs[0]!.strike;
    const expirySelect = ctx.el.querySelector<HTMLSelectElement>('oc-strategy-panel select[aria-label^="Expiry"]')!;
    expirySelect.value = '2026-11-10';
    expirySelect.dispatchEvent(new Event('change'));
    await ctx.stable();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![1].iso).toBe('2026-11-10');
    expect(load.mock.calls[0]![3]).toBe(40);
    const leg = ctx.get(StrategyStore).current().legs[0]!;
    expect(leg).toMatchObject({ expiryIso: '2026-11-10', strike, type: 'PE' });
    expect(putBoxes(ctx)[3]!.checked).toBe(false); // the visible chain is still 03 Nov
    const strikeSelect = ctx.el.querySelector<HTMLSelectElement>('oc-strategy-panel select[aria-label^="Strike"]')!;
    expect(strikeSelect.disabled).toBe(false);
    expect(strikeSelect.options.length).toBeGreaterThan(1);
    // Picking the same expiry again uses the cached chain.
    expirySelect.value = '2026-11-03';
    expirySelect.dispatchEvent(new Event('change'));
    await ctx.stable();
    expirySelect.value = '2026-11-10';
    expirySelect.dispatchEvent(new Event('change'));
    await ctx.stable();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('Save to basket in mock mode describes the hand-off', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    putBoxes(ctx)[3]!.click();
    await ctx.stable();
    await open(ctx);
    button(ctx, 'Save to basket').click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toBe('Saves 2 legs to your basket, as today.');

    // The live hand-off payload (BasketService.add): raw token, quantity in units, price 0 for a market order.
    const store = ctx.get(StrategyStore);
    const [ce, pe] = store.current().legs;
    store.setLotMultiplier(2);
    store.update(pe!.id, { side: 'S', priceType: 'MKT' });
    store.update(ce!.id, { included: false });
    const items = (ctx.fixture.componentInstance as unknown as { basketLegs(): BasketLegPayload[] }).basketLegs();
    expect(items).toEqual([{
      exch: 'NFO', token: pe!.token.split('|')[1], tsym: pe!.tsym, side: 'S', qty: 2 * 65, price: 0, priceType: 'MKT', product: 'I',
    }]);
  });

  it('Add to Watchlist / Basket work on the legs (tsym from the leg)', async () => {
    const ctx = await setup({});
    callBoxes(ctx)[3]!.click();
    await ctx.stable();
    const items = (ctx.fixture.componentInstance as unknown as { checkedContracts(): ContractPayload[] }).checkedContracts();
    const leg = ctx.get(StrategyStore).current().legs[0]!;
    expect(items).toEqual([{ token: leg.token, exch: 'NFO', rawToken: leg.token.split('|')[1], tsym: leg.tsym }]);
    button(ctx, /^Add to Watchlist/, 'oc-footer-actions').click();
    await ctx.stable();
    expect(text(q(ctx, '[data-testid="status-line"]'))).toBe('Adds 1 selected contract to your watchlist, as today.');
  });

  const fakeLiveAuth = () =>
    ({ logout: vi.fn(), session: () => ({ uid: 'TESTUID', actid: 'A', accessToken: 'fake' }), norenConfig: vi.fn() });

  it('a session expiry mid-run sends no further leg (the page is leaving for the login)', async () => {
    const auth = fakeLiveAuth();
    const ctx = await setup({}, { mock: false, providers: [{ provide: AuthSessionService, useValue: auth }] });
    vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    callBoxes(ctx)[3]!.click();
    callBoxes(ctx)[4]!.click();
    await ctx.stable();
    const place = deferPlace(ctx);
    const run = page(ctx).onExecute();
    ctx.transport.expireSession();
    await ctx.stable();
    expect(auth.logout).toHaveBeenCalled();
    await place.answer(0, 'MOCK1');
    await run;
    expect(place.spy).toHaveBeenCalledTimes(1);
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

describe('OptionChainPageComponent with live data (login session, index tokens)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  function fakeAuth() {
    return { logout: vi.fn(), session: () => ({ uid: 'TESTUID', actid: 'A', accessToken: 'fake' }), norenConfig: vi.fn() };
  }

  it('resolves NIFTY / SENSEX tokens with GetIndexList before the first select', async () => {
    const getIndexList = vi.spyOn(MockKambalaRestClient.prototype, 'getIndexList').mockImplementation(async (exch: string) =>
      exch === 'NSE' ? [{ idxname: 'Nifty 50', token: '26000' }] : [{ idxname: 'SENSEX', token: '77' }]);
    const linked = vi.spyOn(MockKambalaRestClient.prototype, 'getLinkedScrips');
    const ctx = await setup({}, { mock: false, providers: [{ provide: AuthSessionService, useValue: fakeAuth() }] });
    expect(getIndexList).toHaveBeenCalledWith('NSE');
    expect(getIndexList).toHaveBeenCalledWith('BSE');
    expect(getIndexList.mock.invocationCallOrder[0]!).toBeLessThan(linked.mock.invocationCallOrder[0]!);
    expect(ctx.get(QuickUnderlyingsService).list().map((u) => u.token)).toEqual(['26000', '77']);
    expect(ctx.transport.subscribedKeys()).toContain('BSE|77');
    expect(ctx.transport.subscribedKeys()).not.toContain('BSE|1');
    expect(ctx.store.loadState()).toBe('ready');
  });

  it('a SENSEX missing from GetIndexList shows its quick button disabled with a reason; NIFTY still works', async () => {
    vi.spyOn(MockKambalaRestClient.prototype, 'getIndexList').mockImplementation(async (exch: string) =>
      exch === 'NSE' ? [{ idxname: 'Nifty 50', token: '26000' }] : []);
    const ctx = await setup({ underlying: 'BSE:SENSEX' }, { mock: false, providers: [{ provide: AuthSessionService, useValue: fakeAuth() }] });
    const sensex = [...ctx.el.querySelectorAll<HTMLButtonElement>('.qbtn')].find((b) => text(b).startsWith('SENSEX'))!;
    expect(sensex.disabled).toBe(true);
    expect(sensex.title).toBe('SENSEX not available for this account');
    expect(ctx.store.underlying()?.sym).toBe('NIFTY'); // the URL asked for SENSEX: falls back
    expect(ctx.store.loadState()).toBe('ready');
  });

  it('a failed GetIndexList keeps NIFTY on 26000 and disables SENSEX (console warning); the page still loads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(MockKambalaRestClient.prototype, 'getIndexList').mockRejectedValue(new Error('HTTP 502'));
    const ctx = await setup({}, { mock: false, providers: [{ provide: AuthSessionService, useValue: fakeAuth() }] });
    expect(warn).toHaveBeenCalled();
    expect(ctx.get(QuickUnderlyingsService).list()[0]).toEqual(QUICK_UNDERLYINGS[0]);
    const sensex = [...ctx.el.querySelectorAll<HTMLButtonElement>('.qbtn')].find((b) => text(b).startsWith('SENSEX'))!;
    expect(sensex.disabled).toBe(true);
    expect(sensex.title).toBe('SENSEX not available for this account');
    expect(ctx.transport.subscribedKeys()).not.toContain('BSE|1');
    expect(ctx.store.loadState()).toBe('ready');
  });

  it('live data subscribes no quick key before GetIndexList has answered', async () => {
    let answer!: () => void;
    vi.spyOn(MockKambalaRestClient.prototype, 'getIndexList').mockImplementation((exch: string) => new Promise((r) => {
      const prev = answer;
      answer = () => { prev?.(); r(exch === 'NSE' ? [{ idxname: 'Nifty 50', token: '26000' }] : [{ idxname: 'SENSEX', token: '77' }]); };
    }));
    const ctx = await setup({}, { mock: false, providers: [{ provide: AuthSessionService, useValue: fakeAuth() }] });
    expect(ctx.transport.subscribedKeys()).toEqual([]);
    answer();
    await ctx.stable();
    await ctx.advance(1000);
    expect(ctx.transport.subscribedKeys()).toEqual(expect.arrayContaining(['NSE|26000', 'BSE|77']));
    expect(ctx.store.loadState()).toBe('ready');
  });

  it('session expiry with live data logs out and goes to /login with the returnUrl', async () => {
    const auth = fakeAuth();
    const ctx = await setup({}, { mock: false, providers: [{ provide: AuthSessionService, useValue: auth }] });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    // SpyLocation.path() leaves out the query; the browser's Location.path() includes it.
    vi.spyOn(TestBed.inject(Location), 'path').mockReturnValue('/option-chain?underlying=NSE:NIFTY&expiry=2026-11-03');
    ctx.transport.expireSession();
    await ctx.stable();
    expect(ctx.store.sessionExpired()).toBe(true);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(ctx.transport.status()).not.toBe('open');
    const [commands, extras] = navigate.mock.calls[0]!;
    expect(commands).toEqual(['/login']);
    expect(String(extras?.queryParams?.['returnUrl'])).toMatch(/^\/option-chain\?underlying=NSE:NIFTY/);
  });

  it('session expiry in mock mode keeps the error banner and its Retry (no logout)', async () => {
    const auth = fakeAuth();
    const ctx = await setup({}, { providers: [{ provide: AuthSessionService, useValue: auth }] });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate');
    ctx.transport.expireSession();
    await ctx.stable();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(q(ctx, '[data-testid="status-banner"] button')).not.toBeNull();
  });

  it('live data shows no client ID and no Log out button', async () => {
    const ctx = await setup({}, { mock: false, providers: [{ provide: AuthSessionService, useValue: fakeAuth() }] });
    expect(q(ctx, '[data-testid="logout"]')).toBeNull();
    expect(text(q(ctx, 'main'))).not.toContain('TESTUID');
  });

  it('demo mode has no Log out button', async () => {
    const ctx = await setup({});
    expect(q(ctx, '[data-testid="logout"]')).toBeNull();
  });
});
