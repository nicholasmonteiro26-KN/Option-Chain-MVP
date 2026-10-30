import { inject, Injectable, InjectionToken, OnDestroy, signal } from '@angular/core';
import type { ChainAnalytics, ChainInput } from '@option-analytics/analyze';
import type { StrikeQuotes } from '@option-analytics/types';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { MarketSessionService } from '../data-access/market-session.service';
import { chainIdentity } from '../data-access/models';
import { OPTION_CHAIN_CONFIG, OptionChainStore } from '../data-access/option-chain.store';
import type { FromWorker, ToWorker } from './protocol';

/** The slice of `Worker` the bridge uses; tests supply an in-process fake. */
export interface WorkerLike {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export const WORKER_FACTORY = new InjectionToken<() => WorkerLike>('WORKER_FACTORY', {
  providedIn: 'root',
  factory: () => () => new Worker(new URL('./analytics.worker', import.meta.url), { type: 'module' }),
});

/** A reply slower than this many recalculation intervals counts as a crash (the worker is hung). */
export const WATCHDOG_INTERVALS = 5;
/** In a hidden tab requestAnimationFrame does not run: post after this delay instead. */
const HIDDEN_POST_DELAY_MS = 250;

const isHidden = (): boolean => typeof document !== 'undefined' && document.hidden === true;

/**
 * Runs `fn` just after the next rendered frame (requestAnimationFrame, then a task). The bridge posts there so the
 * worker's reply (a few ms later) lands between frames instead of queuing behind a tick-flush frame, whose layout
 * and paint of a 200-contract table can take 20-30 ms on the main thread. In a hidden tab (no frames) it falls back
 * to a timer, so analytics keep running in background tabs. Tests supply a synchronous one.
 */
export const ANALYTICS_POST_SCHEDULER = new InjectionToken<(fn: () => void) => void>('ANALYTICS_POST_SCHEDULER', {
  providedIn: 'root',
  factory: () => (fn) => {
    if (typeof requestAnimationFrame === 'function' && !isHidden()) requestAnimationFrame(() => setTimeout(fn, 0));
    else setTimeout(fn, isHidden() ? HIDDEN_POST_DELAY_MS : 0);
  },
});

/**
 * Throttled bridge between the store and the analytics worker. Every `recalcIntervalMs` it snapshots the store
 * into a `ChainInput` and posts it, unless a request is already in flight (skip, never queue). Each post carries the
 * chain identity (`underlyingKey|expiry.iso`); a reply for any other chain than the one now in the store is
 * dropped. Provided by the feature alongside `OptionChainStore`.
 */
@Injectable()
export class AnalyticsBridge implements OnDestroy {
  private readonly store = inject(OptionChainStore);
  private readonly session = inject(MarketSessionService);
  private readonly config = inject(OPTION_CHAIN_CONFIG);
  private readonly makeWorker = inject(WORKER_FACTORY);
  private readonly schedule = inject(CHAIN_FEED_SCHEDULER);
  private readonly clock = inject(CHAIN_FEED_CLOCK);
  private readonly afterFrame = inject(ANALYTICS_POST_SCHEDULER);

  private readonly _unavailable = signal(false);
  private readonly _roundTrip = signal<number | null>(null);
  /** True once the worker has crashed a second time; no more analysis is attempted. */
  readonly analyticsUnavailable = this._unavailable.asReadonly();
  /** Clock at result minus clock at post, for the latest accepted result. */
  readonly lastRoundTripMs = this._roundTrip.asReadonly();
  /** Accepted results so far; lets the e2e perf test tell a new pass from a repeated round-trip value. */
  resultCount = 0;

  private worker: WorkerLike | null = null;
  private cancelTimer: (() => void) | null = null;
  private cancelWatchdog: (() => void) | null = null;
  private running = false;
  private nextId = 0;
  private inFlightId: number | null = null;
  /** A post is waiting for `afterFrame`. */
  private postPending = false;
  private postedAtMs = 0;
  private failures = 0;
  /** The latest accepted result and the chain it belongs to: it warm-starts only that chain's next pass. */
  private last: ChainAnalytics | null = null;
  private lastChain: string | null = null;
  /**
   * While the market is closed: the store's `dataVersion` at the last posted snapshot, so a closed market is
   * re-analysed only when the chain's data changed since (null: nothing posted yet this closed period).
   */
  private closedPostedVersion: number | null = null;

  start(): void {
    if (this.running || this._unavailable()) return;
    this.running = true;
    this.worker = this.attach(this.makeWorker());
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.clearWatchdog();
    this.detach();
    this.inFlightId = null;
  }

