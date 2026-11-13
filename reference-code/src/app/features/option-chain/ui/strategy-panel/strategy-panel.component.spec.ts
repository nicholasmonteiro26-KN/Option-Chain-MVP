import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Expiry } from '../../data-access/models';
import type { MarginState } from '../../strategy/strategy-margin.service';
import type { Strategy, StrategyLeg } from '../../strategy/strategy.models';
import { StrategyPanelComponent } from './strategy-panel.component';

const EXPIRIES: Expiry[] = [
  { iso: '2026-11-10', exd: '10-NOV-2026', sampleTsym: 'NIFTY10NOV26C22850', foExch: 'NFO' },
  { iso: '2026-11-17', exd: '17-NOV-2026', sampleTsym: 'NIFTY17NOV26C22850', foExch: 'NFO' },
];

function leg(over: Partial<StrategyLeg> & Pick<StrategyLeg, 'id' | 'token' | 'strike' | 'type'>): StrategyLeg {
  return {
    tsym: `NIFTY${over.strike}${over.type}`, exch: 'NFO', expiryIso: '2026-11-10', lotSize: 75,
    side: 'B', lots: 1, priceType: 'LMT', price: 10, included: true, ...over,
  };
}

// The spec's worked example: S 22850 CE @ 69.90, S 22900 PE @ 68.85, B 23000 CE @ 14.95, 75 a lot.
// Net = (69.90 + 68.85 − 14.95) × 75 = 9,285.
const LEGS: StrategyLeg[] = [
  leg({ id: 'leg-1', token: 'NFO|1', strike: 22850, type: 'CE', side: 'S', price: 69.9 }),
  leg({ id: 'leg-2', token: 'NFO|2', strike: 22900, type: 'PE', side: 'S', price: 68.85 }),
  leg({ id: 'leg-3', token: 'NFO|3', strike: 23000, type: 'CE', side: 'B', price: 14.95 }),
];
const STRATEGY: Strategy = { legs: LEGS, lotMultiplier: 1, product: 'I' };
const LIVE = new Map([['NFO|1', 70.1], ['NFO|2', 68.85], ['NFO|3', 14.95]]);
const STRIKES = [22800, 22850, 22900, 22950, 23000];

