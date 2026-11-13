import { computed, DestroyRef, inject, Injectable, InjectionToken, Signal, signal } from '@angular/core';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from './chain-feed.facade';
import { OptionChainStore } from './option-chain.store';

/** IST is a fixed UTC+05:30 (no daylight saving). */
const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
/** NSE/BSE F&O: 09:15 to 15:40 IST (trading continues to 15:40 since the closing auction session). */
const EQ_OPEN_MIN = 9 * 60 + 15;
const EQ_CLOSE_MIN = 15 * 60 + 40;
/** MCX: 09:00 to 23:30 IST, or 23:55 while the US is on daylight saving time (MCX follows the US close). */
const MCX_OPEN_MIN = 9 * 60;
const MCX_CLOSE_MIN = 23 * 60 + 30;
const MCX_CLOSE_US_DST_MIN = 23 * 60 + 55;
/** How often the session (and the clock the page prunes expiries with) is re-evaluated. */
export const SESSION_CHECK_MS = 30_000;

export type SessionRule = (nowMs: number, exch: string) => boolean;

/** Minutes since IST midnight and the IST weekday (0 = Sunday), from epoch ms, whatever the machine time zone. */
function istParts(nowMs: number): { day: number; min: number } {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return { day: ist.getUTCDay(), min: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

/** US daylight saving time (second Sunday of March 02:00 to first Sunday of November 02:00, US Eastern). */
export function isUsDst(nowMs: number): boolean {
  const y = new Date(nowMs).getUTCFullYear();
  const nthSunday = (month: number, n: number): number => {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  // 02:00 EST = 07:00 UTC (start); 02:00 EDT = 06:00 UTC (end).
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6);
  return nowMs >= start && nowMs < end;
}

/**
 * Normal trading session of the exchange the options trade on, Monday to Friday (opening inclusive, closing
 * exclusive): NFO / BFO 09:15-15:40 IST, MCX 09:00-23:30 IST (23:55 during US daylight saving time). Unknown
 * exchanges follow NFO hours.
 */
export function isFoSessionOpen(nowMs: number, exch: string): boolean {
  const { day, min } = istParts(nowMs);
  if (day === 0 || day === 6) return false;
  if (exch === 'MCX') {
    const close = isUsDst(nowMs) ? MCX_CLOSE_US_DST_MIN : MCX_CLOSE_MIN;
    return min >= MCX_OPEN_MIN && min < close;
  }
  return min >= EQ_OPEN_MIN && min < EQ_CLOSE_MIN;
}

/**
 * The rule deciding whether a market is open at a given instant. Mock mode swaps in "always open" (the simulated
 * market trades around the clock).
 * INTEGRATION: exchange holiday calendar / special sessions (Muhurat trading, Saturday sessions) from TradeSmart's
 * market-calendar service, or Kambala's ExchStatus / WS `ms` market-status messages; this default knows only
 * weekdays and normal hours.
 */
export const MARKET_SESSION_RULE = new InjectionToken<SessionRule>('MARKET_SESSION_RULE', {
  providedIn: 'root',
  factory: () => isFoSessionOpen,
});

/**
 * Market open/closed for the selected underlying's options exchange, from the injected clock, re-evaluated every 30 s
 * on the injected scheduler. Drives the feed dot (green only while that market is open), Execute all, the one-pass
 * analytics rule and stale gating (the feed status does not: a socket can be open after hours). Provided by the
 * feature alongside the store.
 */
@Injectable()
export class MarketSessionService {
  private readonly clock = inject(CHAIN_FEED_CLOCK);
  private readonly schedule = inject(CHAIN_FEED_SCHEDULER);
  private readonly rule = inject(MARKET_SESSION_RULE);
  private readonly store = inject(OptionChainStore, { optional: true });

  private readonly _now = signal(this.clock());
  /** The clock as of the last evaluation (updated every 30 s). */
  readonly nowMs: Signal<number> = this._now.asReadonly();
  /** The options exchange whose hours apply: the selected underlying's (NFO before one is chosen). */
  readonly exchange: Signal<string> = computed(() => this.store?.underlying()?.foExch ?? 'NFO');
  /** True during that exchange's trading session. */
  readonly isOpen: Signal<boolean> = computed(() => this.rule(this._now(), this.exchange()));

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
