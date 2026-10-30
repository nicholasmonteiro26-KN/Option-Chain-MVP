import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUICK_UNDERLYINGS, Underlying } from '../../data-access/models';
import { UnderlyingBarComponent } from './underlying-bar.component';

const RELIANCE: Underlying = { sym: 'RELIANCE', exch: 'NSE', foExch: 'NFO', token: '2885', name: 'Reliance Industries', isIndex: false };
const RELCAP: Underlying = { sym: 'RELCAPITAL', exch: 'NSE', foExch: 'NFO', token: '1', name: 'Reliance Capital', isIndex: false };

describe('UnderlyingBarComponent', () => {
  let f: ComponentFixture<UnderlyingBarComponent>;
  const el = (): HTMLElement => f.nativeElement as HTMLElement;
  const input = (): HTMLInputElement => el().querySelector('input')!;
  const type = (v: string): void => {
    input().value = v;
    input().dispatchEvent(new Event('input'));
    f.detectChanges();
  };
  const key = (k: string): void => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    f.detectChanges();
  };
  const set = (name: string, v: unknown): void => f.componentRef.setInput(name, v);
  const settle = (): void => {
    vi.advanceTimersByTime(250);
    f.detectChanges();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    f = TestBed.createComponent(UnderlyingBarComponent);
    set('quick', QUICK_UNDERLYINGS);
    set('selected', QUICK_UNDERLYINGS[0]);
    set('quickPrices', { NIFTY: { ltp: 24950.5, chgPct: 0.45 }, SENSEX: { ltp: 81000, chgPct: -0.2 } });
    set('ohlc', { open: 24900, high: 25010.5, low: 24880, prevClose: 24840.25 });
    set('lotSize', 20);
    set('searchResults', []);
    set('resultsFor', 'rel');
    f.detectChanges();
  });
  afterEach(() => vi.useRealTimers());

  it('renders exactly two quick buttons, NIFTY and SENSEX, with the selected one pressed', () => {
    const btns = el().querySelectorAll('.qbtn');
    expect(btns.length).toBe(2);
    expect(btns[0]!.textContent).toContain('NIFTY');
    expect(btns[1]!.textContent).toContain('SENSEX');
    expect(btns[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(btns[1]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows LTP and signed change coloured by sign', () => {
    const btns = el().querySelectorAll('.qbtn');
    expect(btns[0]!.textContent).toContain('24,950.50');
    expect(btns[0]!.textContent).toContain('+0.45%');
    expect(btns[0]!.querySelector('.pos')).not.toBeNull();
    expect(btns[1]!.textContent).toContain('-0.20%');
    expect(btns[1]!.querySelector('.neg')).not.toBeNull();
  });

  it('emits select when a quick button is clicked', () => {
    const spy = vi.fn();
    f.componentInstance.select.subscribe(spy);
    (el().querySelectorAll('.qbtn')[1] as HTMLElement).click();
    expect(spy).toHaveBeenCalledWith(QUICK_UNDERLYINGS[1]);
  });

  it('has a labelled combobox search input', () => {
    expect(input().type).toBe('search');
    expect(input().getAttribute('role')).toBe('combobox');
    expect(input().placeholder).toBe('Search index or stock, e.g. RELIANCE');
    expect(el().querySelector('label')!.textContent).toContain('Search index or stock');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().getAttribute('aria-controls')).toBeTruthy();
  });

  it('emits search("rel") once, debounced 250 ms', () => {
    const spy = vi.fn();
    f.componentInstance.search.subscribe(spy);
    type('r');
    vi.advanceTimersByTime(100);
    type('re');
    vi.advanceTimersByTime(100);
    type('rel');
    vi.advanceTimersByTime(249);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('rel');
  });

  it('emits nothing for empty text and closes the list', () => {
    const spy = vi.fn();
    f.componentInstance.search.subscribe(spy);
    set('searchResults', [RELIANCE]);
    type('rel');
    settle();
    expect(el().querySelector('[role="listbox"]')).not.toBeNull();
    spy.mockClear();
    type('');
    vi.advanceTimersByTime(500);
    f.detectChanges();
    expect(spy).not.toHaveBeenCalled();
    expect(el().querySelector('[role="listbox"]')).toBeNull();
  });

  it('lists results with sym, name and Index/Stock · foExch', () => {
    set('searchResults', [RELIANCE, QUICK_UNDERLYINGS[0]]);
    type('rel');
    settle();
    const opts = el().querySelectorAll('[role="option"]');
    expect(opts.length).toBe(2);
    expect(opts[0]!.textContent).toContain('RELIANCE');
    expect(opts[0]!.textContent).toContain('Reliance Industries');
    expect(opts[0]!.textContent).toContain('Stock · NFO');
    expect(opts[1]!.textContent).toContain('Index · NFO');
    expect(input().getAttribute('aria-expanded')).toBe('true');
  });

  it('Enter selects the first result and clears the input', () => {
    const spy = vi.fn();
    f.componentInstance.select.subscribe(spy);
    set('searchResults', [RELIANCE, RELCAP]);
    type('rel');
    settle();
    key('Enter');
    expect(spy).toHaveBeenCalledWith(RELIANCE);
    expect(input().value).toBe('');
    expect(el().querySelector('[role="listbox"]')).toBeNull();
  });

  it('ArrowDown then Enter selects the second result and moves aria-selected', () => {
    const spy = vi.fn();
    f.componentInstance.select.subscribe(spy);
    set('searchResults', [RELIANCE, RELCAP]);
    type('rel');
    settle();
    key('ArrowDown');
    const opts = el().querySelectorAll('[role="option"]');
    expect(opts[0]!.getAttribute('aria-selected')).toBe('false');
    expect(opts[1]!.getAttribute('aria-selected')).toBe('true');
    expect(input().getAttribute('aria-activedescendant')).toBe(opts[1]!.id);
    key('Enter');
    expect(spy).toHaveBeenCalledWith(RELCAP);
  });

  it('ArrowUp does not go above the first result', () => {
    set('searchResults', [RELIANCE, RELCAP]);
    type('rel');
    settle();
    key('ArrowDown');
    key('ArrowUp');
    key('ArrowUp');
    expect(el().querySelectorAll('[role="option"]')[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('Escape closes the list', () => {
    set('searchResults', [RELIANCE]);
    type('rel');
    settle();
    key('Escape');
    expect(el().querySelector('[role="listbox"]')).toBeNull();
  });

  it('mousedown on a result selects it', () => {
    const spy = vi.fn();
    f.componentInstance.select.subscribe(spy);
    set('searchResults', [RELIANCE, RELCAP]);
    type('rel');
    settle();
    el().querySelectorAll('[role="option"]')[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(spy).toHaveBeenCalledWith(RELCAP);
  });

  it('shows the no-match message only once results for the current text have arrived', () => {
    type('zzz');
    expect(el().textContent).not.toContain('No index or stock');
    settle();
    // debounce fired but the parent has not echoed resultsFor yet: still loading
    expect(el().textContent).not.toContain('No index or stock');
    set('resultsFor', 'zzz');
    f.detectChanges();
    expect(el().textContent).toContain('No index or stock with options matches "zzz"');
  });

  it('shows neither rows nor message while results belong to an older query', () => {
    set('searchResults', [RELIANCE]);
    set('resultsFor', 'rel');
    type('rel');
    settle();
    expect(el().querySelectorAll('[role="option"]').length).toBe(1);
    type('relx');
    settle();
    expect(el().querySelectorAll('[role="option"]').length).toBe(0);
    expect(el().textContent).not.toContain('No index or stock');
  });

  it('Enter cannot pick stale results from an older query', () => {
    const spy = vi.fn();
    f.componentInstance.select.subscribe(spy);
    set('searchResults', [RELIANCE]);
    set('resultsFor', 'rel');
    type('rel');
    settle();
    type('relx');
    settle();
    key('Enter');
    expect(spy).not.toHaveBeenCalled();
  });

  it('Escape calls preventDefault', () => {
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('reads the OHLC line with lot', () => {
    const t = el().querySelector('.ohlc')!.textContent!.replace(/\s+/g, ' ').trim();
    expect(t).toBe('O 24,900.00 H 25,010.50 L 24,880.00 Prev close 24,840.25 Lot 20 (this expiry)');
  });

  it('omits Lot when lotSize is null and shows dashes for null values', () => {
    set('lotSize', null);
    set('ohlc', { open: null, high: null, low: null, prevClose: null });
    f.detectChanges();
    const t = el().querySelector('.ohlc')!.textContent!.replace(/\s+/g, ' ').trim();
    expect(t).toBe('O – H – L – Prev close –');
  });

  it('shows LTP and change vs previous close after the exchange tag, en-IN, coloured by sign', () => {
    expect(el().querySelector('[data-testid="underlying-ltp"]')).toBeNull(); // no LTP yet
    set('ohlc', { open: null, high: null, low: null, prevClose: 22706.85 });
    set('ltp', 22873.4);
    f.detectChanges();
    const bar = el().querySelector('.und-bar')!;
    expect(bar.querySelector('[data-testid="underlying-ltp"]')!.textContent!.trim()).toBe('22,873.40');
    const chg = bar.querySelector('.chg')!;
    expect(chg.textContent!.trim()).toBe('+166.55 (+0.73%)');
    expect(chg.classList).toContain('pos');
    expect(bar.querySelector('.exch')!.nextElementSibling!.getAttribute('data-testid')).toBe('underlying-ltp');
    set('ltp', 22600);
    f.detectChanges();
    expect(bar.querySelector('.chg')!.textContent!.trim()).toBe('-106.85 (-0.47%)');
    expect(bar.querySelector('.chg')!.classList).toContain('neg');
  });
});
