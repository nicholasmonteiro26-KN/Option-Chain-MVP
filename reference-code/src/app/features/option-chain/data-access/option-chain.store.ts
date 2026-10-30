import { inject, Injectable, InjectionToken, Signal, signal, WritableSignal } from '@angular/core';
import type { ChainAnalytics } from '@option-analytics/analyze';
import { DEFAULT_CONFIG, OptionChainConfig } from '@option-analytics/config';
import type { LegQuote, OptType } from '@option-analytics/types';
import { FEED_TRANSPORT, FeedStatus } from './feed/transport';
import type { TickPartial } from './feed/tick-buffer';
import { ChainMeta, ContractRef, Expiry, QUICK_UNDERLYINGS, Underlying, underlyingKey } from './models';

/** The analytics/runtime config the feature runs with (a token so tests can flip e.g. `oiUnit`). */
export const OPTION_CHAIN_CONFIG = new InjectionToken<Readonly<OptionChainConfig>>('OPTION_CHAIN_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_CONFIG,
});

export interface SpotOhlc {
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
}

/** Last price and previous close of a quick-switch underlying (NIFTY, SENSEX). */
export interface QuickQuote {
  ltp: number;
  prevClose: number | null;
}

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function defaultQuote(ref: ContractRef, type: OptType, strike: number): LegQuote {
  return {
    token: ref.token, type, strike, lotSize: ref.lotSize, tickSize: ref.tickSize,
    ltp: null, bid: null, ask: null, bidQty: 0, askQty: 0, volume: 0, oi: 0, prevOi: 0,
    prevClose: null, open: null, high: null, low: null, lastTickMs: 0,
  };
}

/** Signals state for one option chain page. Provided by the feature (one per chain view). */
@Injectable()
export class OptionChainStore {
  readonly underlying = signal<Underlying | null>(null);
  readonly expiries = signal<Expiry[]>([]);
  readonly selectedExpiry = signal<Expiry | null>(null);
  readonly meta = signal<ChainMeta | null>(null);
  readonly spot: WritableSignal<number | null> = signal<number | null>(null);
  readonly spotOhlc = signal<SpotOhlc | null>(null);
  private readonly _quotes = signal<ReadonlyMap<string, WritableSignal<LegQuote>>>(new Map());
  /** One signal per contract feed key; the map itself is replaced on every chain load. */
  readonly quotes: Signal<ReadonlyMap<string, WritableSignal<LegQuote>>> = this._quotes.asReadonly();
  private readonly _analytics = signal<ChainAnalytics | null>(null);
  readonly analytics: Signal<ChainAnalytics | null> = this._analytics.asReadonly();
  private readonly _dataVersion = signal(0);
  /**
   * Bumps whenever the chain's inputs change: a chain is installed or cleared, or a tick batch updates at least one
   * current contract or the current underlying (once per batch; unknown and quick-only keys do not count). Lets the
   * analytics bridge re-analyse a closed market only when there is new data.
   */
  readonly dataVersion: Signal<number> = this._dataVersion.asReadonly();
  readonly feedStatus: Signal<FeedStatus> = inject(FEED_TRANSPORT).status;
  readonly loadState = signal<LoadState>('idle');
  readonly partialChain = signal(false);
  readonly sessionExpired: WritableSignal<boolean> = signal(false);

  /** Feed key -> symbol of the quick-switch underlyings, which stay subscribed for the page's lifetime (D18). */
  private readonly quickKeys = new Map(QUICK_UNDERLYINGS.map((u) => [underlyingKey(u), u.sym] as const));
  /** Merged ticks per quick key, kept across selections (switching back to one gets no fresh ack). */
  private readonly quickCache = new Map<string, TickPartial>();
  private readonly _quickPrices = signal<Readonly<Record<string, QuickQuote>>>({});
  /** Live price per quick-switch symbol, for the quick buttons. */
  readonly quickPrices: Signal<Readonly<Record<string, QuickQuote>>> = this._quickPrices.asReadonly();

  /** OI and volume from the feed are in lots: scale them to quantity at ingestion (spec §4 config). */
  private readonly oiInLots = inject(OPTION_CHAIN_CONFIG).oiUnit === 'lots';