  /**
   * Asks for a fresh analysis now. The page calls it on every chain change (underlying or expiry), so the new chain
   * gets analytics without waiting a whole interval, and while the market is closed (where an analysis runs only
   * when the chain's data changed) the new chain gets one at once. Clears the closed-market version gate and posts
   * just after the next frame when no request is in flight; otherwise the reply (dropped if it is for the old chain) is followed by a post. No-op while
   * stopped.
   */
  requestAnalysis(): void {
    if (!this.running) return;
    this.closedPostedVersion = null;
    this.tick();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private arm(): void {
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      if (!this.running) return;
      this.tick();
      if (this.running) this.arm();
    }, this.config.recalcIntervalMs);
  }

  private tick(): void {
    if (this.inFlightId !== null || this.postPending || !this.worker) return;
    this.postPending = true;
    this.afterFrame(() => {
      this.postPending = false;
      if (this.running) this.post();
    });
  }

  private post(): void {
    const w = this.worker;
    if (this.inFlightId !== null || !w) return;
    const closed = !this.session.isOpen();
    // Open: analyse every interval. Closed: only when the chain's data changed since the last posted snapshot.
    const version = this.store.dataVersion();
    if (!closed) this.closedPostedVersion = null;
    else if (version === this.closedPostedVersion) return;
    const snap = this.snapshot();
    if (!snap) return;
    if (closed) this.closedPostedVersion = version;
    const id = ++this.nextId;
    this.inFlightId = id;
    this.postedAtMs = this.clock();
    w.postMessage({ v: 1, kind: 'analyze', id, chain: snap.chain, input: snap.input });
    this.clearWatchdog();
    this.cancelWatchdog = this.schedule(() => {
      this.cancelWatchdog = null;
      if (this.inFlightId === id && this.worker === w) this.onCrash(w); // hung: no reply in 5 intervals
    }, WATCHDOG_INTERVALS * this.config.recalcIntervalMs);
  }

  private currentChain(): string | null {
    const meta = this.store.meta();
    return meta ? chainIdentity(meta) : null;
  }

  private snapshot(): { chain: string; input: ChainInput } | null {
    const meta = this.store.meta();
    const expiry = this.store.selectedExpiry();
    const spot = this.store.spot();
    if (!meta || !expiry || spot === null) return null;
    const chain = chainIdentity(meta);
    const quotes = this.store.quotes();
    const strikes: StrikeQuotes[] = meta.strikes.map((s) => ({
      strike: s.strike,
      ce: s.ce ? (quotes.get(s.ce.token)?.() ?? null) : null,
      pe: s.pe ? (quotes.get(s.pe.token)?.() ?? null) : null,
    }));
    // Warm state (previous forward and IVs) only from a result for this same chain.
    const warm = this.lastChain === chain ? this.last : null;
    const prevIv: Record<string, number> = {};
    if (warm) for (const [token, leg] of Object.entries(warm.legs)) if (leg.iv !== null) prevIv[token] = leg.iv;
    return {
      chain,
      input: {
        spot, futuresPrice: null, strikes, expiryIso: expiry.iso, nowMs: this.clock(),
        prevForward: warm?.forward ?? null, prevIv, config: this.config,
      },
    };
  }

  private attach(w: WorkerLike): WorkerLike {
    w.onmessage = ({ data }) => this.onMessage(w, data);
    w.onerror = () => this.onCrash(w);
    return w;
  }

  private detach(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private clearWatchdog(): void {
    this.cancelWatchdog?.();
    this.cancelWatchdog = null;
  }

  private onMessage(from: WorkerLike, msg: FromWorker): void {
    if (from !== this.worker || msg.id !== this.inFlightId) return; // stale or from a dead worker
    if (msg.kind === 'error') {
      this.onCrash(from);
      return;
    }
    this.clearWatchdog();
    this.inFlightId = null;
    if (msg.chain !== this.currentChain()) {
      // The chain changed while this pass ran: never attach it to the new chain. Analyse the new one instead.
      this.closedPostedVersion = null;
      if (this.running) this.tick();
      return;
    }
    this._roundTrip.set(this.clock() - this.postedAtMs);
    this.resultCount++;
    this.last = msg.result;
    this.lastChain = msg.chain;
    this.store.setAnalytics(msg.result);
  }

  private onCrash(from: WorkerLike): void {
    if (from !== this.worker) return;
    this.clearWatchdog();
    this.detach();
    this.inFlightId = null;
    this.closedPostedVersion = null; // the lost analysis must be retried
    if (++this.failures >= 2) {
      this._unavailable.set(true);
      this.stop();
      return;
    }
    if (this.running) this.worker = this.attach(this.makeWorker());
  }
}
