import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { FeedStatus, FeedTransport } from './transport';

export interface MockFeedOptions {
  /** Snapshot (tk ack fields, as wire strings) for a feed key "EXCH|token", or null for unknown keys. */
  seed: (key: string) => Record<string, string> | null;
  /** Ticks per second (default 20). */
  tickRateHz?: number;
  random?: () => number;
  /** One-shot scheduler returning a cancel function (default: setTimeout). */
  scheduler?: (cb: () => void, ms: number) => () => void;
  /** Max simultaneously subscribed keys. Keys beyond it are not acked and `limitReached` reports the limit. */
  subscriptionLimit?: number;
  /** When set, `limitReached` is reported this many ms after the rejecting subscribe (via `scheduler`), not synchronously. */
  limitReportDelayMs?: number;
  /**
   * Optional market model. When set, each tick emits the messages it returns (for all subscribed keys at once,
   * so a model can move the underlying and keep option legs consistent with it) instead of the generic random
   * walk of one key, and acks send `seed(key)` as-is, so `seed` should reflect the model's current state.
   */
  marketTick?: (subscribed: readonly string[], random: () => number) => Record<string, string>[];
}

interface MockState {
  lp: number;
  ti: number;
  v: number;
  oi: number;
}

const defaultScheduler = (cb: () => void, ms: number): (() => void) => {
  const h = setTimeout(cb, ms);
  return () => clearTimeout(h);
};

/** Generic fake feed: acks with seeded `tk`, then emits random partial `tf` ticks. */
export class MockFeedTransport implements FeedTransport {
  private readonly _status = signal<FeedStatus>('closed');
  readonly status = this._status.asReadonly();
  private readonly _messages = new Subject<object>();
  readonly messages = this._messages.asObservable();
  private readonly _limitReached = signal<number | null>(null);
  readonly limitReached = this._limitReached.asReadonly();
  /** Wire-equivalent log of what a real client would send: `{t:'t'|'u', k:'A#B'}` while open. */
  readonly sent: object[] = [];

  private readonly seed: MockFeedOptions['seed'];
  private readonly subscriptionLimit: number | undefined;
  private readonly limitReportDelayMs: number | undefined;
  private limitReportScheduled = false;
  private readonly tickMs: number;
  private readonly random: () => number;
  private readonly marketTick: MockFeedOptions['marketTick'];
  private readonly scheduler: (cb: () => void, ms: number) => () => void;

  private readonly refCounts = new Map<string, number>();
  private readonly state = new Map<string, MockState>();
  private cancelTick: (() => void) | null = null;
  private cancelReopen: (() => void) | null = null;
  private shutDown = false;

  constructor(opts: MockFeedOptions) {
    this.seed = opts.seed;
    this.tickMs = 1000 / (opts.tickRateHz ?? 20);
    this.random = opts.random ?? Math.random;
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.subscriptionLimit = opts.subscriptionLimit;
    this.limitReportDelayMs = opts.limitReportDelayMs;
    this.marketTick = opts.marketTick;
  }

  /** Simulates the server rejecting the session (WS `ck` Not_Ok): status 'session-expired', no more ticks. */
  expireSession(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    this.cancelReopen?.();
    this.cancelReopen = null;
    this._status.set('session-expired');
  }

  /** Stops the mock for good (page destroyed): no more ticks or reconnects; status 'closed'. */
  close(): void {
    this.shutDown = true;
    this.cancelTick?.();
    this.cancelTick = null;
    this.cancelReopen?.();
    this.cancelReopen = null;
    this._status.set('closed');
  }

  /** Keys currently subscribed (accepted by the mock "server"). */
  subscribedKeys(): string[] {
    return [...this.refCounts.keys()];
  }

  connect(): Promise<void> {
    this._status.set('open');
    for (const key of this.refCounts.keys()) this.ack(key);
    this.scheduleTick();
    return Promise.resolve();
  }

  send(_msg: object): void {
    // Nothing to do: the mock has no server.
  }

