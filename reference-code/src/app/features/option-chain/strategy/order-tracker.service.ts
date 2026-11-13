import { DestroyRef, inject, Injectable } from '@angular/core';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { FEED_TRANSPORT } from '../data-access/feed/transport';
import { KambalaRestApi, KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { OrderStatusRow, SessionExpiredError } from '../data-access/kambala/kambala.types';
import { isFinalPhase, toOrderState } from './strategy.models';
import { StrategyStore } from './strategy.store';

/** Checks every 2 s for the first minute after placing, then every 10 s, until every order is final. */
export const TRACK_FAST_MS = 2_000;
export const TRACK_SLOW_MS = 10_000;
const FAST_FOR_MS = 60_000;

interface Tracked { key: string; legId: string; orderNo: string }

/**
 * Follows the orders Execute all placed until each is final (filled, rejected or cancelled), writing each change to
 * the strategy (`StrategyStore.setOrderState`), so the pop-up shows Open / Partly filled / Filled / Rejected /
 * Cancelled per leg. Two sources: Kambala's WS order updates (`t: "om"`, applied at once) and SingleOrdHist polling
 * (in case the socket sends none). Stops with the page.
 */
@Injectable()
export class OrderTracker {
  private readonly rest = inject<KambalaRestApi>(KambalaRestClient);
  private readonly schedule = inject(CHAIN_FEED_SCHEDULER);
  private readonly clock = inject(CHAIN_FEED_CLOCK);
  private readonly strategy = inject(StrategyStore);

  private readonly tracked = new Map<string, Tracked>(); // by order number
  private fastUntil = 0;
  private cancelTimer: (() => void) | null = null;
  private polling = false;
  private stopped = false;

  constructor() {
    const sub = inject(FEED_TRANSPORT).messages.subscribe((m) => this.onMessage(m as OrderStatusRow & { t?: string }));
    inject(DestroyRef).onDestroy(() => {
      this.stopped = true;
      sub.unsubscribe();
      this.cancelTimer?.();
      this.cancelTimer = null;
    });
  }

  /** Orders being followed (not final yet). */
  get size(): number { return this.tracked.size; }

  /** Starts following these placed orders (of the strategy `key`) and checks them now. */
  track(key: string, orders: readonly { legId: string; orderNo: string }[]): void {
    if (this.stopped) return;
    for (const o of orders) if (o.orderNo) this.tracked.set(o.orderNo, { key, legId: o.legId, orderNo: o.orderNo });
    this.fastUntil = this.clock() + FAST_FOR_MS;
    void this.poll();
  }

  /** Checks the followed orders now (e.g. right after Cancel open orders). */
  refresh(): Promise<void> {
    this.fastUntil = Math.max(this.fastUntil, this.clock() + FAST_FOR_MS);
    return this.poll();
  }

  private onMessage(m: OrderStatusRow & { t?: string }): void {
    if (m.t !== 'om' || !m.norenordno) return;
    const t = this.tracked.get(m.norenordno);
    if (t) this.apply(t, m);
  }

  private apply(t: Tracked, row: OrderStatusRow): void {
    const order = toOrderState(row);
    this.strategy.setOrderState(t.key, t.legId, order);
    if (isFinalPhase(order.phase)) this.tracked.delete(t.orderNo);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    try {
      for (const t of [...this.tracked.values()]) {
        if (this.stopped) return;
        try {
          this.apply(t, await this.rest.orderStatus(t.orderNo));
        } catch (e) {
          if (e instanceof SessionExpiredError) { this.tracked.clear(); return; } // the page handles the re-login
          // Otherwise keep the last known state and try again next time.
        }
      }
    } finally {
      this.polling = false;
      if (!this.stopped && this.tracked.size > 0) {
        const ms = this.clock() < this.fastUntil ? TRACK_FAST_MS : TRACK_SLOW_MS;
        this.cancelTimer = this.schedule(() => { this.cancelTimer = null; void this.poll(); }, ms);
      }
    }
  }
}
