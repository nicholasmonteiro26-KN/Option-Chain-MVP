import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { OPTION_CHAIN_MOCK_MODE, OPTION_CHAIN_USER_ID } from '../feature-shell/option-chain.providers';
import {
  LegContract, LegEdit, LegResult, MAX_LEGS, Product, roundToTick, Strategy, StrategyLeg,
} from './strategy.models';

type ByUnderlying = Record<string, Strategy>;

const emptyStrategy = (): Strategy => ({ legs: [], lotMultiplier: 1, product: 'I' });
const EMPTY: Strategy = emptyStrategy();

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
/** A finite integer ≥ 1 (non-finite → 1); lots and the multiplier end up in order quantities. */
const posInt = (n: unknown): number => (isNum(n) ? Math.max(1, Math.floor(n)) : 1);

function parseLeg(raw: unknown): StrategyLeg | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (
    !isStr(l['id']) || !isStr(l['token']) || !isStr(l['tsym']) || !isStr(l['exch']) || !isStr(l['expiryIso']) ||
    !isNum(l['strike']) || !isNum(l['lotSize']) || !isNum(l['lots']) || !isNum(l['price']) ||
    (l['type'] !== 'CE' && l['type'] !== 'PE') || (l['side'] !== 'B' && l['side'] !== 'S') ||
    (l['priceType'] !== 'LMT' && l['priceType'] !== 'MKT') || typeof l['included'] !== 'boolean'
  ) return null;
  return {
    id: l['id'], token: l['token'], tsym: l['tsym'], exch: l['exch'], expiryIso: l['expiryIso'],
    strike: l['strike'], type: l['type'], lotSize: l['lotSize'], side: l['side'],
    lots: posInt(l['lots']), priceType: l['priceType'], price: l['price'], included: l['included'],
    ...(isNum(l['tickSize']) && l['tickSize'] > 0 ? { tickSize: l['tickSize'] } : {}),
  };
}

function parseStored(raw: string | null): ByUnderlying {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { byUnderlying?: unknown } | null;
    const by = parsed?.byUnderlying;
    if (!by || typeof by !== 'object' || Array.isArray(by)) return {};
    const out: ByUnderlying = {};
    for (const [key, v] of Object.entries(by as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const s = v as Record<string, unknown>;
      if (!Array.isArray(s['legs'])) continue;
      const legs = s['legs'].map(parseLeg);
      if (legs.some((l) => l === null)) continue;
      out[key] = {
        legs: (legs as StrategyLeg[]).slice(0, MAX_LEGS),
        lotMultiplier: posInt(s['lotMultiplier']),
        product: s['product'] === 'M' ? 'M' : 'I',
      };
    }
    return out;
  } catch {
    return {};
  }
}

function toStored(by: ByUnderlying): string {
  const stripped: ByUnderlying = {};
  for (const [k, s] of Object.entries(by)) {
    stripped[k] = { ...s, legs: s.legs.map(({ result: _result, ...leg }) => leg) };
  }
  return JSON.stringify({ byUnderlying: stripped });
}

/** The legs of the user's strategy per underlying; the single source of the chain's tick boxes. */
@Injectable()
export class StrategyStore {
  /** Per data mode and user: mock mode's 'demo' and a live fallback uid 'demo' never share legs. */
  private readonly storageKey =
    `ts.optionChain.strategy.v1:${inject(OPTION_CHAIN_MOCK_MODE) ? 'mock' : 'live'}:${inject(OPTION_CHAIN_USER_ID)}`;
  private readonly byUnderlying = signal<ByUnderlying>(this.read());
  private readonly active = signal('');
  private counter = this.seedCounter();

  /** The underlying key whose strategy is current. */
  readonly activeKey = this.active.asReadonly();
  readonly current = computed<Strategy>(() => this.byUnderlying()[this.active()] ?? EMPTY);
  readonly tokens = computed<ReadonlySet<string>>(() => new Set(this.current().legs.map((l) => l.token)));
  readonly allTokens = computed<string[]>(() => [
    ...new Set(Object.values(this.byUnderlying()).flatMap((s) => s.legs.map((l) => l.token))),
  ]);

  constructor() {
    effect(() => this.write(this.byUnderlying()));
  }

  setUnderlying(key: string): void {
    this.active.set(key);
  }