describe('StrategyPanelComponent', () => {
  let f: ComponentFixture<StrategyPanelComponent>;
  const el = (): HTMLElement => f.nativeElement as HTMLElement;
  const set = (n: string, v: unknown): void => {
    f.componentRef.setInput(n, v);
    f.detectChanges();
  };
  const text = (e: Element | null): string => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const rows = (): HTMLTableRowElement[] => Array.from(el().querySelectorAll('tbody tr'));
  /** The row of a leg by id (rows are shown buys first, so not in the strategy's order). */
  const row = (id: string): HTMLTableRowElement => {
    const r = el().querySelector<HTMLTableRowElement>(`tbody tr[data-leg="${id}"]`);
    if (!r) throw new Error(`no row for ${id}`);
    return r;
  };
  const byLabel = <T extends HTMLElement>(root: ParentNode, label: string): T => {
    const hit = root.querySelector<T>(`[aria-label="${label}"]`);
    if (!hit) throw new Error(`no control labelled "${label}"`);
    return hit;
  };
  const button = (name: string): HTMLButtonElement => {
    const b = Array.from(el().querySelectorAll('button')).find((x) => text(x) === name || x.getAttribute('aria-label') === name);
    if (!b) throw new Error(`no button "${name}"`);
    return b;
  };
  const spy = <T>(out: { subscribe(fn: (v: T) => void): unknown }): ReturnType<typeof vi.fn> => {
    const fn = vi.fn();
    out.subscribe(fn);
    return fn;
  };
  const withStrategy = (s: Partial<Strategy>): void => set('strategy', { ...STRATEGY, ...s });
  const withLegs = (legs: StrategyLeg[]): void => withStrategy({ legs });

  beforeEach(() => {
    f = TestBed.createComponent(StrategyPanelComponent);
    f.componentRef.setInput('sym', 'NIFTY');
    f.componentRef.setInput('strategy', STRATEGY);
    f.componentRef.setInput('live', LIVE);
    f.componentRef.setInput('margin', { status: 'ready', margin: 118420, hedgeBenefit: 96310 } satisfies MarginState);
    f.componentRef.setInput('expiries', EXPIRIES);
    f.componentRef.setInput('pickerFor', () => ({ strikes: STRIKES, ready: true }));
    f.componentRef.setInput('marketOpen', true);
    f.componentRef.setInput('placing', false);
    f.detectChanges();
  });

  it('renders the header with the symbol and the leg count', () => {
    expect(text(el().querySelector('h2'))).toBe('Your strategy · NIFTY');
    expect(text(el().querySelector('.count'))).toBe('3 legs');
    withLegs([LEGS[0]!]);
    expect(text(el().querySelector('.count'))).toBe('1 leg');
  });

  it('renders one row per leg with side, expiry, strike, type, lots and price', () => {
    expect(rows()).toHaveLength(3);
    const r = row('leg-1')!;
    expect(text(r.querySelector('.bs'))).toBe('S');
    expect(r.querySelector('.bs')!.classList).toContain('s');
    expect(row('leg-3')!.querySelector('.bs')!.classList).toContain('b');
    const [exp, strike] = Array.from(r.querySelectorAll('select'));
    expect(exp!.value).toBe('2026-11-10');
    expect(text(exp!.selectedOptions[0]!)).toBe('10 Nov 2026');
    expect(Array.from(exp!.options).map((o) => o.value)).toEqual(['2026-11-10', '2026-11-17']);
    expect(strike!.value).toBe('22850');
    expect(Array.from(strike!.options).map((o) => Number(o.value))).toEqual(STRIKES);
    expect(text(r.querySelector('.type'))).toBe('CE');
    expect(r.querySelector('.type')!.classList).toContain('ce');
    expect(row('leg-2')!.querySelector('.type')!.classList).toContain('pe');
    expect(text(r.querySelector('.lots output'))).toBe('1');
    expect(r.querySelector<HTMLInputElement>('input.px')!.value).toBe('69.90');
    expect(text(r.querySelector('.live'))).toBe('Live 70.10');
  });

  it('B/S, lots ± and the include box emit edit', () => {
    const edit = spy(f.componentInstance.edit);
    const r = row('leg-3')!;
    (r.querySelector('.bs') as HTMLButtonElement).click();
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-3', edit: { side: 'S' } });
    byLabel<HTMLButtonElement>(r, 'More lots, 23000 CE 10 Nov 2026').click();
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-3', edit: { lots: 2 } });
    const box = r.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box.checked).toBe(true);
    box.click();
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-3', edit: { included: false } });
    const px = r.querySelector<HTMLInputElement>('input.px')!;
    px.value = '15.5';
    px.dispatchEvent(new Event('change'));
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-3', edit: { price: 15.5 } });
  });

  it('lots − at 1 stays disabled', () => {
    const edit = spy(f.componentInstance.edit);
    const less = byLabel<HTMLButtonElement>(row('leg-1')!, 'Fewer lots, 22850 CE 10 Nov 2026');
    expect(less.disabled).toBe(true);
    less.click();
    expect(edit).not.toHaveBeenCalled();
    withLegs([{ ...LEGS[0]!, lots: 3 }]);
    const less2 = byLabel<HTMLButtonElement>(row('leg-1')!, 'Fewer lots, 22850 CE 10 Nov 2026');
    expect(less2.disabled).toBe(false);
    less2.click();
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-1', edit: { lots: 2 } });
  });

  it('changing the strike or expiry select emits swap with the new values', () => {
    const swap = spy(f.componentInstance.swap);
    const [exp, strike] = Array.from(row('leg-2')!.querySelectorAll('select'));
    strike!.value = '22950';
    strike!.dispatchEvent(new Event('change'));
    expect(swap).toHaveBeenLastCalledWith({ id: 'leg-2', expiryIso: '2026-11-10', strike: 22950, type: 'PE' });
    exp!.value = '2026-11-17';
    exp!.dispatchEvent(new Event('change'));
    expect(swap).toHaveBeenLastCalledWith({ id: 'leg-2', expiryIso: '2026-11-17', strike: 22900, type: 'PE' });
    (row('leg-2')!.querySelector('.type') as HTMLButtonElement).click();
    expect(swap).toHaveBeenLastCalledWith({ id: 'leg-2', expiryIso: '2026-11-10', strike: 22900, type: 'CE' });
  });

  it('a select shows the leg, not the pick: a refused swap leaves the row as it was; an accepted one updates it', () => {
    const swap = spy(f.componentInstance.swap);
    const selects = () => Array.from(row('leg-2')!.querySelectorAll('select'));
    const [exp, strike] = selects();
    strike!.value = '22950';
    strike!.dispatchEvent(new Event('change'));
    exp!.value = '2026-11-17';
    exp!.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(swap).toHaveBeenCalledTimes(2);
    expect(strike!.value).toBe('22900'); // the page refused (leg unchanged)
    expect(exp!.value).toBe('2026-11-10');
    withLegs([LEGS[0]!, { ...LEGS[1]!, strike: 22950, expiryIso: '2026-11-17' }, LEGS[2]!]);
    expect(selects()[0]!.value).toBe('2026-11-17');
    expect(selects()[1]!.value).toBe('22950');
  });

  it('Execute all waits for a price while an included limit leg is at 0 ("Waiting for a price")', () => {
    withLegs([LEGS[0]!, { ...LEGS[1]!, price: 0 }]);
    expect(button('Execute all').disabled).toBe(true);
    expect(text(el().querySelector('.act'))).toContain('Waiting for a price');
    withLegs([LEGS[0]!, { ...LEGS[1]!, price: 0, priceType: 'MKT' }]); // a market order needs no price
    expect(button('Execute all').disabled).toBe(false);
    withLegs([LEGS[0]!, { ...LEGS[1]!, price: 0, included: false }]);
    expect(button('Execute all').disabled).toBe(false);
    expect(text(el().querySelector('.act'))).not.toContain('Waiting for a price');
  });

  it('disables the strike select while its options load', () => {
    set('pickerFor', () => ({ strikes: [], ready: false }));
    const strike = row('leg-1')!.querySelectorAll('select')[1]!;
    expect(strike.disabled).toBe(true);
    expect(strike.value).toBe('22850');
  });

  it('opens with buy legs on top, then sells (each group in the order added)', () => {
    expect(rows().map((r) => r.getAttribute('data-leg'))).toEqual(['leg-3', 'leg-1', 'leg-2']);
    expect(rows().map((r) => text(r.querySelector('.bs')))).toEqual(['B', 'S', 'S']);
  });

  it('a row never jumps while edited: flipping B ↔ S keeps it in place; a new leg re-sorts buys first', () => {
    const ids = (): (string | null)[] => rows().map((r) => r.getAttribute('data-leg'));
    // The buy on top becomes a sell: it stays where it is.
    withLegs([LEGS[0]!, LEGS[1]!, { ...LEGS[2]!, side: 'S' }]);
    expect(ids()).toEqual(['leg-3', 'leg-1', 'leg-2']);
    withLegs([{ ...LEGS[0]!, side: 'B' }, LEGS[1]!, { ...LEGS[2]!, side: 'S' }]);
    expect(ids()).toEqual(['leg-3', 'leg-1', 'leg-2']);
    // A leg added: buys first again.
    withLegs([{ ...LEGS[0]!, side: 'B' }, LEGS[1]!, { ...LEGS[2]!, side: 'S' }, leg({ id: 'leg-4', token: 'NFO|4', strike: 22800, type: 'PE' })]);
    expect(ids()).toEqual(['leg-1', 'leg-4', 'leg-2', 'leg-3']);
  });

  it('with buys and sells, a note says buys go first, and the confirm step lists them in sending order', () => {
    withLegs([LEGS[0]!, LEGS[1]!, { ...LEGS[2]!, side: 'S' }]); // all sells now (row stays put): no note
    expect(el().querySelector('[data-testid="order-note"]')).toBeNull();
    withLegs([LEGS[0]!, LEGS[1]!, LEGS[2]!]);
    expect(text(el().querySelector('[data-testid="order-note"]'))).toBe('Buy legs are placed first, for the margin benefit.');
    withLegs([{ ...LEGS[0]!, side: 'B' }, LEGS[1]!, { ...LEGS[2]!, side: 'S' }]); // rows: leg-3 (S) on top, leg-1 (B)
    expect(rows()[0]!.getAttribute('data-leg')).toBe('leg-3');
    button('Execute all').click();
    f.detectChanges();
    const items = Array.from(el().querySelectorAll('.confirm li')).map(text);
    expect(items[0]).toMatch(/^BUY 22850 CE/); // sent first, though shown below a sell
  });

  it('each leg has a Limit | Market switch; Market shows "At market" instead of a price; Market is off on BSE (BFO) legs', () => {
    const edit = spy(f.componentInstance.edit);
    const seg = byLabel<HTMLElement>(row('leg-1'), 'Order type, 22850 CE 10 Nov 2026');
    const [lim, mkt] = Array.from(seg.querySelectorAll('button'));
    expect([text(lim!), text(mkt!)]).toEqual(['Limit', 'Market']);
    expect(lim!.getAttribute('aria-pressed')).toBe('true'); // limit is the default
    expect(mkt!.getAttribute('aria-pressed')).toBe('false');
    lim!.click();
    expect(edit).not.toHaveBeenCalled(); // already limit
    mkt!.click();
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-1', edit: { priceType: 'MKT' } });

    withLegs([{ ...LEGS[0]!, priceType: 'MKT' }, { ...LEGS[1]!, exch: 'BFO', token: 'BFO|2' }]);
    const r1 = row('leg-1');
    expect(r1.querySelector('input.px')).toBeNull();
    expect(text(r1.querySelector('.atmkt'))).toBe('At market');
    byLabel<HTMLElement>(r1, 'Order type, 22850 CE 10 Nov 2026').querySelector<HTMLButtonElement>('button')!.click();
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-1', edit: { priceType: 'LMT' } });
    const bfoMkt = byLabel<HTMLElement>(row('leg-2'), 'Order type, 22900 PE 10 Nov 2026').querySelectorAll('button')[1]!;
    expect(bfoMkt.disabled).toBe(true);
    expect(bfoMkt.getAttribute('title')).toBe('Market orders are not available on BFO. Use a limit price.');
    expect(row('leg-2').querySelector('input.px')).not.toBeNull();
  });

  it('"All legs: Limit / Market" in the header shows the common type (none when mixed) and emits priceTypeAll', () => {
    const all = spy(f.componentInstance.priceTypeAll);
    const group = el().querySelector('.head .seg')!;
    const [lim, mkt] = Array.from(group.querySelectorAll('button'));
    expect(lim!.getAttribute('aria-pressed')).toBe('true');
    mkt!.click();
    expect(all).toHaveBeenLastCalledWith('MKT');
    withLegs([{ ...LEGS[0]!, priceType: 'MKT' }, LEGS[1]!]);
    const [l2, m2] = Array.from(el().querySelectorAll('.head .seg button'));
    expect(l2!.getAttribute('aria-pressed')).toBe('false');
    expect(m2!.getAttribute('aria-pressed')).toBe('false');
  });


  it('↻ resets prices, the delete buttons remove and clear all', () => {
    const reset = spy(f.componentInstance.resetPrices);
    const remove = spy(f.componentInstance.remove);
    const clear = spy(f.componentInstance.clearAll);
    button('Reset prices to live').click();
    expect(reset).toHaveBeenCalledTimes(1);
    button('Remove 22900 PE 10 Nov 2026').click();
    expect(remove).toHaveBeenLastCalledWith('leg-2');
    button('Clear all legs').click();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('summary shows "…" while loading, the figures when ready, "Margin unavailable" + Retry on error', () => {
    const vals = (): string[] => Array.from(el().querySelectorAll('.sum .v')).map(text);
    expect(text(el().querySelector('.sum'))).toContain('Margin needed');
    expect(text(el().querySelector('.sum'))).toContain('Hedge benefit');
    expect(text(el().querySelector('.sum'))).toContain('Net premium');
    expect(vals().slice(0, 2)).toEqual(['₹ 1,18,420', '₹ 96,310']);

    set('margin', { status: 'loading' });
    expect(vals().slice(0, 2)).toEqual(['…', '…']);

    set('margin', { status: 'error' });
    expect(text(el().querySelector('.sum'))).toContain('Margin unavailable');
    const retry = spy(f.componentInstance.retryMargin);
    button('Retry').click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('net premium shows + ₹ 8,047 in green', () => {
    // (70.10 + 68.85 − 31.66) × 75 = 8,046.75 → ₹ 8,047; leg 1 at MKT uses its live 70.10.
    withLegs([{ ...LEGS[0]!, priceType: 'MKT' }, LEGS[1]!, { ...LEGS[2]!, price: 31.66 }]);
    const net = el().querySelector('.sum .net')!;
    expect(text(net)).toBe('+ ₹ 8,047');
    expect(net.classList).toContain('pos');
    withLegs([{ ...LEGS[2]!, price: 14.95 }]); // buying only: pays 1,121.25
    expect(text(el().querySelector('.sum .net'))).toBe('− ₹ 1,121');
    expect(el().querySelector('.sum .net')!.classList).toContain('neg');
  });

  it('the action row emits Lot ×, product and Save to basket', () => {
    const mult = spy(f.componentInstance.lotMultiplier);
    const prod = spy(f.componentInstance.product);
    const save = spy(f.componentInstance.saveToBasket);
    expect(button('Fewer lot multiples').disabled).toBe(true);
    button('More lot multiples').click();
    expect(mult).toHaveBeenLastCalledWith(2);
    expect(button('Intraday').getAttribute('aria-pressed')).toBe('true');
    expect(button('Normal').getAttribute('aria-pressed')).toBe('false');
    button('Normal').click();
    expect(prod).toHaveBeenLastCalledWith('M');
    button('Save to basket').click();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('Execute all opens the confirm step: buys first, BUY / SELL, qty and a LIMIT ₹price or MARKET badge; "Place 3 orders"', () => {
    withStrategy({
      lotMultiplier: 2,
      legs: [{ ...LEGS[0]!, priceType: 'MKT' }, LEGS[1]!, LEGS[2]!, leg({ id: 'leg-4', token: 'NFO|4', strike: 22800, type: 'PE', included: false })],
    });
    button('Execute all').click();
    f.detectChanges();
    expect(el().querySelector('table')).toBeNull();
    const items = Array.from(el().querySelectorAll('.confirm li')).map(text);
    expect(items).toEqual([
      'BUY 23000 CE 10 Nov 2026 · Qty 150 LIMIT ₹14.95',
      'SELL 22850 CE 10 Nov 2026 · Qty 150 MARKET',
      'SELL 22900 PE 10 Nov 2026 · Qty 150 LIMIT ₹68.85',
    ]);
    expect(el().querySelector('.confirm li .otb.mk')).not.toBeNull();
    expect(text(el().querySelector('.confirm'))).toContain('₹ 1,18,420');
    expect(text(el().querySelector('.confirm'))).toContain('Intraday');
    expect(button('Place 3 orders')).toBeTruthy();
  });

  it('Back returns', () => {
    button('Execute all').click();
    f.detectChanges();
    button('Back').click();
    f.detectChanges();
    expect(rows()).toHaveLength(3);
    expect(el().querySelector('.confirm')).toBeNull();
  });

  it('Place emits execute once and the button disables while placing', () => {
    const execute = spy(f.componentInstance.execute);
    button('Execute all').click();
    f.detectChanges();
    expect(execute).not.toHaveBeenCalled();
    const place = button('Place 3 orders');
    place.click();
    place.click();
    expect(execute).toHaveBeenCalledTimes(1);
    set('placing', true);
    expect(button('Place 3 orders').disabled).toBe(true);
  });

  it('Execute all is disabled with "Market closed" when marketOpen is false', () => {
    set('marketOpen', false);
    expect(button('Execute all').disabled).toBe(true);
    expect(text(el().querySelector('.act'))).toContain('Market closed');
    set('marketOpen', true);
    expect(button('Execute all').disabled).toBe(false);
    expect(text(el().querySelector('.act'))).not.toContain('Market closed');
  });

  it('a placed leg with no order number says so (never "#undefined")', () => {
    withLegs([{ ...LEGS[2]!, included: false, result: { status: 'placed', orderNo: '' } }]);
    expect(text(el().querySelector('.results li'))).toBe('Placed B 23000 CE 10 Nov 2026 · order no. unavailable');
    button('Back').click();
    f.detectChanges();
    expect(text(rows()[0]!)).toContain('Placed (order no. unavailable)');
  });

  it('after a run, each row shows its result; the confirm list shows it for legs sent again', () => {
    withLegs([
      { ...LEGS[2]!, included: false, result: { status: 'placed', orderNo: '26110900123' } },
      { ...LEGS[0]!, result: { status: 'rejected', reason: 'RMS: insufficient margin' } },
      { ...LEGS[1]!, result: { status: 'not-sent' } },
    ]);
    button('Back').click();
    f.detectChanges();
    expect(text(rows()[0]!)).toContain('Placed #26110900123');
    expect(text(rows()[1]!)).toContain('Rejected: RMS: insufficient margin');
    expect(text(rows()[2]!)).toContain('Not sent');
    button('Execute all').click();
    f.detectChanges();
    const items = Array.from(el().querySelectorAll('.confirm li')).map(text);
    expect(items).toHaveLength(2); // the placed leg is not included
    expect(items[0]).toContain('Rejected: RMS: insufficient margin');
    expect(text(button('Place 2 orders'))).toBe('Place 2 orders');
  });

  it('a typed limit price is rounded to the tick size (12.33 → 12.35)', () => {
    const edit = spy(f.componentInstance.edit);
    const input = byLabel<HTMLInputElement>(row('leg-1')!, 'Limit price, 22850 CE 10 Nov 2026');
    input.value = '12.33';
    input.dispatchEvent(new Event('change'));
    expect(edit).toHaveBeenLastCalledWith({ id: 'leg-1', edit: { price: 12.35 } });
    expect(input.value).toBe('12.35');
  });

  it('a BFO market leg blocks Execute all with the reason', () => {
    withLegs([{ ...LEGS[0]!, exch: 'BFO', priceType: 'MKT' }]);
    expect(button('Execute all').disabled).toBe(true);
    expect(text(el().querySelector('.act'))).toContain('Market orders are not available on BFO');
  });

  it('the lots cell shows the quantity on hover (lots × Lot× × lot size)', () => {
    const lots = () => row('leg-1')!.querySelector<HTMLElement>('.lots')!;
    expect(lots().title).toBe('1 lot × 75 = 75');
    withStrategy({ legs: [{ ...LEGS[0]!, lots: 2 }], lotMultiplier: 3 });
    expect(lots().title).toBe('6 lots × 75 = 450');
  });

  it('results view shows Placed with the order number, Rejected with the reason, Not sent', () => {
    withLegs([
      { ...LEGS[2]!, result: { status: 'placed', orderNo: '26110900123' } },
      { ...LEGS[0]!, result: { status: 'rejected', reason: 'RMS: insufficient margin' } },
      { ...LEGS[1]!, result: { status: 'not-sent' } },
    ]);
    const items = Array.from(el().querySelectorAll('.results li')).map(text);
    expect(items).toEqual([
      'Placed B 23000 CE 10 Nov 2026 · #26110900123',
      'Rejected S 22850 CE 10 Nov 2026 · RMS: insufficient margin',
      'Not sent S 22900 PE 10 Nov 2026',
    ]);
    expect(el().querySelector('table')).toBeNull();
    button('Back').click();
    f.detectChanges();
    expect(rows()).toHaveLength(3);
  });

  it('an edit returns to the edit view', () => {
    const placed = { ...LEGS[2]!, result: { status: 'placed', orderNo: '1' } as const };
    withLegs([placed, LEGS[0]!]);
    expect(el().querySelector('.results')).not.toBeNull();
    button('Back').click();
    f.detectChanges();
    // The store clears the edited leg's result; the other leg keeps its old result: still the edit view.
    withLegs([placed, { ...LEGS[0]!, lots: 2 }]);
    expect(el().querySelector('.results')).toBeNull();
    // A fresh result (a new run) shows the results again.
    withLegs([placed, { ...LEGS[0]!, result: { status: 'placed', orderNo: '2' } }]);
    expect(el().querySelector('.results')).not.toBeNull();
  });

  it('Place is off and does nothing when the market closes while confirming', () => {
    const execute = spy(f.componentInstance.execute);
    button('Execute all').click();
    f.detectChanges();
    set('marketOpen', false);
    const place = button('Place 3 orders');
    expect(place.disabled).toBe(true);
    place.click();
    expect(execute).not.toHaveBeenCalled();
    expect(text(el().querySelector('.confirm'))).toContain('Market closed');
  });

  it('Place is off and does nothing when no leg is included while confirming', () => {
    const execute = spy(f.componentInstance.execute);
    button('Execute all').click();
    f.detectChanges();
    withLegs(LEGS.map((l) => ({ ...l, included: false })));
    const place = button('Place 0 orders');
    expect(place.disabled).toBe(true);
    place.click();
    expect(execute).not.toHaveBeenCalled();
  });

  it('while placing, Back is off and no edit can be emitted', () => {
    const outs = f.componentInstance;
    const spies = [outs.edit, outs.swap, outs.remove, outs.clearAll, outs.lotMultiplier, outs.product, outs.resetPrices]
      .map((o) => spy(o as { subscribe(fn: (v: unknown) => void): unknown }));
    button('Execute all').click();
    f.detectChanges();
    button('Place 3 orders').click();
    f.detectChanges();
    // Place requested, `placing` not yet arrived: still locked.
    expect(button('Back').disabled).toBe(true);
    set('placing', true);
    const back = button('Back');
    expect(back.disabled).toBe(true);
    back.click();
    f.detectChanges();
    expect(el().querySelector('.confirm')).not.toBeNull();

    // Even if the page shows the legs while placing, every edit control is off and inert.
    (f.componentInstance as unknown as { view: { set(v: string): void } }).view.set('edit');
    f.detectChanges();
    expect(rows()).toHaveLength(3);
    for (const c of Array.from(el().querySelectorAll<HTMLElement>('.pop button, .pop input, .pop select'))) {
      if (c.getAttribute('aria-label') === 'Collapse strategy') continue;
      expect(c.matches(':disabled'), c.outerHTML).toBe(true);
      c.click();
      c.dispatchEvent(new Event('change'));
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('results unlock Back once placing ends', () => {
    button('Execute all').click();
    f.detectChanges();
    button('Place 3 orders').click();
    set('placing', true);
    withLegs(LEGS.map((l) => ({ ...l, result: { status: 'placed', orderNo: l.id } as const })));
    expect(el().querySelector('.results')).not.toBeNull();
    expect(button('Back').disabled).toBe(true);
    set('placing', false);
    expect(button('Back').disabled).toBe(false);
  });

  it('moves focus into the new view on each switch', async () => {
    const focused = (): Element | null => document.activeElement;
    const exec = button('Execute all');
    exec.focus();
    exec.click();
    f.detectChanges();
    await f.whenStable();
    expect(focused()).toBe(button('Place 3 orders'));
    button('Back').click();
    f.detectChanges();
    await f.whenStable();
    expect(focused()).toBe(button('Execute all'));
    withLegs([{ ...LEGS[0]!, result: { status: 'placed', orderNo: '9' } }]);
    await f.whenStable();
    expect(focused()).toBe(el().querySelector('.results ul'));
    // Esc still reaches the panel from the moved focus.
    const collapse = spy(f.componentInstance.collapse);
    focused()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(collapse).toHaveBeenCalledTimes(1);
  });

  it('Esc emits collapse, as does the chevron', () => {
    const collapse = spy(f.componentInstance.collapse);
    el().querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(collapse).toHaveBeenCalledTimes(1);
    button('Collapse strategy').click();
    expect(collapse).toHaveBeenCalledTimes(2);
  });

  it('every control is a button/input/select with an accessible name', () => {
    const check = (): void => {
      const controls = Array.from(el().querySelectorAll<HTMLElement>('button, input, select'));
      expect(controls.length).toBeGreaterThan(0);
      for (const c of controls) {
        const name = c.getAttribute('aria-label') ?? text(c);
        expect(name, c.outerHTML).not.toBe('');
      }
      // Nothing clickable that isn't a native control.
      expect(el().querySelectorAll('[role=button], [onclick], a:not([href])')).toHaveLength(0);
    };
    check();
    set('margin', { status: 'error' });
    check();
    button('Execute all').click();
    f.detectChanges();
    check();
  });
});
