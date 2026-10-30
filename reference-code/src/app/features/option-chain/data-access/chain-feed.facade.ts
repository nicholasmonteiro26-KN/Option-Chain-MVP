import { DestroyRef, effect, inject, Injectable, InjectionToken, untracked } from '@angular/core';
import { nearestStrikeIndex } from '@option-analytics/strikes';
import { expiryInstantMs, isExpired } from '@option-analytics/time';
import { SessionExpiredError } from './kambala/kambala.types';
import { FEED_TRANSPORT } from './feed/transport';
import { TickBuffer, TickMessage } from './feed/tick-buffer';
import { InstrumentsService } from './instruments.service';
import { ChainMeta, contractKeys, QUICK_UNDERLYINGS, Underlying, underlyingKey } from './models';
import { OPTION_CHAIN_CONFIG, OptionChainStore } from './option-chain.store';

/** One-shot timer returning a cancel function. */
export type OneShotScheduler = (cb: () => void, ms: number) => () => void;

export const CHAIN_FEED_SCHEDULER = new InjectionToken<OneShotScheduler>('CHAIN_FEED_SCHEDULER', {
  providedIn: 'root',
  factory: () => (cb, ms) => {
    const h = setTimeout(cb, ms);
    return () => clearTimeout(h);
  },
});

export const CHAIN_FEED_CLOCK = new InjectionToken<() => number>('CHAIN_FEED_CLOCK', {
  providedIn: 'root',
  factory: () => Date.now,
});

const SPOT_TIMEOUT_MS = 5000;
const QUICK_KEYS = QUICK_UNDERLYINGS.map(underlyingKey);
/** 1 attempt + 2 retries (spec §6). */
const MAX_ATTEMPTS = 3;

/** Strikes each side of ATM that fit a subscription limit: 2·(2N+1) legs + the underlying ≤ limit. */
export function strikesEachSideForLimit(limit: number): number {
  return Math.max(0, Math.floor(((limit - 1) / 2 - 1) / 2));
}

/**
 * Orchestrates one chain view: REST loads (instruments), feed subscriptions and tick flushing into the store.
 * Provided by the feature alongside `OptionChainStore`.
 */
@Injectable()
export class ChainFeedFacade {
  private readonly instruments = inject(InstrumentsService);
  private readonly store = inject(OptionChainStore);
  private readonly transport = inject(FEED_TRANSPORT);
  private readonly schedule = inject(CHAIN_FEED_SCHEDULER);
  private readonly clock = inject(CHAIN_FEED_CLOCK);
  private readonly config = inject(OPTION_CHAIN_CONFIG);
  private readonly buffer = inject(TickBuffer, { optional: true }) ?? new TickBuffer(this.clock);

  /** Incremented by every chain load (and every select); results carrying an older id are dropped. */
  private requestId = 0;
  private selectId = 0;
  /** True from `select()` until it hands over to `selectExpiry()` (or gives up). */
  private selectInProgress = false;
  private subscribedUnderlying: string | null = null;
  private subscribedContracts: string[] = [];
  /** The subscription limit the current contract subscriptions were trimmed for. */
  private appliedLimit: number | null = null;
  private chainLoadedMs = 0;
  private spotWaiter: ((ok: boolean) => void) | null = null;
  private quickSubscribed = false;