  toggle(c: LegContract): 'added' | 'removed' | 'full' {
    const k = c.token;
    const cur = this.current();
    const existing = cur.legs.find((l) => l.token === k);
    if (existing) {
      this.mutate((s) => ({ ...s, legs: s.legs.filter((l) => l.id !== existing.id) }));
      return 'removed';
    }
    if (cur.legs.length >= MAX_LEGS) return 'full';
    const { ltp, ...rest } = c;
    const leg: StrategyLeg = {
      ...rest, id: `leg-${++this.counter}`, side: 'B', lots: 1, priceType: 'LMT', price: ltp ?? 0, included: true,
    };
    this.mutate((s) => ({ ...s, legs: [...s.legs, leg] }));
    return 'added';
  }

  remove(id: string): void {
    this.mutate((s) => ({ ...s, legs: s.legs.filter((l) => l.id !== id) }));
  }

  clear(): void {
    this.mutate((s) => ({ ...s, legs: [] }));
  }

  /** Lots become a positive integer and a limit price is rounded to the leg's tick size. */
  update(id: string, edit: LegEdit): void {
    const patch = edit.lots === undefined ? edit : { ...edit, lots: posInt(edit.lots) };
    this.mapLeg(id, (l) => ({
      ...withoutResult(l), ...patch, ...(patch.price === undefined ? {} : { price: roundToTick(patch.price, l.tickSize) }),
    }));
  }

  swap(id: string, c: LegContract): 'ok' | 'duplicate' {
    const k = c.token;
    if (this.current().legs.some((l) => l.id !== id && l.token === k)) return 'duplicate';
    const { ltp, ...rest } = c;
    this.mapLeg(id, (l) => ({ ...withoutResult(l), ...rest, price: ltp ?? 0 }));
    return 'ok';
  }

  setLotMultiplier(n: number): void {
    const lotMultiplier = posInt(n);
    this.mutate((s) => ({ ...s, lotMultiplier }));
  }

  setProduct(product: Product): void {
    this.mutate((s) => ({ ...s, product }));
  }

  resetPrices(live: ReadonlyMap<string, number>): void {
    this.mutate((s) => ({
      ...s,
      legs: s.legs.map((l) => {
        const px = live.get(l.token);
        return l.priceType === 'LMT' && px !== undefined ? { ...l, price: px } : l;
      }),
    }));
  }

  /**
   * Records order results on the strategy of `key` (default: the current one), so results of a run land on the
   * strategy that was placed even if another became current meanwhile. Never creates a strategy. A placed leg is
   * taken out of the strategy (`included: false`, result kept), so a second Execute all never sends it again; the user
   * may put it back deliberately (any edit clears its result).
   */
  setResults(results: ReadonlyMap<string, LegResult>, key: string = this.active()): void {
    this.byUnderlying.update((by) => {
      const s = by[key];
      if (!s) return by;
      const legs = s.legs.map((l) => {
        const result = results.get(l.id);
        if (!result) return l;
        return result.status === 'placed' ? { ...l, result, included: false } : { ...l, result };
      });
      return { ...by, [key]: { ...s, legs } };
    });
    // Save now: a run can finish after the page is torn down (session expiry, reload), when the write effect is gone;
    // a placed leg must reach storage unticked or the next Execute all would send it again.
    this.write(this.byUnderlying());
  }

  /** Clears everything and the stored copy (log out). */
  forget(): void {
    this.byUnderlying.set({});
    this.active.set('');
    // Remove the stored copy now: the write effect may never run if the page is torn down at log-out.
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch {
      /* storage unavailable */
    }
  }

  private mapLeg(id: string, fn: (l: StrategyLeg) => StrategyLeg): void {
    this.mutate((s) => ({ ...s, legs: s.legs.map((l) => (l.id === id ? fn(l) : l)) }));
  }

  private mutate(fn: (s: Strategy) => Strategy): void {
    const key = this.active();
    this.byUnderlying.update((by) => ({ ...by, [key]: fn(by[key] ?? emptyStrategy()) }));
  }

  private read(): ByUnderlying {
    try {
      return parseStored(sessionStorage.getItem(this.storageKey));
    } catch {
      return {};
    }
  }

  private write(by: ByUnderlying): void {
    try {
      if (Object.keys(by).length === 0) sessionStorage.removeItem(this.storageKey);
      else sessionStorage.setItem(this.storageKey, toStored(by));
    } catch {
      /* storage unavailable or full: the strategy is best-effort */
    }
  }

  private seedCounter(): number {
    let max = 0;
    for (const s of Object.values(this.byUnderlying())) {
      for (const l of s.legs) max = Math.max(max, Number(/^leg-(\d+)$/.exec(l.id)?.[1] ?? 0));
    }
    return max;
  }
}

function withoutResult(l: StrategyLeg): StrategyLeg {
  const { result: _result, ...rest } = l;
  return rest;
}
