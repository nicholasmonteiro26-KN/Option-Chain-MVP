import { computed, DestroyRef, inject, Injectable, InjectionToken, Signal, signal } from '@angular/core';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from './chain-feed.facade';

/** IST is a fixed UTC+05:30 (no daylight saving). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
/** How often the session (and the clock the page prunes expiries with) is re-evaluated. */
export const SESSION_CHECK_MS = 30_000;

/**
 * NSE/BSE F&O normal trading session: Monday to Friday, 09:15:00 (inclusive) to 15:30:00 (exclusive) IST. Computed
 * from epoch ms with the fixed +05:30 offset and UTC getters, so the machine's time zone never matters.
 */
export function isNseFoSessionOpen(nowMs: number): boolean {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const min = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return min >= OPEN_MIN && min < CLOSE_MIN;
}

/**
 * The rule deciding whether the market is open at a given instant. Mock mode swaps in "always open" (the simulated
 * market trades around the clock).
 * INTEGRATION: exchange holiday calendar / special sessions (Muhurat trading, Saturday sessions) from TradeSmart's
 * market-calendar service; this default knows only weekdays and normal hours.
 */
export const MARKET_SESSION_RULE = new InjectionToken<(nowMs: number) => boolean>('MARKET_SESSION_RULE', {
  providedIn: 'root',
  factory: () => isNseFoSessionOpen,
});

/**
 * Market open/closed for one chain page, from the injected clock, re-evaluated every 30 s on the injected scheduler.
 * Drives the "Market closed" banner, the one-pass analytics rule and stale gating (the feed status does not: a
 * socket can be open after hours). Provided by the feature alongside the store.
 */
@Injectable()
export class MarketSessionService {
  private readonly clock = inject(CHAIN_FEED_CLOCK);
  private readonly schedule = inject(CHAIN_FEED_SCHEDULER);
  private readonly rule = inject(MARKET_SESSION_RULE);

  private readonly _now = signal(this.clock());
  /** The clock as of the last evaluation (updated every 30 s). */
  readonly nowMs: Signal<number> = this._now.asReadonly();
  /** True during the trading session. */
  readonly isOpen: Signal<boolean> = computed(() => this.rule(this._now()));

  private cancel: (() => void) | null = null;

  constructor() {
    this.arm();
    inject(DestroyRef).onDestroy(() => {
      this.cancel?.();
      this.cancel = null;
    });
  }

  /** Re-reads the clock now (it also happens every 30 s). */
  refresh(): void {
    this._now.set(this.clock());
  }

  private arm(): void {
    this.cancel = this.schedule(() => {
      this.refresh();
      this.arm();
    }, SESSION_CHECK_MS);
  }
}
