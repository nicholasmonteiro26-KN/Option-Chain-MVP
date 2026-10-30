import { Location } from '@angular/common';
import {
  afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject, signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { DEFAULT_CONFIG } from '@option-analytics/config';
import type { LegQuote } from '@option-analytics/types';
import { AnalyticsBridge } from '../analytics/analytics.bridge';
import type { PresetId } from '../columns/presets';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER, ChainFeedFacade } from '../data-access/chain-feed.facade';
import { MockFeedTransport } from '../data-access/feed/mock-feed.transport';
import { FEED_TRANSPORT } from '../data-access/feed/transport';
import { KambalaRestApi, KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { ScripSearchResult, SessionExpiredError } from '../data-access/kambala/kambala.types';
import { MarketSessionService } from '../data-access/market-session.service';
import { ChainMeta, Expiry, QUICK_UNDERLYINGS, splitFeedKey, Underlying } from '../data-access/models';
import { OptionChainStore } from '../data-access/option-chain.store';
import { CustomPreset, CustomView, Prefs, PrefsStore } from '../data-access/prefs.store';
import { MockMarket } from '../data-access/testing/mock-market';
import { toCsv } from '../export/csv-export';
import { ChainTableComponent, TradeEvent } from '../ui/chain-table/chain-table.component';
import {
  ColumnChooserComponent, RenamePresetEvent, SavePresetEvent,
} from '../ui/column-chooser/column-chooser.component';
import { ExpiryStats, ExpiryStripComponent, formatExpiryDate } from '../ui/expiry-strip/expiry-strip.component';
import { FooterActionsComponent } from '../ui/footer-actions/footer-actions.component';
import { BannerKind, StatusBannerComponent } from '../ui/status-banner/status-banner.component';
import { Ohlc, QuickPrice, UnderlyingBarComponent } from '../ui/underlying-bar/underlying-bar.component';
import { StrikeCount, ViewToolbarComponent } from '../ui/view-toolbar/view-toolbar.component';
import { buildViewModel, ChainViewModel } from '../view/chain-view-model';
import { OPTION_CHAIN_MOCK_MODE, OPTION_CHAIN_USER_ID, provideOptionChain } from './option-chain.providers';

const NIFTY = QUICK_UNDERLYINGS[0]!;
/** The Custom view before the user edits it (mockup default). */
const DEFAULT_CUSTOM: CustomView = { mode: 'mirrored', columns: ['oi', 'oiChg', 'iv', 'delta', 'ltp'] };
const STALE_CHECK_MS = 5000;
const STATUS_LINE_MS = 3400;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_STATS: ExpiryStats = {
  atmIv: null, cumOi: null, maxPain: null, pcrOi: null, pcrVol: null, forward: null, forwardSource: null,
};
const NO_OHLC: Ohlc = { open: null, high: null, low: null, prevClose: null };

/** A contract as handed to the watchlist / basket: feed key plus Kambala's exchange and raw token. */
export interface ContractPayload { token: string; exch: string; rawToken: string; tsym: string }

/** Test hooks for the e2e suite (mock mode only). */
interface MockHooksWindow {
  __mockFeed?: { drop(): void; setSpot(value: number, sym?: string): void };
  __ocMetrics?: { readonly lastRoundTripMs: number | null; readonly resultCount: number };
}

/** A search row as an option underlying. INTEGRATION: filter to F&O underlyings once Kambala says how (Q8). */
export function searchRowToUnderlying(r: ScripSearchResult): Underlying | null {
  const quick = QUICK_UNDERLYINGS.find((q) => q.exch === r.exch && q.token === r.token);
  if (quick) return quick;
  if (r.exch !== 'NSE' && r.exch !== 'BSE') return null;
  return {
    sym: r.tsym.replace(/-(EQ|BE|BZ)$/, ''), exch: r.exch, foExch: r.exch === 'NSE' ? 'NFO' : 'BFO',
    token: r.token, name: r.name, isIndex: false,
  };
}

/**
 * The option chain page (spec §5): the only place that wires the store, the feed facade, the analytics bridge
 * and preferences to the presentational components.
 */
@Component({
  selector: 'oc-option-chain-page',
  imports: [
    UnderlyingBarComponent, ViewToolbarComponent, ExpiryStripComponent, StatusBannerComponent, ColumnChooserComponent,
    ChainTableComponent, FooterActionsComponent,
  ],
  // The feature's services live and die with the page (not the route): store, facade, socket / mock feed, worker.
  providers: provideOptionChain(),
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './option-chain-page.component.html',
  styleUrl: './option-chain-page.component.scss',
})
export class OptionChainPageComponent {
  protected readonly store = inject(OptionChainStore);
  private readonly facade = inject(ChainFeedFacade);
  private readonly bridge = inject(AnalyticsBridge);
  private readonly prefsStore = inject(PrefsStore);
  private readonly rest = inject<KambalaRestApi>(KambalaRestClient);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly clock = inject(CHAIN_FEED_CLOCK);
  private readonly schedule = inject(CHAIN_FEED_SCHEDULER);
  private readonly userId = inject(OPTION_CHAIN_USER_ID);
  private readonly mockMode = inject(OPTION_CHAIN_MOCK_MODE);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly transport = inject(FEED_TRANSPORT);
  private readonly session = inject(MarketSessionService);

  protected readonly quick = QUICK_UNDERLYINGS;
  protected readonly prefs = signal<Prefs>(this.prefsStore.load(this.userId));
  /** Custom editor open (it only shows while the Custom preset is selected, D20). Closed on load. */
  protected readonly editorOpen = signal(false);
  protected readonly searchResults = signal<Underlying[]>([]);
  protected readonly resultsFor = signal<string | null>(null);
  protected readonly checked = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly stale = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly nowMs = signal(this.clock());
  protected readonly statusLine = signal<string | null>(null);
  /** The expiry the user just picked, highlighted while its chain loads. */
  private readonly pendingExpiry = signal<string | null>(null);

  private destroyed = false;
  private searchSeq = 0;
  private prevSlot: number | null = null;
  private slotMeta: ChainMeta | null = null;
  /** Pending spot-line scroll: wait for a chain other than `notMeta` (undefined: any chain). */
  private scrollReq: { notMeta: ChainMeta | null | undefined } | null = null;
  private cancelStale: (() => void) | null = null;
  private cancelStatus: (() => void) | null = null;

  protected readonly selected = computed(() => this.store.underlying() ?? NIFTY);
  protected readonly presetId = computed(() => this.prefs().preset);
  protected readonly customView = computed(() => this.prefs().custom ?? DEFAULT_CUSTOM);
  protected readonly showEditor = computed(() => this.presetId() === 'custom' && this.editorOpen());

  /** The visible chain. Snapshots every leg signal, so it recomputes once per flushed tick batch. */
  readonly vm = computed<ChainViewModel | null>(() => {
    const meta = this.store.meta();
    const spot = this.store.spot();
    if (!meta || spot === null) return null;
    const quotes = new Map<string, LegQuote>();
    for (const [key, leg] of this.store.quotes()) quotes.set(key, leg());
    // Deliberate write from a computed: the spot-line hysteresis needs the previous result's slot (spec §5.4).
    // It only feeds the next evaluation of this same computed, so no other part of the signal graph observes it.
    if (meta !== this.slotMeta) {
      this.slotMeta = meta;
      this.prevSlot = null;
    }
    const p = this.prefs();
    const custom = this.customView();
    const vm = buildViewModel({
      meta, quotes, analytics: this.store.analytics(), spot, presetId: p.preset, customColumns: custom.columns,
      strikeCount: p.strikeCount, prevSlot: this.prevSlot, hysteresis: DEFAULT_CONFIG.spotSlotHysteresis,
    });
    this.prevSlot = vm.spotSlot;
    return p.preset === 'custom' ? { ...vm, mode: custom.mode } : vm;
  });

  protected readonly tableLoading = computed(
    () => this.store.loadState() === 'loading' || (this.vm() === null && this.store.loadState() !== 'error'),
  );

  /** The table needs a view model even before the first chain arrives: same columns, no rows. */
  protected readonly tableVm = computed<ChainViewModel>(() => {
    const vm = this.vm();
    if (vm) return vm;
    const p = this.prefs();
    const empty = buildViewModel({
      meta: { underlying: this.selected(), expiry: { iso: '', exd: '', sampleTsym: '', foExch: '' }, strikes: [], strikeStep: 0 },
      quotes: new Map(), analytics: null, spot: 0, presetId: p.preset, customColumns: this.customView().columns,
      strikeCount: p.strikeCount, prevSlot: null, hysteresis: DEFAULT_CONFIG.spotSlotHysteresis,
    });
    return p.preset === 'custom' ? { ...empty, mode: this.customView().mode } : empty;
  });

  protected readonly ohlc = computed<Ohlc>(() => this.store.spotOhlc() ?? NO_OHLC);

  /** Lot size of the selected expiry, from its first visible contract (D21: never hard-coded). */
  protected readonly lotSize = computed<number | null>(() => {
    const row = this.vm()?.rows[0];
    return row?.ce?.ref.lotSize ?? row?.pe?.ref.lotSize ?? null;
  });

  /** Both quick-switch underlyings stay subscribed, so each button shows its live price (D18). */
  protected readonly quickPrices = computed<Record<string, QuickPrice>>(() => {
    const out: Record<string, QuickPrice> = {};
    for (const [sym, q] of Object.entries(this.store.quickPrices())) {
      out[sym] = { ltp: q.ltp, chgPct: q.prevClose ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : 0 };
    }
    return out;
  });

  protected readonly stripSelected = computed<Expiry | null>(() => {
    const list = this.store.expiries();
    const pending = this.pendingExpiry();
    return list.find((e) => e.iso === pending) ?? this.store.selectedExpiry() ?? list[0] ?? null;
  });

  protected readonly stats = computed<ExpiryStats>(() => {
    const a = this.store.analytics();
    if (!a) return EMPTY_STATS;
    return {
      atmIv: a.atmIv, cumOi: a.cumOi, maxPain: a.maxPain, pcrOi: a.pcrOi, pcrVol: a.pcrVol,
      forward: a.forward, forwardSource: a.forwardSource,
    };
  });

  protected readonly footer = computed(() => {
    const a = this.store.analytics();
    const e = this.store.selectedExpiry();
    return {
      fwd: a ? a.forward : null,
      atm: a && a.atmStrike !== 0 ? a.atmStrike : null,
      expiry: e ? formatExpiryDate(e.iso) : null,
    };
  });

  /**
   * Controller rule: error > reconnecting > closed > analytics unavailable. Reconnecting follows the feed; closed
   * follows the market session (exchange hours), not the socket.
   */
  protected readonly bannerKind = computed<BannerKind | null>(() => {
    const s = this.store;
    if (s.loadState() === 'error' || s.sessionExpired()) return 'error';
    if (s.feedStatus() === 'reconnecting') return 'reconnecting';
    if (!this.session.isOpen()) return 'closed';
    if (this.bridge.analyticsUnavailable()) return 'analytics-unavailable';
    return null;
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Keep the URL bookmarkable: underlying and (once known) expiry, via history.replaceState.
    effect(() => {
      const u = this.store.underlying();
      const e = this.store.selectedExpiry();
      if (u) untracked(() => this.writeUrl(u, e?.iso ?? null));
    });

    // Every chain change (underlying or expiry) asks for its own analysis at once: the old chain's analytics were
    // cleared by setChain, and while the market is closed an analysis runs only when the chain data changed (acks arriving later re-trigger it).
    effect(() => {
      if (!this.store.meta()) return;
      untracked(() => this.bridge.requestAnalysis());
    });

    // On the session tick (30 s): an expiry past its 15:30 leaves the strip; a selected one hands over to the next.
    effect(() => {
      const now = this.session.nowMs();
      untracked(() => this.facade.pruneExpired(now));
    });

    effect(() => {
      if (!this.store.sessionExpired()) return;
      // INTEGRATION: AuthService.relogin() — hand off to TradeSmart's existing login (spec §6). No retry loop here.
      // After re-login, refresh the NOREN_SESSION_CONFIG getter's session and call facade.reconnect() (or let the
      // user press the error banner's Retry, which does the same).
    });

    // After a load or a switch, scroll the table so the spot line sits mid-box (once the rows have rendered).
    afterRenderEffect(() => {
      const vm = this.vm();
      const loading = this.tableLoading();
      const meta = this.store.meta();
      const req = this.scrollReq;
      if (!req || !vm || loading || vm.rows.length === 0) return;
      if (req.notMeta !== undefined && meta === req.notMeta) return;
      if (this.scrollSpotToMiddle()) this.scrollReq = null;
    });

    this.armStaleCheck();
    if (this.mockMode) this.installMockHooks(destroyRef);

    destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.bridge.stop();
      this.transport.close(); // real socket or mock: no reconnects or ticks after the page is gone
      this.cancelStale?.();
      this.cancelStatus?.();
    });

    void this.init();
  }

  // ---- startup -----------------------------------------------------------------------------------------------

  private async init(): Promise<void> {
    const qp = this.route.snapshot.queryParamMap;
    const u = await this.resolveUnderlying(qp.get('underlying'));
    if (this.destroyed) return;
    if (!u) {
      this.bridge.start(); // session expired while resolving the URL: the error banner's Retry resumes
      return;
    }
    const expiry = qp.get('expiry');
    const selecting = this.select(u, expiry && ISO_DATE.test(expiry) ? expiry : undefined);
    this.bridge.start();
    await selecting;
  }

  /**
   * `EXCH:SYM` -> underlying: quick list first, then search; anything else (or no match) is NIFTY. Null when the
   * search reports an expired session (flagged on the store, so the error banner and re-login take over).
   */
  private async resolveUnderlying(param: string | null): Promise<Underlying | null> {
    const m = /^(NSE|BSE):([A-Za-z0-9&_-]+)$/i.exec(param?.trim() ?? '');
    if (!m) return NIFTY;
    const exch = m[1]!.toUpperCase();
    const sym = m[2]!.toUpperCase();
    const quick = QUICK_UNDERLYINGS.find((q) => q.exch === exch && q.sym === sym);
    if (quick) return quick;
    try {
      const rows = await this.rest.searchScrip(sym);
      return rows.map(searchRowToUnderlying).find((x) => x?.exch === exch && x.sym === sym) ?? NIFTY;
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        this.facade.markSessionExpired();
        return null;
      }
      return NIFTY;
    }
  }

  private select(u: Underlying, expiryIso?: string): Promise<void> {
    this.resetSelectionView();
    return this.facade.select(u, expiryIso);
  }

  private resetSelectionView(): void {
    this.checked.set(new Set());
    this.stale.set(new Set());
    this.pendingExpiry.set(null);
    this.scrollReq = { notMeta: null };
  }

  // ---- template handlers ---------------------------------------------------------------------------------------

  protected onSelectUnderlying(u: Underlying): void {
    void this.select(u);
  }

  protected async onSearch(text: string): Promise<void> {
    const q = text.trim();
    const seq = ++this.searchSeq;
    let rows: ScripSearchResult[] = [];
    try {
      rows = q ? await this.rest.searchScrip(q) : [];
    } catch (err) {
      if (err instanceof SessionExpiredError && !this.destroyed) this.facade.markSessionExpired();
      rows = [];
    }
    if (seq !== this.searchSeq || this.destroyed) return;
    const seen = new Set<string>();
    const results: Underlying[] = [];
    for (const r of rows) {
      const u = searchRowToUnderlying(r);
      if (!u || seen.has(`${u.exch}|${u.token}`)) continue;
      seen.add(`${u.exch}|${u.token}`);
      results.push(u);
    }
    this.searchResults.set(results);
    this.resultsFor.set(q);
  }

  protected onExpiry(e: Expiry): void {
    if (e.iso === this.store.selectedExpiry()?.iso && this.pendingExpiry() === null) return;
    this.pendingExpiry.set(e.iso);
    this.scrollReq = { notMeta: this.store.meta() };
    void this.facade.selectExpiry(e.iso).finally(() => {
      if (this.pendingExpiry() === e.iso) this.pendingExpiry.set(null);
    });
  }

  protected onPreset(id: PresetId): void {
    this.updatePrefs({ preset: id });
    this.editorOpen.set(id === 'custom');
  }

  protected onStrikeCount(count: StrikeCount): void {
    this.updatePrefs({ strikeCount: count });
    this.scrollReq = { notMeta: undefined };
  }

  protected onCustomColumns(columns: string[]): void {
    this.updatePrefs({ custom: { ...this.customView(), columns } });
  }

  protected onCustomMode(mode: CustomView['mode']): void {
    this.updatePrefs({ custom: { ...this.customView(), mode } });
  }

  protected onSavePreset(e: SavePresetEvent): void {
    const preset: CustomPreset = { id: `cv${this.clock()}`, name: e.name, mode: e.mode, columns: e.columns };
    const res = this.prefsStore.addCustomPreset(this.userId, preset);
    if (res.ok) this.updatePrefs({ customPresets: [...this.prefs().customPresets, preset] });
    else this.showStatus(res.reason); // the chooser normally blocks this first; storage may hold more than shown
  }

  /** A saved Custom view becomes the working Custom view (and is saved as such). */
  protected onApplyPreset(id: string): void {
    const p = this.prefs().customPresets.find((x) => x.id === id);
    if (p) this.updatePrefs({ preset: 'custom', custom: { mode: p.mode, columns: [...p.columns] } });
  }

  protected onRenamePreset(e: RenamePresetEvent): void {
    this.updatePrefs({ customPresets: this.prefs().customPresets.map((p) => (p.id === e.id ? { ...p, name: e.name } : p)) });
  }

  protected onDeletePreset(id: string): void {
    this.updatePrefs({ customPresets: this.prefs().customPresets.filter((p) => p.id !== id) });
  }

  protected onToggleCheck(token: string): void {
    const next = new Set(this.checked());
    if (!next.delete(token)) next.add(token);
    this.checked.set(next);
  }

  protected onTrade(t: TradeEvent): void {
    if (!this.mockMode) {
      // INTEGRATION: OrderWindowService.open({ exch: t.exch, token: t.rawToken, tsym: t.tsym, side: t.side, ... })
      // — TradeSmart's existing order window, pre-filled with price: t.ltp and lotSize: t.lotSize (this contract's
      // `ls`, D21). `exch` + `rawToken` (e.g. NFO, 43651) are Kambala's order keys; `t.token` is the feed key.
      return;
    }
    // Mock mode: simulated prices must never reach a real order window. Describe the hand-off instead.
    const leg = this.findLeg(t.token);
    const e = this.store.selectedExpiry();
    const when = e ? formatExpiryDate(e.iso).slice(0, 6) : '';
    const what = leg ? `${leg.strike} ${leg.type}` : t.tsym;
    this.showStatus(`Opens the order window: ${t.side} ${this.selected().sym} ${when} ${what} @ ${t.ltp.toFixed(2)} · lot ${t.lotSize}`);
  }

  protected onAddToWatchlist(): void {
    const items = this.checkedContracts();
    if (!this.mockMode) {
      // INTEGRATION: WatchlistService.add(items) — per ticked contract { token: feed key, exch, rawToken, tsym }.
      return;
    }
    this.showStatus(`Adds ${this.checkedLabel(items.length)} to your watchlist, as today.`);
  }

  protected onAddToBasket(): void {
    const items = this.checkedContracts();
    if (!this.mockMode) {
      // INTEGRATION: BasketService.add(items) — per ticked contract { token: feed key, exch, rawToken, tsym }.
      return;
    }
    this.showStatus(`Adds ${this.checkedLabel(items.length)} to your basket, as today.`);
  }

  protected onCsv(): void {
    const vm = this.vm();
    const u = this.store.underlying();
    const e = this.store.selectedExpiry();
    if (!vm || !u || !e) return;
    const { filename, content } = toCsv(vm, { underlying: u.sym, expiry: e.iso, at: new Date(this.clock()) });
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click has been handled: some browsers start the download asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * Error banner Retry: after a load error, or after re-login following a session expiry. Reconnects the transport
   * when needed and reloads the current underlying and expiry (`facade.reconnect`).
   */
  protected async retry(): Promise<void> {
    const expiry = this.store.selectedExpiry()?.iso ?? this.pendingExpiry() ?? undefined;
    const u = this.store.underlying();
    this.resetSelectionView();
    if (u) {
      await this.facade.reconnect(u, expiry);
      return;
    }
    await this.facade.reconnect(null); // the URL's underlying was never resolved: resolve it again
    if (!this.destroyed) await this.init();
  }

  // ---- helpers -----------------------------------------------------------------------------------------------

  private updatePrefs(patch: Partial<Prefs>): void {
    const next = { ...this.prefs(), ...patch };
    this.prefs.set(next);
    this.prefsStore.save(this.userId, next);
  }

  private findLeg(token: string): { strike: number; type: 'CE' | 'PE' } | null {
    for (const s of this.store.meta()?.strikes ?? []) {
      if (s.ce?.token === token) return { strike: s.strike, type: 'CE' };
      if (s.pe?.token === token) return { strike: s.strike, type: 'PE' };
    }
    return null;
  }

  /** The ticked contracts as watchlist / basket items (exchange and raw token split out of the feed key). */
  protected checkedContracts(): ContractPayload[] {
    const tsyms = new Map<string, string>();
    for (const s of this.store.meta()?.strikes ?? []) {
      if (s.ce) tsyms.set(s.ce.token, s.ce.tsym);
      if (s.pe) tsyms.set(s.pe.token, s.pe.tsym);
    }
    return [...this.checked()].map((token) => ({ token, ...splitFeedKey(token), tsym: tsyms.get(token) ?? '' }));
  }

  private checkedLabel(n: number): string {
    return n === 1 ? '1 selected contract' : `${n} selected contracts`;
  }

  private showStatus(text: string): void {
    this.cancelStatus?.();
    this.statusLine.set(text);
    this.cancelStatus = this.schedule(() => this.statusLine.set(null), STATUS_LINE_MS);
  }

  private writeUrl(u: Underlying, expiryIso: string | null): void {
    const [path, query = ''] = this.location.path().split('?');
    const params = new URLSearchParams(query);
    const underlying = `${u.exch}:${u.sym}`;
    const changed = params.get('underlying') !== underlying;
    params.set('underlying', underlying);
    if (expiryIso) params.set('expiry', expiryIso);
    else if (changed) params.delete('expiry');
    this.location.replaceState(path || '/option-chain', params.toString().replace(/%3A/gi, ':'));
  }

  /** Every 5 s: contracts with no tick for `staleAfterMs` are dimmed (not while the market is closed). */
  private armStaleCheck(): void {
    this.cancelStale = this.schedule(() => {
      if (this.destroyed) return;
      const now = this.clock();
      this.nowMs.set(now);
      // No stale marking outside market hours: nothing ticks then, by design.
      this.stale.set(this.session.isOpen() ? new Set(this.facade.markStale(now)) : new Set());
      this.armStaleCheck();
    }, STALE_CHECK_MS);
  }

  /** Puts the spot line in the middle of the table box. Returns false when the rows are not rendered yet. */
  private scrollSpotToMiddle(): boolean {
    const wrap = this.host.nativeElement.querySelector<HTMLElement>('.tbl-wrap');
    const spot = wrap?.querySelector<HTMLElement>('tr.spot');
    if (!wrap || !spot) return false;
    // Measure the row above the line: the line itself may be stuck to the header or footer (sticky).
    const above = spot.previousElementSibling;
    const top = wrap.getBoundingClientRect().top;
    const y = above ? above.getBoundingClientRect().bottom - top + wrap.scrollTop : 0;
    wrap.scrollTop = Math.max(0, y - wrap.clientHeight / 2);
    return true;
  }

  private installMockHooks(destroyRef: DestroyRef): void {
    if (typeof window === 'undefined') return;
    const w = window as unknown as MockHooksWindow;
    const transport = this.transport;
    const market = inject(MockMarket);
    const bridge = this.bridge;
    w.__mockFeed = {
      drop: () => {
        if (transport instanceof MockFeedTransport) transport.drop();
      },
      setSpot: (value: number, sym = 'NIFTY') => market.pinSpot(sym, value),
    };
    w.__ocMetrics = {
      get lastRoundTripMs() {
        return bridge.lastRoundTripMs();
      },
      get resultCount() {
        return bridge.resultCount;
      },
    };
    destroyRef.onDestroy(() => {
      delete w.__mockFeed;
      delete w.__ocMetrics;
    });
  }
}
