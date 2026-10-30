import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ThemeService } from '../../../../core/theme.service';

/** Sun / moon icon button. Renders nothing when the host app controls the theme. */
@Component({
  selector: 'oc-theme-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!theme.hostControlled) {
      <button type="button" class="tt" data-testid="theme-toggle" [attr.aria-label]="label()" [attr.title]="label()"
        (click)="theme.toggle()">
        @if (dark()) {
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        } @else {
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        }
      </button>
    }
  `,
  styles: `
    :host { display: inline-flex; }
    .tt {
      display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0;
      border: 1px solid var(--ts-line); border-radius: 4px; background: transparent; color: var(--ts-fg); cursor: pointer;
    }
    .tt:hover { border-color: var(--ts-focus); color: var(--ts-focus); }
    .tt:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
  `,
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly dark = computed(() => this.theme.theme() === 'dark');
  protected readonly label = computed(() => (this.dark() ? 'Switch to light theme' : 'Switch to dark theme'));
}
