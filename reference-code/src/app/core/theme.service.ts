import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ts.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Where the explicit choice is kept (null: no usable storage). Replaced in tests. */
export const THEME_STORAGE = new InjectionToken<Pick<Storage, 'getItem' | 'setItem'> | null>('THEME_STORAGE', {
  providedIn: 'root',
  factory: () => {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null; // storage blocked by the browser
    }
  },
});

/** matchMedia, injected so tests can drive the system setting. */
export const THEME_MATCH_MEDIA = new InjectionToken<((query: string) => MediaQueryList) | null>('THEME_MATCH_MEDIA', {
  providedIn: 'root',
  factory: () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? (q: string) => window.matchMedia(q)
    : null),
});

const asTheme = (v: unknown): Theme | null => (v === 'light' || v === 'dark' ? v : null);

/**
 * Light / dark theme. TradeSmart's own switch is the `color-theme` attribute on `<body>`, so that is what this sets.
 *
 * INTEGRATION: inside TradeSmart's app the host sets body[color-theme]; this service follows it
 *
 * Standalone, the order is: stored choice (`ts.theme`), else the system setting. The system setting is followed live
 * until the user makes an explicit choice with `set` / `toggle`.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly storage = inject(THEME_STORAGE);
  private readonly matchMedia = inject(THEME_MATCH_MEDIA);

  private readonly host = signal(false);
  /**
   * True when a host app controls body[color-theme]: it was set before this service started, or it changed to a value
   * this service did not write. Then it is followed, never written, and the toggle hides itself.
   */
  get hostControlled(): boolean { return this.host(); }
  private readonly current = signal<Theme>('light');
  readonly theme = this.current.asReadonly();
  private explicit = false;
  /** The last value this service wrote to body[color-theme]. */
  private lastWritten: Theme | null = null;
  private stopSystem: (() => void) | null = null;

  constructor() {
    const body = this.doc.body;
    // index.html's boot script sets the attribute too (to avoid a light flash) and marks <html>; that one is ours.
    const bootMarked = this.doc.documentElement.hasAttribute('data-ts-theme-boot');
    const preset = body ? asTheme(body.getAttribute('color-theme')) : null;
    const destroy = inject(DestroyRef);

    if (preset !== null && !bootMarked) {
      this.adoptHost(preset);
    } else {
      const stored = this.readStored();
      const mql = this.matchMedia ? this.matchMedia(DARK_QUERY) : null;
      this.explicit = stored !== null;
      this.apply(stored ?? (mql?.matches ? 'dark' : 'light'));
      if (mql) {
        const onChange = (e: { matches: boolean }): void => {
          if (!this.explicit) this.apply(e.matches ? 'dark' : 'light');
        };
        mql.addEventListener('change', onChange);
        this.stopSystem = () => mql.removeEventListener('change', onChange);
        destroy.onDestroy(() => this.stopSystem?.());
      }
    }

    const View = this.doc.defaultView;
    if (body && View && typeof View.MutationObserver === 'function') {
      const mo = new View.MutationObserver(() => {
        const v = asTheme(body.getAttribute('color-theme'));
        if (this.host()) {
          this.current.set(v ?? 'light');
          this.doc.documentElement.style.colorScheme = this.current();
        } else if (v !== null && v !== this.lastWritten) {
          this.adoptHost(v); // a host set it after startup
        }
      });
      mo.observe(body, { attributes: true, attributeFilter: ['color-theme'] });
      destroy.onDestroy(() => mo.disconnect());
    }
  }

  private adoptHost(t: Theme): void {
    this.host.set(true);
    this.stopSystem?.();
    this.stopSystem = null;
    this.current.set(t);
    this.doc.documentElement.style.colorScheme = t;
  }

  /** An explicit choice: stored, and the system setting is no longer followed. No-op when the host controls the theme. */
  set(t: Theme): void {
    if (this.hostControlled) return;
    this.explicit = true;
    try {
      this.storage?.setItem(THEME_STORAGE_KEY, t);
    } catch {
      // storage full or blocked: the choice still applies for this page
    }
    this.apply(t);
  }

  toggle(): void {
    this.set(this.current() === 'dark' ? 'light' : 'dark');
  }

  private readStored(): Theme | null {
    try {
      return asTheme(this.storage?.getItem(THEME_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  private apply(t: Theme): void {
    this.current.set(t);
    this.lastWritten = t;
    this.doc.body?.setAttribute('color-theme', t);
    this.doc.documentElement.style.colorScheme = t;
  }
}
