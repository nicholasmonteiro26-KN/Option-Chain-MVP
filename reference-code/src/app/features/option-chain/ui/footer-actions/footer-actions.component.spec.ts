import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FOOTER_HINT, FooterActionsComponent } from './footer-actions.component';

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

  it('is off until a contract is ticked: no "not allowed" cursor, a hint to select strikes instead, and clicks do nothing', () => {
    set('checkedCount', 0);
    f.detectChanges();
    const btns = Array.from(el().querySelectorAll<HTMLButtonElement>('button'));
    expect(btns).toHaveLength(3);
    const hint = el().querySelector('.sr')!;
    expect(hint.textContent!.trim()).toBe(FOOTER_HINT);
    expect(FOOTER_HINT).toBe('Select strikes using the checkboxes first');
    for (const b of btns) {
      expect(b.disabled).toBe(false); // focusable and hoverable, so the hint can show
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.getAttribute('data-hint')).toBe(FOOTER_HINT);
      expect(b.getAttribute('aria-describedby')).toBe(hint.id);
      expect(getComputedStyle(b).cursor).not.toBe('not-allowed');
    }
    const spies = [vi.fn(), vi.fn(), vi.fn()];
    f.componentInstance.addToWatchlist.subscribe(spies[0]!);
    f.componentInstance.addToBasket.subscribe(spies[1]!);
    f.componentInstance.buildStrategy.subscribe(spies[2]!);
    btns.forEach((b) => b.click());
    spies.forEach((sp) => expect(sp).not.toHaveBeenCalled());

    set('checkedCount', 1);
    f.detectChanges();
    for (const b of btns) {
      expect(b.getAttribute('aria-disabled')).toBe('false');
      expect(b.hasAttribute('data-hint')).toBe(false);
      expect(b.hasAttribute('aria-describedby')).toBe(false);
    }
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
    expect(el().querySelector<HTMLButtonElement>('button.strategy')!.getAttribute('aria-disabled')).toBe('true');
  });
});
