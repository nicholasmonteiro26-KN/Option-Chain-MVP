import type { LegQuote } from '@option-analytics/types';
import type { TouchlineAck, TouchlineFeed } from '../kambala/kambala.types';

export type TickPartial = Partial<LegQuote> & { token: string };
export type TickMessage = TouchlineAck | TouchlineFeed | { readonly t: string; readonly [field: string]: unknown };
export type FrameScheduler = (fn: () => void) => unknown;

/** Wire field -> LegQuote field. Kambala sends numbers as strings. */
const FIELD_MAP = [
  ['lp', 'ltp'], ['bp1', 'bid'], ['sp1', 'ask'], ['bq1', 'bidQty'], ['sq1', 'askQty'],
  ['v', 'volume'], ['oi', 'oi'], ['poi', 'prevOi'], ['c', 'prevClose'], ['o', 'open'],
  ['h', 'high'], ['l', 'low'], ['ls', 'lotSize'], ['ti', 'tickSize'],
] as const;

/**
 * Minimum gap between two flushes into the store (spec §3: "flush on rAF ≈ 4/s"). At 20 ticks/s a per-frame flush
 * re-renders the whole chain up to 20 times a second; 250 ms keeps the table live while bounding that work.
 */
export const FLUSH_INTERVAL_MS = 250;

/** Delay used instead of an animation frame while the tab is hidden (browsers run no frames there). */
export const HIDDEN_FLUSH_DELAY_MS = 250;

/**
 * Next animation frame; in a hidden tab (where requestAnimationFrame never fires) or without rAF, a timer. So ticks
 * still reach the store, and a chain opened in a background tab still loads.
 */
export function defaultFrameScheduler(fn: () => void): unknown {
  if (typeof document !== 'undefined' && document.hidden) return setTimeout(fn, HIDDEN_FLUSH_DELAY_MS);
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(() => fn())
    : setTimeout(fn, 16);
}

/**
 * Coalesces touchline ticks per feed key ("EXCH|token") between drains.
 * Partial `tf` messages merge into the entry; absent fields stay absent.
 */
export class TickBuffer {
  private pending = new Map<string, TickPartial>();
  private flushCb: ((batch: Map<string, TickPartial>) => void) | null = null;
  private frameScheduled = false;
  private lastFlushMs = -Infinity;

  /**
   * @param now clock, for `lastTickMs` and the flush throttle
   * @param schedule animation-frame scheduler (requestAnimationFrame in the browser)
   * @param flushIntervalMs minimum time between two flushes; 0 delivers on the next frame
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly schedule: FrameScheduler = defaultFrameScheduler,
    private readonly flushIntervalMs: number = FLUSH_INTERVAL_MS,
  ) {}

  push(msg: TickMessage): void {
    if (msg.t !== 'tk' && msg.t !== 'tf') return;
    const raw = msg as unknown as Record<string, string | undefined>;
    const e = raw['e'];
    const tk = raw['tk'];
    if (!e || !tk) return;
    const key = `${e}|${tk}`;

    let entry = this.pending.get(key);
    if (!entry) {
      entry = { token: key };
      this.pending.set(key, entry);
    }
    const target = entry as Record<string, unknown>;
    for (const [wire, field] of FIELD_MAP) {
      const text = raw[wire];
      if (text === undefined || text === null || String(text).trim() === '') continue;
      const n = Number(text);
      if (!Number.isFinite(n)) continue;
      target[field] = n;
    }
    entry.lastTickMs = this.now();
    this.requestFlush();
  }

  /** Returns the merged partials since the last drain and clears the buffer. */
  drain(): Map<string, TickPartial> {
    const out = this.pending;
    this.pending = new Map();
    return out;
  }

  /**
   * Delivers drained batches on an animation frame, at most once every `flushIntervalMs` (≈ 4/s): a push schedules
   * a frame; a frame that comes earlier than the interval after the last flush waits for a later frame. Returns a
   * disposer.
   */
  flushOnAnimationFrame(cb: (batch: Map<string, TickPartial>) => void): () => void {
    this.flushCb = cb;
    if (this.pending.size > 0) this.requestFlush();
    return () => {
      if (this.flushCb === cb) this.flushCb = null;
    };
  }

  private requestFlush(): void {
    if (!this.flushCb || this.frameScheduled) return;
    this.frameScheduled = true;
    this.schedule(() => {
      this.frameScheduled = false;
      const cb = this.flushCb;
      if (!cb || this.pending.size === 0) return;
      const now = this.now();
      if (now - this.lastFlushMs < this.flushIntervalMs) {
        this.requestFlush(); // too soon: try again on a later frame
        return;
      }
      this.lastFlushMs = now;
      cb(this.drain());
    });
  }
}