  constructor() {
    const sub = this.transport.messages.subscribe((m) => {
      this.buffer.push(m as TickMessage);
      // A select() waiting for spot must not depend on a frame (none run in a hidden tab): resolve it from the
      // underlying's ack or tick right away.
      if (this.spotWaiter && this.subscribedUnderlying !== null && feedKeyOf(m) === this.subscribedUnderlying) {
        this.flushNow();
      }
    });
    const stopFlush = this.buffer.flushOnAnimationFrame((batch) => {
      this.store.applyTicks(batch);
      if (this.spotWaiter && this.store.spot() !== null) this.spotWaiter(true);
    });
    this.transport.connect().catch(() => undefined);
    this.subscribeQuick();

    // The limit may be reported at any time after subscribing (async ack or error): trim the installed chain then.
    effect(() => {
      const limit = this.transport.limitReached();
      if (limit !== null) untracked(() => this.onLimitReached(limit));
    });
    // WS-side session expiry (ck Not_Ok) surfaces through the same store signal as REST expiry.
    effect(() => {
      if (this.transport.status() === 'session-expired') untracked(() => this.onSessionExpired());
    });

    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      stopFlush();
      this.spotWaiter?.(false);
      this.unsubscribeAll();
      this.unsubscribeQuick();
    });
  }

  /** Switches underlying: resubscribes its spot, loads expiries, waits for spot, then loads the chosen expiry. */
  async select(u: Underlying, expiryIso?: string): Promise<void> {
    const sid = ++this.selectId;
    ++this.requestId; // any in-flight chain load belongs to the previous selection
    this.spotWaiter?.(false);
    this.selectInProgress = true;
    let iso: string | null = null;
    try {
      iso = await this.prepareSelect(u, expiryIso, sid);
    } finally {
      if (sid === this.selectId) this.selectInProgress = false;
    }
    if (iso !== null && sid === this.selectId) await this.selectExpiry(iso);
  }

  /**
   * Recovery after a session expiry (once the shell has re-logged in and refreshed the session config) or a load
   * error: clears `sessionExpired`, reconnects the transport when it is 'session-expired' or 'closed' (a failed
   * connect is reported through its status), then re-runs `select` for the current underlying and expiry.
   */
  async reconnect(
    u: Underlying | null = this.store.underlying(), expiryIso: string | undefined = this.store.selectedExpiry()?.iso,
  ): Promise<void> {
    this.store.sessionExpired.set(false);
    const status = this.transport.status();
    if (status === 'session-expired' || status === 'closed') {
      try {
        await this.transport.connect();
      } catch {
        // The transport's status (and the effect below) reports a rejected session.
      }
    }
    if (u) await this.select(u, expiryIso);
  }

  /** A REST call outside the facade (search, URL resolve) reported an expired session: same handling as ours. */
  markSessionExpired(): void {
    this.onSessionExpired();
  }

  /**
   * Spec §6: an expiry whose 15:30 IST has passed (within `minTimeToExpirySec`, as at load) leaves the strip. If it
   * was the selected one, the next expiry loads. Called on the market-session tick (every 30 s).
   */
  pruneExpired(nowMs: number): void {
    const s = this.store;
    const list = s.expiries();
    const live = list.filter((e) => !isExpired(nowMs, expiryInstantMs(e.iso), this.config.minTimeToExpirySec));
    if (live.length === list.length) return;
    s.expiries.set(live);
    const sel = s.selectedExpiry();
    if (!sel || live.some((e) => e.iso === sel.iso)) return;
    const next = live.find((e) => e.iso > sel.iso) ?? live[0];
    if (next) void this.selectExpiry(next.iso);
  }

  /** Loads and subscribes one expiry's chain. Old contract keys are unsubscribed before any new subscribe. */
  async selectExpiry(iso: string): Promise<void> {
    if (this.selectInProgress) return; // select() picks the expiry itself once spot is known
    const s = this.store;
    if (s.sessionExpired()) return;
    const id = ++this.requestId;
    const u = s.underlying();
    const e = s.expiries().find((x) => x.iso === iso);
    const spot = s.spot();
    if (!u || !e || spot === null) {
      s.loadState.set('error');
      return;
    }
    s.loadState.set('loading');

    let meta: ChainMeta;
    try {
      meta = await this.withRetry(() => this.instruments.loadChain(u, e, spot, this.config.chainCnt));
    } catch (err) {
      if (id === this.requestId) this.fail(err);
      return;
    }
    if (id !== this.requestId) return; // a newer load superseded this one

    this.transport.unsubscribe(this.subscribedContracts);
    this.subscribedContracts = [];
    s.setChain(meta);
    s.selectedExpiry.set(e);
    this.chainLoadedMs = this.clock();
    this.subscribeChain(meta);
    s.loadState.set('ready');
  }

  /**
   * Subscribed contract keys with no tick for `staleAfterMs`. A never-ticked leg counts from the chain load time.
   * Market hours are not checked here; the caller decides when staleness matters.
   */
  markStale(nowMs: number): string[] {
    const cutoff = nowMs - this.config.staleAfterMs;
    const quotes = this.store.quotes();
    return this.subscribedContracts.filter((k) => {
      const q = quotes.get(k);
      return q !== undefined && Math.max(q().lastTickMs, this.chainLoadedMs) < cutoff;
    });
  }

  /** Resets state and subscribes the underlying; returns the expiry to load, or null when the selection ended. */
  private async prepareSelect(u: Underlying, expiryIso: string | undefined, sid: number): Promise<string | null> {
    const s = this.store;
    if (this.transport.status() !== 'session-expired') s.sessionExpired.set(false);
    s.loadState.set('loading');
    s.underlying.set(u);
    s.partialChain.set(false);
    s.expiries.set([]);
    s.spot.set(null);
    s.spotOhlc.set(null);
    s.clearChain();

    this.unsubscribeAll();
    this.subscribeQuick(); // again after a session expiry dropped them
    const key = underlyingKey(u);
    this.subscribedUnderlying = key;
    this.transport.subscribe([key]);
    s.primeSpotFromCache();

    let expiries;
    try {
      expiries = await this.withRetry(() => this.instruments.loadExpiries(u, this.clock()));
    } catch (err) {
      if (sid === this.selectId) this.fail(err);
      return null;
    }
    if (sid !== this.selectId) return null;
    s.expiries.set(expiries);
    const target = expiries.find((e) => e.iso === expiryIso) ?? expiries[0];
    if (!target) {
      s.loadState.set('error');
      return null;
    }

    const gotSpot = await this.waitForSpot();
    if (sid !== this.selectId) return null;
    if (!gotSpot) {
      s.loadState.set('error');
      return null;
    }
    return target.iso;
  }

  private subscribeChain(meta: ChainMeta): void {
    const known = this.transport.limitReached();
    if (known !== null) {
      this.subscribeWindow(meta, known);
      return;
    }
    const all = contractKeys(meta);
    this.transport.subscribe(all);
    this.subscribedContracts = all;
    this.appliedLimit = null;
    this.store.partialChain.set(false);
    const now = this.transport.limitReached(); // a synchronous transport reports the limit right away
    if (now !== null) this.subscribeWindow(meta, now);
  }

  private onLimitReached(limit: number): void {
    const meta = this.store.meta();
    if (!meta || this.subscribedContracts.length === 0 || this.appliedLimit === limit) return;
    this.subscribeWindow(meta, limit);
  }

  /** Spec §3.3: the full chain does not fit. Drop the contract subscriptions and keep ±N strikes around ATM. */
  private subscribeWindow(meta: ChainMeta, limit: number): void {
    this.transport.unsubscribe(this.subscribedContracts);
    const keys = windowKeys(meta, this.store.spot() ?? 0, strikesEachSideForLimit(limit - this.extraQuickKeys()));
    this.transport.subscribe(keys);
    this.subscribedContracts = keys;
    this.appliedLimit = limit;
    this.store.partialChain.set(keys.length < contractKeys(meta).length);
  }

  /** Delivers the buffered ticks now (outside the frame throttle) and resolves a pending spot wait. */
  private flushNow(): void {
    const batch = this.buffer.drain();
    if (batch.size > 0) this.store.applyTicks(batch);
    if (this.spotWaiter && this.store.spot() !== null) this.spotWaiter(true);
  }

  private waitForSpot(): Promise<boolean> {
    if (this.store.spot() !== null) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const cancel = this.schedule(() => done(false), SPOT_TIMEOUT_MS);
      const done = (ok: boolean) => {
        if (this.spotWaiter !== done) return;
        this.spotWaiter = null;
        cancel();
        resolve(ok);
      };
      this.spotWaiter = done;
      // The underlying's ack may already sit in the buffer (it can arrive during subscribe()): deliver it now.
      this.flushNow();
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof SessionExpiredError) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private fail(err: unknown): void {
    if (err instanceof SessionExpiredError) this.onSessionExpired();
    this.store.loadState.set('error');
  }

  /**
   * Spec §6: stop this view's feed subscriptions and any further loads for the current selection.
   * INTEGRATION: when store.sessionExpired() is true the shell runs re-login; after it, refresh the session config
   * (NOREN_SESSION_CONFIG getter) and call reconnect().
   */
  private onSessionExpired(): void {
    ++this.selectId;
    ++this.requestId;
    this.selectInProgress = false;
    this.spotWaiter?.(false);
    this.unsubscribeAll();
    this.unsubscribeQuick();
    this.store.sessionExpired.set(true);
    if (this.store.loadState() === 'loading') this.store.loadState.set('error');
  }

  /**
   * D18: the quick-switch buttons show live prices, so their keys stay subscribed for the page's lifetime. The
   * transport ref-counts, so select() subscribing and unsubscribing the same key never drops these.
   */
  private subscribeQuick(): void {
    if (this.quickSubscribed) return;
    this.quickSubscribed = true;
    this.transport.subscribe(QUICK_KEYS);
  }

  private unsubscribeQuick(): void {
    if (!this.quickSubscribed) return;
    this.quickSubscribed = false;
    this.transport.unsubscribe(QUICK_KEYS);
  }

  /** Quick keys held besides the selected underlying: they count against the subscription limit too. */
  private extraQuickKeys(): number {
    return this.quickSubscribed ? QUICK_KEYS.filter((k) => k !== this.subscribedUnderlying).length : 0;
  }

  private unsubscribeAll(): void {
    const keys = [...this.subscribedContracts];
    if (this.subscribedUnderlying) keys.push(this.subscribedUnderlying);
    this.subscribedContracts = [];
    this.subscribedUnderlying = null;
    this.appliedLimit = null;
    if (keys.length > 0) this.transport.unsubscribe(keys);
  }
}

/** Feed key "EXCH|token" of a touchline ack / feed message, or null for anything else. */
function feedKeyOf(m: object): string | null {
  const r = m as Record<string, unknown>;
  if (r['t'] !== 'tk' && r['t'] !== 'tf') return null;
  return typeof r['e'] === 'string' && typeof r['tk'] === 'string' ? `${r['e']}|${r['tk']}` : null;
}

/** Contract keys of the ±n strikes around the strike nearest `spot`. */
function windowKeys(meta: ChainMeta, spot: number, n: number): string[] {
  const strikes = meta.strikes;
  if (strikes.length === 0) return [];
  const atm = nearestStrikeIndex(strikes.map((s) => s.strike), spot);
  const lo = Math.max(0, atm - n);
  const hi = Math.min(strikes.length - 1, atm + n);
  return contractKeys({ ...meta, strikes: strikes.slice(lo, hi + 1) });
}