  /**
   * Installs a chain: a fresh quotes map with a default LegQuote per contract. The previous chain's analytics are
   * dropped at once, so they can never be shown against (or warm-start) the new chain.
   */
  setChain(meta: ChainMeta): void {
    const map = new Map<string, WritableSignal<LegQuote>>();
    for (const s of meta.strikes) {
      if (s.ce) map.set(s.ce.token, signal(defaultQuote(s.ce, 'CE', s.strike)));
      if (s.pe) map.set(s.pe.token, signal(defaultQuote(s.pe, 'PE', s.strike)));
    }
    this._analytics.set(null);
    this.meta.set(meta);
    this._quotes.set(map);
    this._dataVersion.update((v) => v + 1);
  }

  /** Drops the current chain (meta, quotes, analytics, selected expiry), e.g. when the underlying changes. */
  clearChain(): void {
    this.meta.set(null);
    this.selectedExpiry.set(null);
    this._quotes.set(new Map());
    this._analytics.set(null);
    this._dataVersion.update((v) => v + 1);
  }

  /** Merges a drained TickBuffer batch. Contract keys update their leg; the underlying key updates spot. */
  applyTicks(batch: ReadonlyMap<string, TickPartial>): void {
    const quotes = this._quotes();
    const u = this.underlying();
    const spotKey = u ? underlyingKey(u) : null;
    let quickChanged = false;
    let dataChanged = false;
    for (const [key, partial] of batch) {
      if (this.quickKeys.has(key)) {
        this.quickCache.set(key, { ...this.quickCache.get(key), ...stripUndefined(partial), token: key });
        quickChanged = true;
      }
      const leg = quotes.get(key);
      if (leg) {
        dataChanged = true;
        // token/type/strike are identity fields: never overwritten by a tick.
        const { token: _t, type: _ty, strike: _s, ...fields } = partial;
        leg.update((q) => {
          const patch = stripUndefined(fields);
          if (this.oiInLots) {
            const lot = patch.lotSize ?? q.lotSize;
            if (patch.oi !== undefined) patch.oi *= lot;
            if (patch.prevOi !== undefined) patch.prevOi *= lot;
            if (patch.volume !== undefined) patch.volume *= lot;
          }
          return { ...q, ...patch };
        });
      } else if (key === spotKey) {
        dataChanged = true;
        this.applySpot(partial);
      }
    }
    if (quickChanged) this.publishQuickPrices();
    if (dataChanged) this._dataVersion.update((v) => v + 1);
  }

  /**
   * Re-applies the cached ticks of the current underlying when it is a quick-switch one. Its key stays
   * subscribed, so selecting it again brings no new ack; this restores spot and OHLC at once.
   */
  primeSpotFromCache(): void {
    const u = this.underlying();
    const cached = u ? this.quickCache.get(underlyingKey(u)) : undefined;
    if (cached) this.applySpot(cached);
  }

  private publishQuickPrices(): void {
    const out: Record<string, QuickQuote> = {};
    for (const [key, sym] of this.quickKeys) {
      const c = this.quickCache.get(key);
      if (c?.ltp !== undefined && c.ltp !== null) out[sym] = { ltp: c.ltp, prevClose: c.prevClose ?? null };
    }
    this._quickPrices.set(out);
  }

  setAnalytics(a: ChainAnalytics | null): void {
    this._analytics.set(a);
  }

  reset(): void {
    this.underlying.set(null);
    this.expiries.set([]);
    this.selectedExpiry.set(null);
    this.meta.set(null);
    this.spot.set(null);
    this.spotOhlc.set(null);
    this._quotes.set(new Map());
    this._analytics.set(null);
    this.loadState.set('idle');
    this.partialChain.set(false);
    this.sessionExpired.set(false);
  }

  private applySpot(p: TickPartial): void {
    if (p.ltp !== undefined && p.ltp !== null) this.spot.set(p.ltp);
    const patch: Partial<SpotOhlc> = {};
    if (p.open !== undefined) patch.open = p.open;
    if (p.high !== undefined) patch.high = p.high;
    if (p.low !== undefined) patch.low = p.low;
    if (p.prevClose !== undefined) patch.prevClose = p.prevClose;
    if (Object.keys(patch).length === 0) return;
    this.spotOhlc.update((cur) => ({ ...(cur ?? { open: null, high: null, low: null, prevClose: null }), ...patch }));
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
