import { afterEveryRender, DestroyRef, Directive, effect, ElementRef, inject, input, Renderer2 } from '@angular/core';

/** Minimum time a flash tint is held. Short, so a cell that ticks often is not tinted almost permanently. */
export const FLASH_MS = 400;
/** Fallback when no render comes along (feed quiet): the tint is removed by a timer this long after it started. */
export const FLASH_MAX_MS = 1000;

/**
 * Flashes the host green or red when the bound number rises or falls. The class is toggled on the DOM
 * directly (not through a template binding) so a tick does not dirty the view. The first value never flashes. Does
 * nothing under reduced motion.
 *
 * The styles tint the cell while the class is on (no CSS animation, see chain-table.component.scss). The tint is held
 * for at least FLASH_MS and removed on the first application render after that, so the removal is painted in the
 * same frame as a tick flush (every 250 ms; in practice the tint lasts ~500 ms) instead of costing a whole-table
 * repaint of its own. With no render (quiet feed) a timer removes it after FLASH_MAX_MS; `animationend` also removes
 * it, should a stylesheet animate it. A tick during a flash swaps the class and restarts the hold. There is no forced
 * reflow: the old animation restart read `offsetWidth`, which laid out the whole 200-row table per flashing cell.
 */
@Directive({ selector: '[ocFlash]' })
export class FlashDirective {
  readonly ocFlash = input<number | string | null | undefined>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly renderer = inject(Renderer2);
  private prev: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: 'flash-up' | 'flash-dn' | null = null;
  private startedMs = 0;
  private reducedMotion: MediaQueryList | null | undefined;

  constructor() {
    const stop = this.renderer.listen(this.host, 'animationend', () => this.clear());
    inject(DestroyRef).onDestroy(() => {
      stop();
      if (this.timer !== null) clearTimeout(this.timer);
    });
    afterEveryRender({
      write: () => {
        if (this.active !== null && Date.now() - this.startedMs >= FLASH_MS) this.clear();
      },
    });
    effect(() => {
      const v = this.ocFlash();
      const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
      const prev = this.prev;
      if (n !== null) this.prev = n;
      if (n === null || prev === null || n === prev) return;
      this.flash(n > prev ? 'flash-up' : 'flash-dn');
    });
  }

  private flash(cls: 'flash-up' | 'flash-dn'): void {
    if (this.reducedMotion === undefined) {
      this.reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    }
    if (this.reducedMotion?.matches) return;
    this.clear();
    this.renderer.addClass(this.host, cls);
    this.active = cls;
    this.startedMs = Date.now();
    this.timer = setTimeout(() => this.clear(), FLASH_MAX_MS);
  }

  private clear(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.active) { this.renderer.removeClass(this.host, this.active); this.active = null; }
  }
}
