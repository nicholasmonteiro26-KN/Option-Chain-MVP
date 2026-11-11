import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FooterActionsComponent } from './footer-actions.component';

describe('FooterActionsComponent', () => {
  let f: ComponentFixture<FooterActionsComponent>;
  const el = (): HTMLElement => f.nativeElement as HTMLElement;
  const set = (n: string, v: unknown): void => f.componentRef.setInput(n, v);
  beforeEach(() => {
    f = TestBed.createComponent(FooterActionsComponent);
    set('checkedCount', 3);
    f.detectChanges();
  });

  it('labels buttons with the count and emits', () => {
    const [w, b] = Array.from(el().querySelectorAll<HTMLButtonElement>('button:not(.strategy)'));
    expect(w!.textContent!.replace(/\s+/g, ' ').trim()).toBe('Add to Watchlist 3');
    expect(b!.textContent!.replace(/\s+/g, ' ').trim()).toBe('Add to Basket 3');
    expect(w!.querySelector('.badge')!.textContent!.trim()).toBe('3');
    expect(w!.querySelector('svg')).not.toBeNull();
    expect(b!.querySelector('svg')).not.toBeNull();
    const sw = vi.fn();
    const sb = vi.fn();
    f.componentInstance.addToWatchlist.subscribe(sw);
    f.componentInstance.addToBasket.subscribe(sb);
    w!.click();
    b!.click();
    expect(sw).toHaveBeenCalledTimes(1);
    expect(sb).toHaveBeenCalledTimes(1);
  });

  it('is off until a contract is ticked (as on TradeSmart)', () => {
    set('checkedCount', 0);
    f.detectChanges();
    const btns = Array.from(el().querySelectorAll('button'));
    expect(btns.every((x) => x.disabled)).toBe(true);
    set('checkedCount', 1);
    f.detectChanges();
    expect(btns.every((x) => !x.disabled)).toBe(true);
  });

  it('shows only the three buttons (no Fwd / ATM / expiry summary)', () => {
    expect(el().querySelectorAll('.foot > *')).toHaveLength(3);
  });

  it('Build your strategy shows the leg count, reports whether the pop-up is open, and emits', () => {
    const b = el().querySelector<HTMLButtonElement>('button.strategy')!;
    expect(b.textContent!.replace(/\s+/g, ' ').trim()).toBe('Build your strategy 3');
    expect(b.querySelector('.badge')!.textContent!.trim()).toBe('3');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    set('strategyOpen', true);
    f.detectChanges();
    expect(b.getAttribute('aria-expanded')).toBe('true');
    const spy = vi.fn();
    f.componentInstance.buildStrategy.subscribe(spy);
    b.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('Build your strategy is off with no legs', () => {
    set('checkedCount', 0);
    f.detectChanges();
    expect(el().querySelector<HTMLButtonElement>('button.strategy')!.disabled).toBe(true);
  });
});