  subscribe(keys: string[]): void {
    const open = this._status() === 'open';
    const fresh: string[] = [];
    for (const key of new Set(keys)) {
      const n = this.refCounts.get(key) ?? 0;
      if (n > 0) {
        this.refCounts.set(key, n + 1);
        continue;
      }
      fresh.push(key);
      if (this.subscriptionLimit !== undefined && this.refCounts.size >= this.subscriptionLimit) {
        this.reportLimit(this.subscriptionLimit); // rejected: not subscribed, not acked
        continue;
      }
      this.refCounts.set(key, 1);
      if (open) this.ack(key);
    }
    if (open && fresh.length > 0) this.sent.push({ t: 't', k: fresh.join('#') });
  }

  unsubscribe(keys: string[]): void {
    const gone: string[] = [];
    for (const key of new Set(keys)) {
      const n = this.refCounts.get(key);
      if (n === undefined) continue;
      if (n <= 1) {
        this.refCounts.delete(key);
        this.state.delete(key);
        gone.push(key);
      } else {
        this.refCounts.set(key, n - 1);
      }
    }
    if (this._status() === 'open' && gone.length > 0) this.sent.push({ t: 'u', k: gone.join('#') });
  }

  /** Simulates a dropped connection: reconnecting for 1 s, then open again with subscriptions re-acked. */
  drop(): void {
    this.cancelTick?.();
    this.cancelTick = null;
    this.cancelReopen?.();
    this._status.set('reconnecting');
    this.cancelReopen = this.scheduler(() => {
      this.cancelReopen = null;
      if (this.shutDown) return;
      this._status.set('open');
      for (const key of this.refCounts.keys()) this.ack(key);
      this.scheduleTick();
    }, 1000);
  }

  private reportLimit(limit: number): void {
    if (this.limitReportDelayMs === undefined) {
      this._limitReached.set(limit);
      return;
    }
    if (this.limitReportScheduled || this._limitReached() === limit) return;
    this.limitReportScheduled = true;
    this.scheduler(() => {
      this.limitReportScheduled = false;
      this._limitReached.set(limit);
    }, this.limitReportDelayMs);
  }

  private ack(key: string): void {
    const seed = this.seed(key);
    if (!seed) return;
    const [e, tk] = splitKey(key);
    if (this.marketTick) {
      this._messages.next({ ...seed, t: 'tk', e, tk });
      return;
    }
    const existing = this.state.get(key);
    if (!existing) {
      this.state.set(key, {
        lp: numOr(seed['lp'], 100),
        ti: numOr(seed['ti'], 0.05) || 0.05,
        v: numOr(seed['v'], 0),
        oi: numOr(seed['oi'], 0),
      });
    }
    const cur = this.state.get(key)!;
    const msg: Record<string, string> = { ...seed, t: 'tk', e, tk };
    if ('lp' in seed) msg['lp'] = cur.lp.toFixed(2);
    if ('v' in seed) msg['v'] = String(cur.v);
    if ('oi' in seed) msg['oi'] = String(cur.oi);
    this._messages.next(msg);
  }

  private scheduleTick(): void {
    this.cancelTick?.();
    this.cancelTick = this.scheduler(() => {
      this.cancelTick = null;
      if (this._status() !== 'open') return;
      this.tick();
      this.scheduleTick();
    }, this.tickMs);
  }

  private tick(): void {
    if (this.marketTick) {
      for (const m of this.marketTick([...this.refCounts.keys()], this.random)) this._messages.next(m);
      return;
    }
    const keys = [...this.refCounts.keys()].filter((k) => this.state.has(k));
    if (keys.length === 0) return;
    const key = keys[Math.min(keys.length - 1, Math.floor(this.random() * keys.length))]!;
    const s = this.state.get(key)!;
    const [e, tk] = splitKey(key);

    let steps = Math.round((this.random() - 0.5) * 6);
    if (steps === 0) steps = this.random() < 0.5 ? -1 : 1;
    s.lp = Math.max(s.ti, round2(s.lp + steps * s.ti));

    const msg: Record<string, string> = { t: 'tf', e, tk, lp: s.lp.toFixed(2) };
    if (this.random() < 0.5) {
      s.v += Math.floor(this.random() * 100) + 1;
      msg['v'] = String(s.v);
      if (this.random() < 0.5) {
        s.oi = Math.max(0, s.oi + Math.round((this.random() - 0.5) * 100));
        msg['oi'] = String(s.oi);
      }
    }
    this._messages.next(msg);
  }
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

function numOr(text: string | undefined, fallback: number): number {
  const n = Number(text);
  return text !== undefined && text !== '' && Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
