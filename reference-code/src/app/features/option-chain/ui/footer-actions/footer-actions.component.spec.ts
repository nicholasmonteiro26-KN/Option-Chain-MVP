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
    set('fwd', 24987.65);
    set('atm', 25000);
    set('expiryLabel', '03 Nov 2026');
    f.detectChanges();
  });

  it('labels buttons with the count and emits', () => {
    const [w, b] = Array.from(el().querySelectorAll('button'));
    expect(w!.textContent!.trim()).toBe('Add to Watchlist (3)');
    expect(b!.textContent!.trim()).toBe('Add to Basket (3)');
    const sw = vi.fn();
    const sb = vi.fn();
    f.componentInstance.addToWatchlist.subscribe(sw);
    f.componentInstance.addToBasket.subscribe(sb);
    w!.click();
    b!.click();
    expect(sw).toHaveBeenCalledTimes(1);
    expect(sb).toHaveBeenCalledTimes(1);
  });

  it('shows the right-aligned summary', () => {
    expect(el().querySelector('.sp')!.textContent!.trim()).toBe('Fwd 24987.7 · ATM 25000 · 03 Nov 2026');
  });

  it('hides null parts', () => {
    set('fwd', null);
    set('expiryLabel', null);
    f.detectChanges();
    expect(el().querySelector('.sp')!.textContent!.trim()).toBe('ATM 25000');
    set('atm', null);
    f.detectChanges();
    expect(el().querySelector('.sp')).toBeNull();
  });
});
