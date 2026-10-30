import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_MATCH_MEDIA, THEME_STORAGE, ThemeService } from './theme.service';

type Listener = (e: { matches: boolean }) => void;

class FakeMql {
  private listeners: Listener[] = [];
  constructor(public matches: boolean) {}
  addEventListener(_: string, l: Listener): void { this.listeners.push(l); }
  removeEventListener(_: string, l: Listener): void { this.listeners = this.listeners.filter((x) => x !== l); }
  emit(matches: boolean): void {
    this.matches = matches;
    this.listeners.forEach((l) => l({ matches }));
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
  };
}

describe('ThemeService', () => {
  const body = (): string | null => document.body.getAttribute('color-theme');
  let mql: FakeMql;

  function make(opts: { systemDark?: boolean; storage?: unknown; bodyAttr?: string } = {}): ThemeService {
    mql = new FakeMql(opts.systemDark ?? false);
    if (opts.bodyAttr) document.body.setAttribute('color-theme', opts.bodyAttr);
    TestBed.configureTestingModule({
      providers: [
        { provide: THEME_MATCH_MEDIA, useValue: () => mql },
        { provide: THEME_STORAGE, useValue: opts.storage === undefined ? memoryStorage() : opts.storage },
      ],
    });
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

  it('uses the system dark preference on a first visit', () => {
    const svc = make({ systemDark: true });
    expect(svc.theme()).toBe('dark');
    expect(body()).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(svc.hostControlled).toBe(false);
  });

  it('defaults to light when the system is light', () => {
    expect(make().theme()).toBe('light');
    expect(body()).toBe('light');
  });

  it('prefers a stored choice over the system setting', () => {
    const svc = make({ systemDark: true, storage: memoryStorage({ 'ts.theme': 'light' }) });
    expect(svc.theme()).toBe('light');
    expect(body()).toBe('light');
  });

  it('ignores an invalid stored value', () => {
    expect(make({ systemDark: true, storage: memoryStorage({ 'ts.theme': 'blue' }) }).theme()).toBe('dark');
  });

  it('toggle stores the choice and flips the attribute', () => {
    const storage = memoryStorage();
    const svc = make({ storage });
    svc.toggle();
    expect(svc.theme()).toBe('dark');
    expect(body()).toBe('dark');
    expect(storage.data['ts.theme']).toBe('dark');
    svc.toggle();
    expect(body()).toBe('light');
    expect(storage.data['ts.theme']).toBe('light');
  });

  it('follows system changes before an explicit choice', () => {
    const storage = memoryStorage();
    const svc = make({ storage });
    mql.emit(true);
    expect(svc.theme()).toBe('dark');
    expect(body()).toBe('dark');
    expect((storage.data as Record<string, string>)['ts.theme']).toBeUndefined(); // following the system is not a choice
    mql.emit(false);
    expect(svc.theme()).toBe('light');
  });

  it('ignores system changes after an explicit choice', () => {
    const svc = make();
    svc.set('light');
    mql.emit(true);
    expect(svc.theme()).toBe('light');
    expect(body()).toBe('light');
  });

  it('ignores system changes when a choice was stored earlier', () => {
    const svc = make({ storage: memoryStorage({ 'ts.theme': 'light' }) });
    mql.emit(true);
    expect(svc.theme()).toBe('light');
  });

  it('adopts a theme the host set, never overwrites it, and follows its changes', async () => {
    const storage = memoryStorage({ 'ts.theme': 'light' });
    const svc = make({ bodyAttr: 'dark', storage });
    expect(svc.hostControlled).toBe(true);
    expect(svc.theme()).toBe('dark');
    svc.toggle();
    svc.set('light');
    mql.emit(false);
    expect(body()).toBe('dark');
    expect(svc.theme()).toBe('dark');
    expect(storage.data['ts.theme']).toBe('light'); // untouched

    document.body.setAttribute('color-theme', 'light'); // the host switches
    await new Promise((r) => setTimeout(r));
    expect(svc.theme()).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('switches to host control when the host sets the attribute after startup', async () => {
    const storage = memoryStorage();
    const svc = make({ storage });
    svc.toggle(); // our own write: no host
    await new Promise((r) => setTimeout(r));
    expect(svc.hostControlled).toBe(false);
    expect(svc.theme()).toBe('dark');

    document.body.setAttribute('color-theme', 'light'); // not what we wrote
    await new Promise((r) => setTimeout(r));
    expect(svc.hostControlled).toBe(true);
    expect(svc.theme()).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');

    mql.emit(true); // the system is no longer followed
    svc.toggle();
    svc.set('dark');
    expect(body()).toBe('light');
    expect(svc.theme()).toBe('light');
    expect(storage.data['ts.theme']).toBe('dark'); // only our earlier toggle

    document.body.setAttribute('color-theme', 'dark'); // and later host changes are followed
    await new Promise((r) => setTimeout(r));
    expect(svc.theme()).toBe('dark');
  });

  it('does not mistake its own system-driven writes for a host', async () => {
    const svc = make();
    mql.emit(true);
    await new Promise((r) => setTimeout(r));
    expect(svc.hostControlled).toBe(false);
    expect(svc.theme()).toBe('dark');
  });

  it('removes the matchMedia listener and disconnects the observer on destroy', () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const svc = make();
    mql.emit(true);
    expect(svc.theme()).toBe('dark');
    TestBed.resetTestingModule();
    expect(disconnect).toHaveBeenCalled();
    mql.emit(false); // listener gone: no change reaches the destroyed service
    expect(svc.theme()).toBe('dark');
    disconnect.mockRestore();
  });

  it('removes the matchMedia listener when a host takes over', async () => {
    const svc = make();
    document.body.setAttribute('color-theme', 'dark');
    await new Promise((r) => setTimeout(r));
    expect(svc.hostControlled).toBe(true);
    mql.emit(false);
    expect(svc.theme()).toBe('dark');
  });

  it('treats the attribute from the index.html boot script as its own, not the host one', () => {
    document.documentElement.setAttribute('data-ts-theme-boot', '');
    const svc = make({ systemDark: false, bodyAttr: 'dark', storage: memoryStorage({ 'ts.theme': 'light' }) });
    expect(svc.hostControlled).toBe(false);
    expect(svc.theme()).toBe('light');
    expect(body()).toBe('light');
  });

  it('tolerates storage that throws', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    const svc = make({ systemDark: true, storage: throwing });
    expect(svc.theme()).toBe('dark');
    svc.toggle();
    expect(svc.theme()).toBe('light');
    expect(body()).toBe('light');
  });

  it('works without storage or matchMedia', () => {
    TestBed.configureTestingModule({
      providers: [{ provide: THEME_MATCH_MEDIA, useValue: null }, { provide: THEME_STORAGE, useValue: null }],
    });
    const svc = TestBed.inject(ThemeService);
    expect(svc.theme()).toBe('light');
    svc.set('dark');
    expect(body()).toBe('dark');
  });
});
