import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { BASKET_ICON, WATCHLIST_ICON } from '../ts-icons';

@Component({
  selector: 'oc-footer-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="foot">
      <!-- As on TradeSmart: its icon, the label in capitals, the ticked count in a grey badge; off until a tick. -->
      <button type="button" class="tool" [disabled]="checkedCount() === 0" (click)="addToWatchlist.emit()">
        <svg class="ic" width="20" height="20" [attr.viewBox]="wl.viewBox" fill="none" aria-hidden="true">
          @for (d of wl.barrels; track $index) {
            <path [attr.d]="d" fill="currentColor" stroke="currentColor" [attr.stroke-width]="wl.strokeWidth" />
          }
          <path [attr.d]="wl.bridge" stroke="currentColor" [attr.stroke-width]="wl.strokeWidth" />
        </svg>
        Add to Watchlist <span class="badge">{{ checkedCount() }}</span>
      </button>
      <button type="button" class="tool" [disabled]="checkedCount() === 0" (click)="addToBasket.emit()">
        <svg class="ic" width="22" height="22" [attr.viewBox]="bk.viewBox" aria-hidden="true">
          <path [attr.d]="bk.path" fill="currentColor" />
        </svg>
        Add to Basket <span class="badge">{{ checkedCount() }}</span>
      </button>
      <!-- Opens the strategy pop-up, which sits just above this button. The ticked contracts are its legs. -->
      <button type="button" class="tool strategy" [disabled]="checkedCount() === 0" [attr.aria-expanded]="strategyOpen()"
        (click)="buildStrategy.emit()">
        Build your strategy <span class="badge">{{ checkedCount() }}</span>
      </button>
    </div>
  `,
  styles: `
    :host { display: block; color: var(--ts-fg); background: var(--ts-bg); font-family: var(--ts-font); }
    .foot { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--ts-line); font-size: 13px; }
    .tool {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--ts-tool-border); background: var(--ts-bg); color: var(--ts-tool-fg); border-radius: 4px;
      padding: 4px 8px; min-height: 40px; font: 500 14px var(--ts-font); text-transform: uppercase; cursor: pointer;
    }
    .tool:hover:not(:disabled) { background: var(--ts-bg2); }
    .tool:disabled { opacity: 0.6; cursor: not-allowed; }
    .tool:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
    .strategy { margin-left: auto; color: var(--ts-blue); border-color: var(--ts-blue); }
    .strategy .badge { background: var(--ts-blue-soft); color: var(--ts-blue); }
    .ic { flex: none; }
    .badge {
      min-width: 18px; padding: 3px 6px; border-radius: 999px; background: var(--ts-badge-bg); color: var(--ts-tool-fg);
      font-size: 10px; line-height: 1; text-align: center; font-variant-numeric: tabular-nums;
    }
  `,
})
export class FooterActionsComponent {
  readonly checkedCount = input(0);
  /** The strategy pop-up is showing (for the button's aria-expanded). */
  readonly strategyOpen = input(false);

  readonly addToWatchlist = output<void>();
  readonly addToBasket = output<void>();
  readonly buildStrategy = output<void>();

  protected readonly wl = WATCHLIST_ICON;
  protected readonly bk = BASKET_ICON;
}
