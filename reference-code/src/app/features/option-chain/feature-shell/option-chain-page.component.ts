import { Location } from '@angular/common';
import {
  afterNextRender, afterRenderEffect, ChangeDetectionStrategy, Component, computed, DestroyRef, effect, ElementRef, inject,
  Injector, signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
import { AuthSessionService } from '../data-access/auth-session.service';
import { InstrumentsService } from '../data-access/instruments.service';
import {
  ChainMeta, ChainStrike, chainIdentity, Expiry, QUICK_UNDERLYINGS, splitFeedKey, Underlying, underlyingKey,
} from '../data-access/models';
import { QuickUnderlyingsService } from '../data-access/quick-underlyings.service';
import { OptionChainStore } from '../data-access/option-chain.store';
import { CustomPreset, CustomView, Prefs, PrefsStore } from '../data-access/prefs.store';
import { MockMarket } from '../data-access/testing/mock-market';
import { toCsv } from '../export/csv-export';
import { executeStrategy } from '../strategy/execute-strategy';
import { StrategyMarginService } from '../strategy/strategy-margin.service';
import { isSendable, LegContract, legQty, Product, StrategyLeg } from '../strategy/strategy.models';
import { StrategyStore } from '../strategy/strategy.store';
import {
  ChainTableComponent, ContractAction, ContractActionEvent, TradeEvent,
} from '../ui/chain-table/chain-table.component';
import {
  ColumnChooserComponent, RenamePresetEvent, SavePresetEvent,
} from '../ui/column-chooser/column-chooser.component';
import { ExpiryStats, ExpiryStripComponent, formatExpiryDate } from '../ui/expiry-strip/expiry-strip.component';
import { FooterActionsComponent } from '../ui/footer-actions/footer-actions.component';
import { BannerKind, StatusBannerComponent } from '../ui/status-banner/status-banner.component';
import { Ohlc, QuickPrice, UnderlyingBarComponent } from '../ui/underlying-bar/underlying-bar.component';
import { ThemeToggleComponent } from '../ui/theme-toggle/theme-toggle.component';
import { LegSwap, StrategyPanelComponent } from '../ui/strategy-panel/strategy-panel.component';
import { StrikeCount, ViewToolbarComponent } from '../ui/view-toolbar/view-toolbar.component';
import { buildViewModel, ChainViewModel } from '../view/chain-view-model';
import { OPTION_CHAIN_MOCK_MODE, OPTION_CHAIN_USER_ID, provideOptionChain } from './option-chain.providers';

/** The Custom view before the user edits it (mockup default). */
const DEFAULT_CUSTOM: CustomView = { mode: 'mirrored', columns: ['oi', 'oiChg', 'iv', 'delta', 'ltp'] };
const STALE_CHECK_MS = 5000;
const STATUS_LINE_MS = 3400;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPTY_STATS: ExpiryStats = {
  atmIv: null, cumOi: null, maxPain: null, pcrOi: null, pcrVol: null, forward: null, forwardSource: null,
};
const NO_OHLC: Ohlc = { open: null, high: null, low: null, prevClose: null };
/** Strikes loaded for a leg's strike picker when its expiry is not the one showing. */
const PICKER_CHAIN_CNT = 40;

/** Mock-mode status line for each contract action (the hand-off the live app makes instead). */
const ACTION_TEXT: Record<ContractAction, string> = {
  chart: 'Opens the chart',
  advancedChart: 'Opens Advanced Chart',
  watchlist: 'Adds to your watchlist',
  basket: 'Adds to your basket',
  ato: 'Opens Create ATO',
  marketDepth: 'Opens Market Depth',
  gtt: 'Opens Create GTT',
  priceAlert: 'Opens Price Alert',
};

/** A contract as handed to the watchlist / basket: feed key plus Kambala's exchange and raw token. */
export interface ContractPayload { token: string; exch: string; rawToken: string; tsym: string }

/** A strategy leg as handed to the basket: Kambala's exchange and raw token, plus the order fields. */
export interface BasketLegPayload {
  exch: string;
  /** Kambala's raw token (e.g. 43651), not the feed key. */
  token: string;
  tsym: string;
  side: 'B' | 'S';
  /** lots × lot multiplier × lot size */
  qty: number;
  /** The limit price; 0 for a market order. */
  price: number;
  priceType: 'LMT' | 'MKT';
  product: Product;
}

/** Test hooks for the e2e suite (mock mode only). */
interface MockHooksWindow {
  __mockFeed?: { drop(): void; setSpot(value: number, sym?: string): void };
  __ocMetrics?: { readonly lastRoundTripMs: number | null; readonly resultCount: number };
}

/** Same shape as `chainIdentity(meta)`: the key of an underlying's chain for one expiry. */
function chainKey(u: Underlying, expiryIso: string): string {
  return `${underlyingKey(u)}|${expiryIso}`;
}

/** A search row as an option underlying. INTEGRATION: filter to F&O underlyings once Kambala says how (Q8). */
export function searchRowToUnderlying(
  r: ScripSearchResult, quickList: readonly Underlying[] = QUICK_UNDERLYINGS,
): Underlying | null {
  const quick = quickList.find((q) => q.exch === r.exch && q.token === r.token && !q.unavailable);
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
    ChainTableComponent, FooterActionsComponent, ThemeToggleComponent, StrategyPanelComponent,
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
  protected readonly session = inject(MarketSessionService);
  private readonly auth = inject(AuthSessionService);
  private readonly router = inject(Router);
  private readonly quickSvc = inject(QuickUnderlyingsService);
  private readonly instruments = inject(InstrumentsService);
  private readonly injector = inject(Injector);
  protected readonly strategy = inject(StrategyStore);
  protected readonly margin = inject(StrategyMarginService);

  /** NIFTY, SENSEX: tokens from GetIndexList with live data (an unavailable SENSEX shows disabled). */
  protected readonly quick = this.quickSvc.list;
  /** The default underlying (NIFTY, always first). */
  private readonly nifty = computed(() => this.quick()[0]!);
  /** Live data only: the Log out button and the signed-in user. */
  protected readonly live = !this.mockMode;
  protected readonly prefs = signal<Prefs>(this.prefsStore.load(this.userId));
  /** Custom editor open (it only shows while the Custom preset is selected, D20). Closed on load. */
  protected readonly editorOpen = signal(false);
  protected readonly searchResults = signal<Underlying[]>([]);
  protected readonly resultsFor = signal<string | null>(null);
  /** The chain's tick boxes are the legs of the selected underlying's strategy. */
  protected readonly checked = computed(() => this.strategy.tokens());
  /** The "Build your strategy" pop-up is showing. */
  protected readonly strategyOpen = signal(false);
  /** Execute all is placing orders (never two runs at once). */
  protected readonly placing = signal(false);
  /** Chains for the legs' strike pickers, by `chainIdentity`: the ones shown, plus other expiries loaded once. */
  private readonly pickerChains = signal<ReadonlyMap<string, ChainMeta>>(new Map());
  private readonly pickerLoads = new Map<string, Promise<ChainMeta | null>>();
  protected readonly stale = signal<ReadonlySet<string>>(new Set<string>());
  protected readonly nowMs = signal(this.clock());
  protected readonly statusLine = signal<string | null>(null);
  /** The expiry the user just picked, highlighted while its chain loads. */
  private readonly pendingExpiry = signal<string | null>(null);

  private destroyed = false;
  /** Set synchronously when the page starts leaving (log out, session expiry): a run sends no further leg. */
  private leaving = false;
  private searchSeq = 0;
  private prevSlot: number | null = null;
  private slotMeta: ChainMeta | null = null;
  /** Pending spot-line scroll: wait for a chain other than `notMeta` (undefined: any chain). */
  private scrollReq: { notMeta: ChainMeta | null | undefined } | null = null;
  private cancelStale: (() => void) | null = null;
  private cancelStatus: (() => void) | null = null;

  protected readonly selected = computed(() => this.store.underlying() ?? this.nifty());
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

  /** Errors and reconnecting need attention, so they keep the full-width banner above the chain. */
  protected readonly alertKind = computed<BannerKind | null>(() => {
    const k = this.bannerKind();
    return k === 'error' || k === 'reconnecting' ? k : null;
  });

  /** Quiet states (market closed, analytics off) sit in the toolbar beside the Strikes picker, taking no rows. */
  protected readonly notice = computed<string | null>(() => {
    switch (this.bannerKind()) {
      case 'closed':
        return 'Market closed · Prices as of 15:30';
      case 'analytics-unavailable':
        return 'Analytics unavailable · Prices are live';
      default:
        return null;
    }
  });

  /** Strike options for a leg's expiry and type, from the selected underlying's cached chain of that expiry. */
  protected readonly pickerFor = computed(() => {
    const u = this.store.underlying();
    const chains = this.pickerChains();
    return (leg: StrategyLeg): { strikes: number[]; ready: boolean } => {
      const meta = u ? chains.get(chainKey(u, leg.expiryIso)) : undefined;
      if (!meta) return { strikes: [], ready: false };
      const side = leg.type === 'CE' ? 'ce' : 'pe';
      return { strikes: meta.strikes.filter((s) => s[side]).map((s) => s.strike), ready: true };
    };
  });

  constructor() {
    const destroyRef = inject(DestroyRef);

    // ---- Build your strategy ----
    this.margin.setLivePrices(this.store.legPrices);
    this.margin.setActive(this.strategyOpen); // margin is asked only while the pop-up shows

    // A limit leg with no price yet (picked before any tick, e.g. moved to another expiry) takes the first live price.
    effect(() => {
      const live = this.store.legPrices();
      const legs = this.strategy.current().legs;
      untracked(() => {
        for (const l of legs) {
          const px = live.get(l.token);
          if (l.priceType === 'LMT' && l.price <= 0 && px !== undefined && px > 0) this.strategy.update(l.id, { price: px });
        }
      });
    });

    // Every leg (of every underlying) stays subscribed, so its live price flows whatever chain is showing.
    effect(() => {
      const keys = this.strategy.allTokens();
      untracked(() => this.facade.holdLegKeys(keys));
    });

    // The chain showing feeds the strike pickers; a leg on another expiry has that expiry's chain loaded once.
    effect(() => {
      const meta = this.store.meta();
      const isos = new Set(this.strategy.current().legs.map((l) => l.expiryIso));
      if (!meta) return;
      untracked(() => {
        this.cacheChain(meta);
        for (const iso of isos) void this.pickerChain(iso);
      });
    });

    // The pop-up closes with its last leg (also on a switch to an underlying without legs). Focus inside it (or lost
    // with it) goes back to the footer button, or to the chain while that button is off (no legs).
    effect(() => {
      if (this.strategy.current().legs.length > 0) return;
      untracked(() => {
        if (!this.strategyOpen()) return;
        const panel = this.host.nativeElement.querySelector('oc-strategy-panel');
        const active = typeof document === 'undefined' ? null : document.activeElement;
        const hadFocus = !active || active === document.body || !!panel?.contains(active);
        this.strategyOpen.set(false);
        if (hadFocus) afterNextRender(() => this.focusStrategyButton(), { injector: this.injector });
      });
    });

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
      if (!this.store.sessionExpired() || this.mockMode) return;
      // INTEGRATION: AuthService.relogin(). The standalone app logs out and goes to /login, which returns here (a new
      // page, so a fresh session config and connection). TradeSmart's shell can swap this for its own login; after
      // re-login, refresh the NOREN_SESSION_CONFIG getter's session and call facade.reconnect() (or let the user
      // press the error banner's Retry, which does the same). No retry loop here.
      untracked(() => this.toLogin(this.location.path() || '/option-chain'));
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

    // Closing or reloading the tab while orders are being placed asks the browser to warn first.
    if (typeof window !== 'undefined') {
      const onBeforeUnload = (e: BeforeUnloadEvent): void => {
        if (!this.placing()) return;
        e.preventDefault();
        e.returnValue = ''; // older browsers need it set to show the prompt
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      destroyRef.onDestroy(() => window.removeEventListener('beforeunload', onBeforeUnload));
    }

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
    // Live data: this account's index tokens (GetIndexList) before the first select. Never throws: a failed call
    // keeps the built-in tokens.
    if (!this.mockMode) {
      await this.quickSvc.resolve(this.rest);
      if (this.destroyed) return;
    }
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
    const nifty = this.nifty();
    if (!m) return nifty;
    const exch = m[1]!.toUpperCase();
    const sym = m[2]!.toUpperCase();
    const quick = this.quick().find((q) => q.exch === exch && q.sym === sym);
    if (quick) return quick.unavailable ? nifty : quick;
    try {
      const rows = await this.rest.searchScrip(sym);
      return rows.map((r) => searchRowToUnderlying(r, this.quick())).find((x) => x?.exch === exch && x.sym === sym) ?? nifty;
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        this.facade.markSessionExpired();
        return null;
      }
      return nifty;
    }
  }

  private select(u: Underlying, expiryIso?: string): Promise<void> {
    this.resetSelectionView();
    this.strategy.setUnderlying(underlyingKey(u)); // each underlying keeps its own legs
    return this.facade.select(u, expiryIso);
  }

  private resetSelectionView(): void {
    this.stale.set(new Set());
    this.pendingExpiry.set(null);
    this.scrollReq = { notMeta: null };
  }

  // ---- template handlers ---------------------------------------------------------------------------------------

  protected onSelectUnderlying(u: Underlying): void {
    if (u.unavailable || this.refusedWhilePlacing()) return;
    void this.select(u);
  }

  /** Session expired (live data): drop the dead session and log in again, coming back to `returnUrl`. */
  private toLogin(returnUrl: string): void {
    this.leaving = true; // a run in flight sends no further leg (and canLeave lets the page go)
    this.auth.logout();
    this.transport.close();
    this.router.navigate(['/login'], { queryParams: { returnUrl } }).catch(() => undefined);
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
      const u = searchRowToUnderlying(r, this.quick());
      if (!u || seen.has(`${u.exch}|${u.token}`)) continue;
      seen.add(`${u.exch}|${u.token}`);
      results.push(u);
    }
    this.searchResults.set(results);
    this.resultsFor.set(q);
  }

  protected onExpiry(e: Expiry): void {
    if (e.iso === this.store.selectedExpiry()?.iso && this.pendingExpiry() === null) return;
    if (this.refusedWhilePlacing()) return;
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

  /** A tick box adds the contract to the strategy as a leg (Buy 1 lot at its LTP); unticking removes it. */
  protected onToggleCheck(token: string): void {
    if (this.refusedWhilePlacing()) return;
    const meta = this.store.meta();
    const row = meta?.strikes.find((s) => s.ce?.token === token || s.pe?.token === token);
    const c = meta && row ? this.legContract(meta, row, row.ce?.token === token ? 'CE' : 'PE') : null;
    if (c && this.strategy.toggle(c) === 'full') this.showStatus('A strategy holds up to 10 legs');
  }

  protected onBuildStrategy(): void {
    this.strategyOpen.update((open) => !open);
  }

  /** Collapse (chevron or Esc): focus goes back to the footer button that opened the pop-up. */
  protected onCollapseStrategy(): void {
    this.strategyOpen.set(false);
    this.focusStrategyButton();
  }

  /** The footer's Build-your-strategy button; the chain's table box while that button is off (no legs). */
  private focusStrategyButton(): void {
    const el = this.host.nativeElement;
    const btn = el.querySelector<HTMLButtonElement>('oc-footer-actions button.strategy');
    (btn && !btn.disabled ? btn : el.querySelector<HTMLElement>('oc-chain-table .tbl-wrap'))?.focus();
  }

  /**
   * A leg's expiry, strike or type changed in the pop-up: the leg becomes that contract (the nearest listed strike
   * when the exact one is not in that expiry's chain).
   */
  protected async onSwap(e: LegSwap): Promise<void> {
    const meta = await this.pickerChain(e.expiryIso);
    if (this.destroyed || !this.strategy.current().legs.some((l) => l.id === e.id)) return; // gone meanwhile
    const side = e.type === 'CE' ? 'ce' : 'pe';
    const rows = meta?.strikes.filter((s) => s[side]) ?? [];
    const row = rows.reduce<ChainStrike | null>(
      (best, s) => (!best || Math.abs(s.strike - e.strike) < Math.abs(best.strike - e.strike) ? s : best), null);
    const c = meta && row ? this.legContract(meta, row, e.type) : null;
    if (!c) {
      this.showStatus('Could not load that expiry. Try again.');
      return;
    }
    if (this.strategy.swap(e.id, c) === 'duplicate') this.showStatus('Already in your strategy');
  }

  /**
   * Places the included legs one at a time (buys first); never two runs at once, never while the market is closed
   * or a limit leg has no price. Results go to the strategy that was placed; once the page is gone no further leg is
   * sent. While it runs, the strategy can't be changed or left (`refusedWhilePlacing`).
   */
  protected async onExecute(): Promise<void> {
    const s = this.strategy.current();
    if (this.placing() || this.leaving || !this.session.isOpen() ||
      s.legs.some((l) => isSendable(l) && l.priceType === 'LMT' && l.price <= 0)) {
      return;
    }
    const key = this.strategy.activeKey();
    this.placing.set(true);
    try {
      await executeStrategy(
        s, this.store.legPrices(), (o) => this.rest.placeOrder(o), (r) => this.strategy.setResults(r, key),
        () => this.destroyed || this.leaving,
      );
    } finally {
      this.placing.set(false);
    }
  }

  /**
   * The route's canDeactivate: in-app navigation away is refused (with the status line) while orders are being
   * placed. Leaving for the login (log out, session expiry) is always allowed.
   */
  canLeave(): boolean {
    return this.leaving || !this.refusedWhilePlacing();
  }

  /** True (with a status line) while orders are being placed: the strategy being placed must stay as it is. */
  private refusedWhilePlacing(): boolean {
    if (this.placing()) this.showStatus('Orders are being placed…');
    return this.placing();
  }

  protected onSaveToBasket(): void {
    const items = this.basketLegs();
    if (!this.mockMode) {
      // INTEGRATION: BasketService.add(items) — one BasketLegPayload per included leg:
      // { exch, token: raw token, tsym, side, qty, price, priceType, product }. TradeSmart lets the user pick the basket.
      return;
    }
    this.showStatus(`Saves ${items.length === 1 ? '1 leg' : `${items.length} legs`} to your basket, as today.`);
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

  /**
   * The chart buttons and the "…" menu on one contract. Each hands the contract to an existing TradeSmart screen,
   * as its option chain does today.
   */
  protected onContractAction(a: ContractActionEvent): void {
    if (!this.mockMode) {
      // INTEGRATION, per action — all take the contract { exch: a.exch, token: a.rawToken, tsym: a.tsym }:
      //   chart         → TradeSmart's Chart view for this contract
      //   advancedChart → Advanced Chart (the TradingView chart behind "Go to Advanced Trader")
      //   watchlist     → WatchlistService.add([contract]) — TradeSmart lets the user pick the watchlist
      //   basket        → BasketService.add([contract]) — TradeSmart lets the user pick the basket
      //   ato           → Create ATO window       gtt        → Create GTT window
      //   marketDepth   → Market Depth panel      priceAlert → Price Alert window (pre-filled with a.ltp)
      return;
    }
    // Mock mode: simulated contracts must never reach real TradeSmart screens. Describe the hand-off instead.
    const leg = this.findLeg(a.token);
    const e = this.store.selectedExpiry();
    const when = e ? formatExpiryDate(e.iso).slice(0, 6) : '';
    const what = `${this.selected().sym} ${when} ${leg ? `${leg.strike} ${leg.type}` : a.tsym}`;
    this.showStatus(`${ACTION_TEXT[a.action]}: ${what}`);
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
    return this.strategy.current().legs.map((l) => ({ token: l.token, ...splitFeedKey(l.token), tsym: l.tsym }));
  }

  /** The included legs as basket items (Save to basket). */
  protected basketLegs(): BasketLegPayload[] {
    const s = this.strategy.current();
    return s.legs.filter((l) => l.included).map((l) => ({
      exch: l.exch, token: splitFeedKey(l.token).rawToken, tsym: l.tsym, side: l.side, qty: legQty(l, s.lotMultiplier),
      price: l.priceType === 'MKT' ? 0 : l.price, priceType: l.priceType, product: s.product,
    }));
  }

  /** One side of a chain row as a strategy contract, priced from the leg feed or the chain quote. */
  private legContract(meta: ChainMeta, row: ChainStrike, type: 'CE' | 'PE'): LegContract | null {
    const ref = type === 'CE' ? row.ce : row.pe;
    if (!ref) return null;
    const ltp = this.store.legPrices().get(ref.token) ?? this.store.quotes().get(ref.token)?.().ltp ?? null;
    return {
      token: ref.token, tsym: ref.tsym, exch: splitFeedKey(ref.token).exch, expiryIso: meta.expiry.iso,
      strike: row.strike, type, lotSize: ref.lotSize, tickSize: ref.tickSize, ltp,
    };
  }

  private cacheChain(meta: ChainMeta): void {
    const key = chainIdentity(meta);
    if (this.pickerChains().get(key) !== meta) this.pickerChains.update((m) => new Map(m).set(key, meta));
  }

  /** The selected underlying's chain for `iso` (strike pickers, swaps): cached, else loaded once. Null if it can't be. */
  private pickerChain(iso: string): Promise<ChainMeta | null> {
    const u = this.store.underlying();
    const spot = this.store.spot();
    const expiry = this.store.expiries().find((x) => x.iso === iso);
    if (!u || !expiry || spot === null) return Promise.resolve(null);
    const key = chainKey(u, iso);
    const cached = this.pickerChains().get(key);
    if (cached) return Promise.resolve(cached);
    let load = this.pickerLoads.get(key);
    if (!load) {
      load = this.instruments.loadChain(u, expiry, spot, PICKER_CHAIN_CNT)
        .then((meta) => {
          if (!this.destroyed) this.cacheChain(meta);
          return meta;
        }, () => null)
        .finally(() => this.pickerLoads.delete(key));
      this.pickerLoads.set(key, load);
    }
    return load;
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
