import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

@Component({
  selector: 'oc-footer-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="foot">
      <button type="button" class="tool" (click)="addToWatchlist.emit()">Add to Watchlist ({{ checkedCount() }})</button>
      <button type="button" class="tool" (click)="addToBasket.emit()">Add to Basket ({{ checkedCount() }})</button>
      @if (summary(); as s) {
        <span class="sp">{{ s }}</span>
      }
    </div>
  `,
  styles: `
    :host { display: block; color: var(--ts-fg); background: var(--ts-bg); font-family: var(--ts-font); }
    .foot { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 14px; border-top: 1px solid var(--ts-line); font-size: 13px; }
    .tool {
      border: 1px solid var(--ts-line); background: var(--ts-bg); color: var(--ts-fg); border-radius: 8px;
      padding: 4px 10px; min-height: 32px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .tool:focus-visible { outline: 2px solid var(--ts-blue); outline-offset: 2px; }
    .sp { margin-left: auto; color: var(--ts-muted); font-variant-numeric: tabular-nums; }
  `,
})
export class FooterActionsComponent {
  readonly checkedCount = input(0);
  readonly fwd = input<number | null>(null);
  readonly atm = input<number | null>(null);
  readonly expiryLabel = input<string | null>(null);

  readonly addToWatchlist = output<void>();
  readonly addToBasket = output<void>();

  protected readonly summary = computed(() => {
    const parts: string[] = [];
    if (this.fwd() !== null) parts.push(`Fwd ${this.fwd()!.toFixed(1)}`);
    if (this.atm() !== null) parts.push(`ATM ${this.atm()}`);
    if (this.expiryLabel()) parts.push(this.expiryLabel()!);
    return parts.join(' · ');
  });
}
