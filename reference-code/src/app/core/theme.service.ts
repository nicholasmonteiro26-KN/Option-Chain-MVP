import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

/** The `theme` query parameter of the page URL (raw; validated by the service). Replaced in tests. */
export const THEME_URL_PARAM = new InjectionToken<string | null>('THEME_URL_PARAM', {
  providedIn: 'root',
  factory: () => {
    try {
      return typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('theme');
    } catch {
      return null;
    }
  },
});

const asTheme = (v: unknown): Theme | null => (v === 'light' || v === 'dark' ? v : null);

/**
 * Light / dark theme. The page has no theme switch: it uses the theme the client chose on TradeSmart's web platform.
 * TradeSmart's own switch is the `color-theme` attribute on `<body>`, so that is what this reads and sets.
 *
 * Order:
 * 1. Host: inside TradeSmart's app the host sets body[color-theme]; it is followed (live), never written.
 * 2. `?theme=light|dark` on the URL. INTEGRATION: TradeSmart adds the client's platform theme when it opens the chain
 *    in its own tab, e.g. `/option-chain?theme=dark`.
 * 3. Light (the default; the computer's light / dark setting is not used).
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);
  private readonly urlTheme = asTheme(inject(THEME_URL_PARAM));

  private readonly host = signal(false);
  /**
   * True when a host app controls body[color-theme]: it was set before this service started, or it changed to a value
   * this service did not write. Then it is followed, never written.
   */
  get hostControlled(): boolean { return this.host(); }
  private readonly current = signal<Theme>('light');
  readonly theme = this.current.asReadonly();
  /** The last value this service wrote to body[color-theme]. */
  private lastWritten: Theme | null = null;

  constructor() {
    const body = this.doc.body;
    // index.html's boot script sets the attribute too (to avoid a light flash) and marks <html>; that one is ours.
    const bootMarked = this.doc.documentElement.hasAttribute('data-ts-theme-boot');
    const preset = body ? asTheme(body.getAttribute('color-theme')) : null;
    const destroy = inject(DestroyRef);

    if (preset !== null && !bootMarked) {
      this.adoptHost(preset);
    } else {
      this.apply(this.urlTheme ?? 'light');
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
    this.current.set(t);
    this.doc.documentElement.style.colorScheme = t;
  }

  private apply(t: Theme): void {
    if (this.host()) return;
    this.current.set(t);
    this.lastWritten = t;
    this.doc.body?.setAttribute('color-theme', t);
    this.doc.documentElement.style.colorScheme = t;
  }
}
