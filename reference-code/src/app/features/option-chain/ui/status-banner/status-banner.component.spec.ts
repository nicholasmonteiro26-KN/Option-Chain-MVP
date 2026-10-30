import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StatusBannerComponent } from './status-banner.component';

describe('StatusBannerComponent', () => {
  let f: ComponentFixture<StatusBannerComponent>;
  const el = (): HTMLElement => f.nativeElement as HTMLElement;
  const show = (kind: string | null): void => {
    f.componentRef.setInput('kind', kind);
    f.componentRef.setInput('sym', 'NIFTY');
    f.detectChanges();
  };
  beforeEach(() => {
    f = TestBed.createComponent(StatusBannerComponent);
  });

  it.each([
    ['reconnecting', 'Reconnecting to live prices… Showing the last values received.', 'status'],
    ['closed', 'Market closed · Showing prices as of 15:30.', 'status'],
    ['error', 'Could not load the option chain for NIFTY. Check your connection and try again.', 'alert'],
    ['analytics-unavailable', 'Analytics unavailable. Prices are still live.', 'status'],
  ])('%s copy and role', (kind, copy, role) => {
    show(kind);
    const b = el().querySelector('.banner')!;
    expect(b.textContent).toContain(copy);
    expect(b.getAttribute('role')).toBe(role);
  });

  it('renders nothing for null', () => {
    show(null);
    expect(el().querySelector('.banner')).toBeNull();
  });

  it('only error has Retry, which emits retry', () => {
    show('closed');
    expect(el().querySelector('button')).toBeNull();
    show('error');
    const spy = vi.fn();
    f.componentInstance.retry.subscribe(spy);
    const btn = el().querySelector('button')!;
    expect(btn.textContent!.trim()).toBe('Retry');
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
