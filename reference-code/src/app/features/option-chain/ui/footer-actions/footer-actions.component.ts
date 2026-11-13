import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { BASKET_ICON, WATCHLIST_ICON } from '../ts-icons';

/** Shown on hover / focus while nothing is ticked. */
export const FOOTER_HINT = 'Select strikes using the checkboxes first';
let hintSeq = 0;

@Component({
  selector: 'oc-footer-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="sr" [id]="hintId">{{ hint }}</span>
    <div class="foot">
      <!-- As on TradeSmart: its icon, the label in capitals, the ticked count in a grey badge. Off until a tick: then
           hovering (or focusing) shows how to select strikes instead of a "not allowed" cursor. -->
      <button type="button" class="tool" [attr.aria-disabled]="off()" [attr.data-hint]="off() ? hint : null"
        [attr.aria-describedby]="off() ? hintId : null" (click)="off() || addToWatchlist.emit()">
        <svg class="ic" width="20" height="20" [attr.viewBox]="wl.viewBox" fill="none" aria-hidden="true">
          @for (d of wl.barrels; track $index) {
            <path [attr.d]="d" fill="currentColor" stroke="currentColor" [attr.stroke-width]="wl.strokeWidth" />
          }
          <path [attr.d]="wl.bridge" stroke="currentColor" [attr.stroke-width]="wl.strokeWidth" />
        </svg>
        Add to Watchlist <span class="badge">{{ checkedCount() }}</span>
      </button>
      <button type="button" class="tool" [attr.aria-disabled]="off()" [attr.data-hint]="off() ? hint : null"
        [attr.aria-describedby]="off() ? hintId : null" (click)="off() || addToBasket.emit()">
        <svg class="ic" width="22" height="22" [attr.viewBox]="bk.viewBox" aria-hidden="true">
          <path [attr.d]="bk.path" fill="currentColor" />
        </svg>
        Add to Basket <span class="badge">{{ checkedCount() }}</span>
      </button>
      <!-- Opens the strategy pop-up, which sits just above this button. The ticked contracts are its legs. -->
      <button type="button" class="tool strategy" [attr.aria-disabled]="off()" [attr.data-hint]="off() ? hint : null"
        [attr.aria-describedby]="off() ? hintId : null" [attr.aria-expanded]="strategyOpen()" (click)="off() || buildStrategy.emit()">
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
    .tool { position: relative; }
    .tool:hover:not([aria-disabled='true']) { background: var(--ts-bg2); }
    /* Off: dimmed, normal cursor, and a hint above the button on hover / keyboard focus. */
    .tool[aria-disabled='true'] { opacity: 0.6; cursor: default; }
    .tool[data-hint]:hover::after, .tool[data-hint]:focus-visible::after {
      content: attr(data-hint); position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
      padding: 6px 10px; border-radius: 6px; background: var(--ts-fg); color: var(--ts-bg); white-space: nowrap;
      font: 500 12px var(--ts-font); text-transform: none; pointer-events: none; z-index: 10;
    }
    .strategy[data-hint]:hover::after, .strategy[data-hint]:focus-visible::after { left: auto; right: 0; transform: none; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
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

  /** Off until a contract is ticked. */
  protected readonly off = computed(() => this.checkedCount() === 0);
  protected readonly hint = FOOTER_HINT;
  protected readonly hintId = `foot-hint-${++hintSeq}`;

  protected readonly wl = WATCHLIST_ICON;
  protected readonly bk = BASKET_ICON;
}
