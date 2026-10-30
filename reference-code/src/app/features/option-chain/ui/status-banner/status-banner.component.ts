import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export type BannerKind = 'reconnecting' | 'closed' | 'error' | 'analytics-unavailable';

@Component({
  selector: 'oc-status-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as v) {
      <div class="banner" data-testid="status-banner" [class]="'banner ' + v.tone" [attr.role]="v.role">
        <span>{{ v.text }}</span>
        @if (kind() === 'error') {
          <button type="button" (click)="retry.emit()">Retry</button>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; font-family: var(--ts-font); }
    .banner { padding: 8px 14px; font-size: 13px; border-bottom: 1px solid var(--ts-line); display: flex; gap: 10px; align-items: center; }
    .warn { background: var(--ts-warn-soft); color: var(--ts-warn); }
    .err { background: var(--ts-red-soft); color: var(--ts-red); }
    .info { background: var(--ts-bg2); color: var(--ts-muted); }
    button {
      margin-left: auto; border: 1px solid currentColor; background: transparent; color: inherit; border-radius: 8px;
      padding: 4px 12px; min-height: 32px; font: inherit; font-size: 13px; cursor: pointer;
    }
    button:focus-visible { outline: 2px solid var(--ts-blue); outline-offset: 2px; }
  `,
})
export class StatusBannerComponent {
  readonly kind = input<BannerKind | null>(null);
  /** Symbol named in the error copy. */
  readonly sym = input('');
  readonly retry = output<void>();

  protected readonly view = computed(() => {
    switch (this.kind()) {
      case 'reconnecting':
        return { tone: 'warn', role: 'status', text: 'Reconnecting to live prices… Showing the last values received.' };
      case 'closed':
        return { tone: 'info', role: 'status', text: 'Market closed · Showing prices as of 15:30.' };
      case 'error':
        return {
          tone: 'err', role: 'alert',
          text: `Could not load the option chain for ${this.sym()}. Check your connection and try again.`,
        };
      case 'analytics-unavailable':
        return { tone: 'info', role: 'status', text: 'Analytics unavailable. Prices are still live.' };
      default:
        return null;
    }
  });
}
