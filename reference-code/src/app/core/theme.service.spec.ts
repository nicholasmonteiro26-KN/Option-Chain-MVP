import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_URL_PARAM, ThemeService } from './theme.service';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r));

describe('ThemeService', () => {
  const body = (): string | null => document.body.getAttribute('color-theme');

  function make(opts: { url?: string | null; bodyAttr?: string } = {}): ThemeService {
    if (opts.bodyAttr) document.body.setAttribute('color-theme', opts.bodyAttr);
    TestBed.configureTestingModule({ providers: [{ provide: THEME_URL_PARAM, useValue: opts.url ?? null }] });
    return TestBed.inject(ThemeService);
  }

  beforeEach(() => {
    document.body.removeAttribute('color-theme');
    document.documentElement.removeAttribute('data-ts-theme-boot');
  });
  afterEach(() => {
    document.body.removeAttribute('color-theme');
    document.documentElement.style.colorScheme = '';
  });

  it('has no way to change the theme from the page (no set / toggle)', () => {
    const svc = make() as unknown as Record<string, unknown>;
    expect(svc['set']).toBeUndefined();
    expect(svc['toggle']).toBeUndefined();
  });

  // The computer's dark-mode setting is never read (e2e "light by default, even when the computer is in dark mode").
  it('is light by default', () => {
    const svc = make();
    expect(svc.theme()).toBe('light');
    expect(body()).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(svc.hostControlled).toBe(false);
  });

  it('?theme=dark (the platform theme TradeSmart passes) opens dark', () => {
    const svc = make({ url: 'dark' });
    expect(svc.theme()).toBe('dark');
    expect(body()).toBe('dark');
  });

  it('ignores an invalid ?theme= (light)', () => {
    expect(make({ url: 'blue' }).theme()).toBe('light');
  });

  it('adopts a theme the host set, never overwrites it, and follows its changes', async () => {
    const svc = make({ bodyAttr: 'dark', url: 'light' });
    expect(svc.hostControlled).toBe(true);
    expect(svc.theme()).toBe('dark');
    expect(body()).toBe('dark');

    document.body.setAttribute('color-theme', 'light'); // the host switches
    await tick();
    expect(svc.theme()).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('switches to host control when the host sets the attribute after startup', async () => {
    const svc = make();
    await tick();
    expect(svc.hostControlled).toBe(false);
    document.body.setAttribute('color-theme', 'dark'); // not what we wrote
    await tick();
    expect(svc.hostControlled).toBe(true);
    expect(svc.theme()).toBe('dark');
  });

  it('does not mistake its own write for a host', async () => {
    const svc = make({ url: 'dark' });
    await tick();
    expect(svc.hostControlled).toBe(false);
  });

  it('disconnects the observer on destroy', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    make();
    TestBed.resetTestingModule();
    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
  });

  it('treats the attribute from the index.html boot script as its own, not the host one', () => {
    document.documentElement.setAttribute('data-ts-theme-boot', '');
    const svc = make({ bodyAttr: 'dark' });
    expect(svc.hostControlled).toBe(false);
    expect(svc.theme()).toBe('light');
    expect(body()).toBe('light');
  });
});
