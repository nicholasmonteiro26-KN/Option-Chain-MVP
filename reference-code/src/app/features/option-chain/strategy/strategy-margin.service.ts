import { DestroyRef, Injectable, Signal, computed, effect, inject, signal, untracked } from '@angular/core';
import { CHAIN_FEED_SCHEDULER } from '../data-access/chain-feed.facade';
import { KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { OrderLeg } from '../data-access/kambala/kambala.types';
import { Strategy, StrategyLeg, legQty } from './strategy.models';
import { StrategyStore } from './strategy.store';

export const MARGIN_DEBOUNCE_MS = 400;

export type MarginState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'ready'; margin: number; hedgeBenefit: number }
  | { status: 'error' };

/**
 * One leg as the Kambala API wants it. MKT legs carry the live price on GetBasketMargin
 * (the margin call needs a price) and 0 on PlaceOrder.
 */
export function toOrderLeg(leg: StrategyLeg, s: Strategy, livePrice: number | null, forMargin: boolean): OrderLeg {
  const market = leg.priceType === 'MKT';
  return {
    exch: leg.exch,
    tsym: leg.tsym,
    qty: legQty(leg, s.lotMultiplier),
    prc: market ? (forMargin ? (livePrice ?? leg.price) : 0) : leg.price,
    prctyp: leg.priceType,
    trantype: leg.side,
    prd: s.product,
  };
}

/** The strategy's margin and hedge benefit, re-requested (debounced) when the legs change. */
@Injectable()
export class StrategyMarginService {
  private readonly store = inject(StrategyStore);
  private readonly rest = inject(KambalaRestClient);
  private readonly schedule = inject(CHAIN_FEED_SCHEDULER);

  private readonly _state = signal<MarginState>({ status: 'empty' });
  private live: Signal<ReadonlyMap<string, number>> = signal(new Map());
  /** Whether margin is wanted (the pop-up is showing). Always, until `setActive` says otherwise. */
  private readonly activeSource = signal<Signal<boolean>>(signal(true));
  private wasActive = true;
  private cancelTimer: (() => void) | null = null;
  private round = 0;
  private destroyed = false;

  readonly state = this._state.asReadonly();

  /** Prices are not part of the key: a tick alone never triggers a request. */
  private readonly key = computed<string | null>(() => {
    const s = this.store.current();
    const legs = s.legs.filter((l) => l.included);
    if (legs.length === 0) return null;
    const parts = legs.map((l) => `${l.token}|${l.side}|${l.lots}|${l.priceType}|${l.price}`);
    return `${parts.join(';')}#${s.lotMultiplier}#${s.product}`;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.cancelPending();
      this.round++; // drops any in-flight answer
    });
    effect(() => {
      const key = this.key();
      const active = this.activeSource()();
      untracked(() => this.onChange(key, active));
    });
  }

  setLivePrices(live: Signal<ReadonlyMap<string, number>>): void {
    this.live = live;
  }

  /**
   * Requests only while `active` is true (the pop-up is open): becoming active requests at once, without the
   * debounce; becoming inactive drops any pending or in-flight request.
   */
  setActive(active: Signal<boolean>): void {
    this.activeSource.set(active);
  }

  retry(): void {
    if (this.destroyed || this.key() === null || !this.activeSource()()) return;
    this.cancelPending();
    this.request();
  }

  private onChange(key: string | null, active: boolean): void {
    const opened = active && !this.wasActive;
    this.wasActive = active;
    this.cancelPending();
    this.round++; // an answer still in flight belongs to the old legs (or nobody is looking)
    if (key === null || !active) {
      this._state.set({ status: 'empty' });
      return;
    }
    if (opened) {
      this.request();
      return;
    }
    this._state.set({ status: 'loading' });
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.request();
    }, MARGIN_DEBOUNCE_MS);
  }

  private cancelPending(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private request(): void {
    if (this.destroyed) return;
    const s = this.store.current();
    const live = this.live();
    const legs = s.legs.filter((l) => l.included).map((l) => toOrderLeg(l, s, live.get(l.token) ?? null, true));
    if (legs.length === 0) return;
    const id = ++this.round;
    this._state.set({ status: 'loading' });
    const combined = this.rest.getBasketMargin(legs);
    const singles = legs.length > 1 ? legs.map((l) => this.rest.getBasketMargin([l])) : [];
    Promise.all([combined, Promise.all(singles)]).then(
      ([margin, each]) => {
        if (id !== this.round) return;
        const hedgeBenefit = each.length === 0 ? 0 : each.reduce((a, b) => a + b, 0) - margin;
        this._state.set({ status: 'ready', margin, hedgeBenefit });
      },
      () => {
        if (id === this.round) this._state.set({ status: 'error' });
      },
    );
  }
}
