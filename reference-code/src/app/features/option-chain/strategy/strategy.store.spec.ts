import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPTION_CHAIN_MOCK_MODE, OPTION_CHAIN_USER_ID } from '../feature-shell/option-chain.providers';
import { LegContract, Strategy, netPremium, MAX_LEGS } from './strategy.models';
import { StrategyStore } from './strategy.store';

const KEY = 'ts.optionChain.strategy.v1:live:u1';
const contract = (strike: number, type: 'CE' | 'PE' = 'CE', ltp: number | null = 100): LegContract => ({
  token: `NFO|${strike * 10 + (type === 'CE' ? 1 : 2)}`,
  tsym: `NIFTY${strike}${type}`,
  exch: 'NFO',
  expiryIso: '2026-11-17',
  strike,
  type,
  lotSize: 65,
  ltp,
});

function make(mock = false): StrategyStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      StrategyStore,
      { provide: OPTION_CHAIN_USER_ID, useValue: 'u1' },
      { provide: OPTION_CHAIN_MOCK_MODE, useValue: mock },
    ],
  });
  return TestBed.inject(StrategyStore);
}
const flush = () => TestBed.tick();

describe('StrategyStore', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  it('toggle adds a Buy of 1 lot, LMT at the LTP, included; toggling again removes it', () => {
    const s = make();
    s.setUnderlying('NSE|26000');
    expect(s.toggle(contract(23000, 'CE', 14.95))).toBe('added');
    const leg = s.current().legs[0]!;
    expect(leg).toMatchObject({ side: 'B', lots: 1, priceType: 'LMT', price: 14.95, included: true, strike: 23000 });
    expect(s.tokens().has('NFO|230001')).toBe(true);
    expect(s.toggle(contract(23000, 'CE', 14.95))).toBe('removed');
    expect(s.current().legs).toEqual([]);
  });

  it('uses 0 when the contract has no LTP', () => {
    const s = make();
    s.toggle(contract(23000, 'CE', null));
    expect(s.current().legs[0]!.price).toBe(0);
  });

  it('an 11th leg returns "full" and is not added', () => {
    const s = make();
    for (let i = 0; i < MAX_LEGS; i++) expect(s.toggle(contract(20000 + i * 50))).toBe('added');
    expect(s.toggle(contract(25000))).toBe('full');
    expect(s.current().legs.length).toBe(10);
  });

  it('strategies are per underlying', () => {
    const s = make();
    s.setUnderlying('NSE|26000');
    s.toggle(contract(23000));
    s.setUnderlying('BSE|1');
    expect(s.current().legs).toEqual([]);
    expect(s.tokens().size).toBe(0);
    expect(s.allTokens()).toEqual(['NFO|230001']);
    s.setUnderlying('NSE|26000');
    expect(s.current().legs.length).toBe(1);
  });

  it('swap keeps side and lots, takes the new contract and its LTP; duplicate changes nothing', () => {
    const s = make();
    s.toggle(contract(23000, 'CE', 10));
    s.toggle(contract(23100, 'CE', 5));
    const id = s.current().legs[0]!.id;
    s.update(id, { side: 'S', lots: 3, included: false });
    expect(s.swap(id, contract(22900, 'PE', 68.85))).toBe('ok');
    const leg = s.current().legs[0]!;
    expect(leg).toMatchObject({ id, side: 'S', lots: 3, included: false, strike: 22900, type: 'PE', price: 68.85 });
    const before = s.current();
    expect(s.swap(id, contract(23100, 'CE', 5))).toBe('duplicate');
    expect(s.current()).toEqual(before);
  });

  it('update clamps lots to 1 and clears the leg result', () => {
    const s = make();
    s.toggle(contract(23000));
    const id = s.current().legs[0]!.id;
    s.setResults(new Map([[id, { status: 'placed' as const, orderNo: '1' }]]));
    expect(s.current().legs[0]!.result).toEqual({ status: 'placed', orderNo: '1' });
    s.update(id, { lots: 0 });
    expect(s.current().legs[0]!.lots).toBe(1);
    expect(s.current().legs[0]!.result).toBeUndefined();
  });

  it('mock and live data keep separate stored strategies for the same uid', () => {
    const mock = make(true);
    mock.toggle(contract(23000));
    flush();
    expect(sessionStorage.getItem('ts.optionChain.strategy.v1:mock:u1')).not.toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(make(false).current().legs).toEqual([]);
    expect(make(true).current().legs).toHaveLength(1);
  });

  it('a placed leg is taken out of the strategy (included: false) and keeps its result; others stay in', () => {
    const s = make();
    s.toggle(contract(23000));
    s.toggle(contract(23100));
    const [a, b] = s.current().legs;
    s.setResults(new Map([
      [a!.id, { status: 'placed' as const, orderNo: '1' }],
      [b!.id, { status: 'rejected' as const, reason: 'RMS' }],
    ]));
    expect(s.current().legs[0]).toMatchObject({ included: false, result: { status: 'placed', orderNo: '1' } });
    expect(s.current().legs[1]).toMatchObject({ included: true, result: { status: 'rejected', reason: 'RMS' } });
  });

  it('a limit price is rounded to the contract tick size (0.05 when unknown)', () => {
    const s = make();
    s.toggle(contract(23000));
    s.toggle({ ...contract(23100), tickSize: 0.1 });
    const [a, b] = s.current().legs;
    s.update(a!.id, { price: 12.33 });
    s.update(b!.id, { price: 12.33 });
    expect(s.current().legs[0]!.price).toBe(12.35);
    expect(s.current().legs[1]!.price).toBe(12.3);
  });

  it('setResults can target the strategy of another underlying (by key) and never creates one', () => {
    const s = make();
    s.setUnderlying('NSE|26000');
    expect(s.activeKey()).toBe('NSE|26000');
    s.toggle(contract(23000));
    const id = s.current().legs[0]!.id;
    s.setUnderlying('BSE|1');
    const placed = { status: 'placed' as const, orderNo: '7' };
    s.setResults(new Map([[id, placed]]), 'NSE|26000');
    s.setResults(new Map([[id, placed]]), 'NSE|999');
    s.setResults(new Map([[id, placed]])); // the active one (BSE|1): no such leg, nothing created
    flush();
    expect(Object.keys(JSON.parse(sessionStorage.getItem(KEY)!).byUnderlying)).toEqual(['NSE|26000']);
    s.setUnderlying('NSE|26000');
    expect(s.current().legs[0]!.result).toEqual(placed);
  });

  it('remove, clear, multiplier, product, resetPrices', () => {
    const s = make();
    s.toggle(contract(23000, 'CE', 10));
    s.toggle(contract(23100, 'CE', 20));
    s.update(s.current().legs[1]!.id, { priceType: 'MKT' });
    s.setLotMultiplier(0);
    expect(s.current().lotMultiplier).toBe(1);
    s.setLotMultiplier(4);
    s.setProduct('M');
    expect(s.current()).toMatchObject({ lotMultiplier: 4, product: 'M' });
    s.resetPrices(new Map([['NFO|230001', 12], ['NFO|231001', 22]]));
    expect(s.current().legs.map((l) => l.price)).toEqual([12, 20]);
    s.remove(s.current().legs[0]!.id);
    expect(s.current().legs.length).toBe(1);
    s.clear();
    expect(s.current().legs).toEqual([]);
  });

  it('netPremium sums included legs, S positive and B negative, times qty', () => {
    const s = make();
    s.toggle(contract(22850, 'CE', 69.9));
    s.toggle(contract(22900, 'PE', 68.85));
    s.toggle(contract(23000, 'CE', 14.95));
    const a = s.current().legs[0]!;
    const b = s.current().legs[1]!;
    s.update(a.id, { side: 'S' });
    s.update(b.id, { side: 'S' });
    expect(netPremium(s.current(), new Map())).toBeCloseTo(8047, 6);
    s.update(s.current().legs[2]!.id, { included: false });
    expect(netPremium(s.current(), new Map())).toBeCloseTo((69.9 + 68.85) * 65, 6);
    s.update(a.id, { priceType: 'MKT' });
    expect(netPremium(s.current(), new Map([['NFO|228501', 70]]))).toBeCloseTo((70 + 68.85) * 65, 6);
    // MKT without a live price falls back to the stored price
    expect(netPremium(s.current(), new Map())).toBeCloseTo((69.9 + 68.85) * 65, 6);
  });

  it('netPremium applies the lot multiplier', () => {
    const st: Strategy = { legs: [], lotMultiplier: 2, product: 'I' };
    const s = make();
    s.toggle(contract(23000, 'CE', 10));
    s.update(s.current().legs[0]!.id, { side: 'S' });
    s.setLotMultiplier(2);
    expect(netPremium(s.current(), new Map())).toBe(10 * 65 * 2);
    expect(netPremium(st, new Map())).toBe(0);
  });

  it('persists to sessionStorage and restores on a new store, without results', () => {
    const s = make();
    s.setUnderlying('NSE|26000');
    s.toggle(contract(23000, 'CE', 14.95));
    s.setProduct('M');
    s.setResults(new Map([[s.current().legs[0]!.id, { status: 'placed' as const, orderNo: '9' }]]));
    flush();
    const raw = sessionStorage.getItem(KEY);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('orderNo');

    const s2 = make();
    s2.setUnderlying('NSE|26000');
    expect(s2.current().product).toBe('M');
    expect(s2.current().legs[0]!).toMatchObject({ strike: 23000, price: 14.95 });
    expect(s2.current().legs[0]!.result).toBeUndefined();
    s2.toggle(contract(23100));
    const ids = s2.current().legs.map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('ignores malformed stored data', () => {
    for (const bad of ['{', '{"byUnderlying":5}', '{"byUnderlying":{"NSE|26000":{"legs":[{"id":"leg-1"}],"lotMultiplier":1,"product":"I"}}}']) {
      sessionStorage.setItem(KEY, bad);
      const s = make();
      s.setUnderlying('NSE|26000');
      expect(s.current()).toEqual({ legs: [], lotMultiplier: 1, product: 'I' });
    }
  });

  it('forget clears everything and the stored copy', () => {
    const s = make();
    s.setUnderlying('NSE|26000');
    s.toggle(contract(23000));
    flush();
    expect(sessionStorage.getItem(KEY)).toBeTruthy();
    s.forget();
    flush();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(s.current().legs).toEqual([]);
    expect(s.allTokens()).toEqual([]);
  });

  it('forget removes the stored copy immediately, without flushing effects', () => {
    const s = make();
    s.setUnderlying('NSE|26000');
    s.toggle(contract(23000));
    flush();
    expect(sessionStorage.getItem(KEY)).toBeTruthy();
    s.forget();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('a placed result is saved immediately, so a page torn down mid-run never re-sends the leg', () => {
    const s = make();
    s.setUnderlying('NSE|26000');
    s.toggle(contract(23000));
    flush();
    const id = s.current().legs[0]!.id;
    // The run finishes after the page (and its write effect) is gone: no flush before the new store reads storage.
    s.setResults(new Map([[id, { status: 'placed', orderNo: 'X1' }]]), 'NSE|26000');
    const next = make();
    next.setUnderlying('NSE|26000');
    expect(next.current().legs[0]).toMatchObject({ id, included: false });
  });

  it('lots and the multiplier are always positive integers', () => {
    const s = make();
    s.toggle(contract(23000));
    const id = s.current().legs[0]!.id;
    s.update(id, { lots: NaN });
    expect(s.current().legs[0]!.lots).toBe(1);
    s.update(id, { lots: 2.5 });
    expect(s.current().legs[0]!.lots).toBe(2);
    s.update(id, { lots: Infinity });
    expect(s.current().legs[0]!.lots).toBe(1);
    s.setLotMultiplier(Infinity);
    expect(s.current().lotMultiplier).toBe(1);
    s.setLotMultiplier(NaN);
    expect(s.current().lotMultiplier).toBe(1);
    s.setLotMultiplier(3.9);
    expect(s.current().lotMultiplier).toBe(3);
  });

  it('normalises restored lots and lotMultiplier', () => {
    const leg = { id: 'leg-1', token: 'NFO|1', tsym: 'X', exch: 'NFO', expiryIso: '2026-11-17', strike: 1, type: 'CE', lotSize: 65, side: 'B', priceType: 'LMT', price: 1, included: true };
    const store = (lots: unknown, lotMultiplier: unknown) =>
      JSON.stringify({ byUnderlying: { 'NSE|26000': { legs: [{ ...leg, lots }], lotMultiplier, product: 'I' } } });
    sessionStorage.setItem(KEY, store(2.7, 2.7));
    let s = make();
    s.setUnderlying('NSE|26000');
    expect(s.current().lotMultiplier).toBe(2);
    expect(s.current().legs[0]!.lots).toBe(2);
    sessionStorage.setItem(KEY, store(0, 'x'));
    s = make();
    s.setUnderlying('NSE|26000');
    expect(s.current().lotMultiplier).toBe(1);
    expect(s.current().legs[0]!.lots).toBe(1);
  });
});
