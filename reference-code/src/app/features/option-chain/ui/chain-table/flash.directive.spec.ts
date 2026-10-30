import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLASH_MAX_MS, FLASH_MS, FlashDirective } from './flash.directive';

@Component({
  imports: [FlashDirective],
  template: `<span [ocFlash]="value()">x</span><i>{{ other() }}</i>`,
})
class HostComponent {
  readonly value = signal<number | null>(10);
  /** Changed by `render()`: an application render that does not touch the flash input. */
  readonly other = signal(0);
}

function setup(reduced = false) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), media: q }));
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  const span = (fixture.nativeElement as HTMLElement).querySelector('span')!;
  const set = async (v: number | null): Promise<void> => {
    fixture.componentInstance.value.set(v);
    fixture.detectChanges();
    await fixture.whenStable();
  };
  /** An unrelated application render (e.g. a tick flush updating other cells). */
  const render = (): void => {
    fixture.componentInstance.other.update((n) => n + 1);
    TestBed.tick();
  };
  return { span, set, render };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('FlashDirective', () => {
  it('does not flash on the first value', () => {
    const { span } = setup();
    expect(span.className).toBe('');
  });

  it('adds flash-up on an increase and flash-dn on a decrease', async () => {
    const { span, set } = setup();
    await set(11);
    expect(span.classList.contains('flash-up')).toBe(true);
    await set(9);
    expect(span.classList.contains('flash-dn')).toBe(true);
    expect(span.classList.contains('flash-up')).toBe(false);
  });

  it('adds nothing when the value is unchanged or null', async () => {
    const { span, set } = setup();
    await set(10);
    await set(null);
    expect(span.className).toBe('');
  });

  it('removes the class on animationend', async () => {
    const { span, set } = setup();
    await set(11);
    span.dispatchEvent(new Event('animationend'));
    expect(span.classList.contains('flash-up')).toBe(false);
  });

  it('holds the tint for 400 ms and removes it on the first render after that', async () => {
    expect(FLASH_MS).toBe(400);
    vi.useFakeTimers();
    const { span, set, render } = setup();
    await set(11);
    vi.advanceTimersByTime(399);
    render(); // a render before 400 ms keeps it
    expect(span.classList.contains('flash-up')).toBe(true);
    vi.advanceTimersByTime(1);
    render();
    expect(span.classList.contains('flash-up')).toBe(false);
  });

  it('with no render, a fallback timer removes the tint after FLASH_MAX_MS', async () => {
    vi.useFakeTimers();
    const { span, set } = setup();
    await set(11);
    vi.advanceTimersByTime(FLASH_MAX_MS - 1);
    expect(span.classList.contains('flash-up')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(span.classList.contains('flash-up')).toBe(false);
  });

  it('a tick during a flash swaps the class and restarts the timer, without a forced reflow', async () => {
    vi.useFakeTimers();
    const { span, set, render } = setup();
    const reads = vi.fn();
    Object.defineProperty(span, 'offsetWidth', { get: () => { reads(); return 0; } });
    await set(11);
    vi.advanceTimersByTime(300);
    await set(12);
    vi.advanceTimersByTime(300); // 600 ms after the first flash, 300 ms after the second
    render();
    expect(span.classList.contains('flash-up')).toBe(true);
    await set(11);
    expect(span.classList.contains('flash-dn')).toBe(true);
    expect(span.classList.contains('flash-up')).toBe(false);
    vi.advanceTimersByTime(400);
    render();
    expect(span.className).toBe('');
    expect(reads).not.toHaveBeenCalled();
  });

  it('checks prefers-reduced-motion once per cell, not on every flash', async () => {
    const mm = vi.fn((q: string) => ({ matches: false, media: q }));
    vi.stubGlobal('matchMedia', mm);
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    for (const v of [11, 12, 13]) {
      fixture.componentInstance.value.set(v);
      fixture.detectChanges();
      await fixture.whenStable();
    }
    expect(mm).toHaveBeenCalledTimes(1);
  });

  it('does nothing under prefers-reduced-motion', async () => {
    const { span, set } = setup(true);
    await set(11);
    expect(span.className).toBe('');
  });
});
