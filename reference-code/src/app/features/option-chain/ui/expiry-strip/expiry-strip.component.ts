import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { dteLabel } from '@option-analytics/time';
import type { ForwardSource } from '@option-analytics/index';
import { Expiry } from '../../data-access/models';
import type { FeedStatus } from '../../data-access/feed/transport';

export interface ExpiryStats {
  atmIv: number | null;
  cumOi: number | null;
  maxPain: number | null;
  pcrOi: number | null;
  pcrVol: number | null;
  forward: number | null;
  forwardSource: ForwardSource | null;
}

const DASH = '—';
/** Expiries shown as buttons; later ones are in the drop-down. */
export const NEAR_COUNT = 3;
const LAKH = 1e5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SOURCE_TEXT: Record<ForwardSource, string> = {
  PARITY_MID: 'from call/put prices',
  FUTURES: 'from futures',
  PARITY_LTP: 'from last traded prices',
  SPOT_CARRY: 'from spot',
};
const DOT: Record<FeedStatus, { cls: string; label: string }> = {
  open: { cls: '', label: 'Feed status: Live' },
  reconnecting: { cls: 'stale', label: 'Feed status: Reconnecting' },
  closed: { cls: 'off', label: 'Feed status: Closed' },
  connecting: { cls: 'off', label: 'Feed status: Connecting' },
  'session-expired': { cls: 'err', label: 'Feed status: Session expired' },
};

/** 'YYYY-MM-DD' -> 'DD Mon YYYY'. */
export function formatExpiryDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

@Component({
  selector: 'oc-expiry-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="strip">
      <div class="left">
      <span class="dot" [class]="dotClass()" role="img" [attr.aria-label]="dot().label" [attr.title]="dot().label"></span>
      <div class="exp" role="group" aria-label="Expiry">
        @for (e of near(); track e.expiry.iso) {
          <button type="button" [attr.data-testid]="'expiry-' + e.expiry.iso" [title]="e.title" [attr.aria-pressed]="e.expiry.iso === selected().iso" (click)="expiryChange.emit(e.expiry)">
            {{ e.label }}
          </button>
        }
      </div>
      @if (more().length) {
        <select
          class="more"
          data-testid="expiry-more"
          aria-label="Next expiry"
          [class.on]="inMore()"
          (change)="pickMore($any($event.target))"
        >
          <option value="" disabled [selected]="!inMore()">Next expiry</option>
          @for (e of more(); track e.expiry.iso) {
            <option [value]="e.expiry.iso" [selected]="e.expiry.iso === selected().iso">{{ e.title }} · {{ e.label }}</option>
          }
        </select>
      }
      @if (partial()) {
        <span class="badge" title="Kambala subscription limit reached. Totals cover subscribed strikes only.">Partial chain</span>
      }
      </div>
      <!-- Centred over the Strike column (the CE and PE halves of the table mirror each other). -->
      <span class="exp-date" data-testid="expiry-date">Expiry <b>{{ selectedDate() }}</b></span>
      <div class="stats">
        <div class="stat" [attr.title]="ivTitle()"><span class="k">ATM IV</span><span class="v">{{ atmIv() }}</span></div>
        <div class="stat" [attr.title]="aggTitle('Cum OI')"><span class="k">Cum OI</span><span class="v">{{ cumOi() }}</span></div>
        <div class="stat" [attr.title]="aggTitle('Max Pain')"><span class="k">Max Pain</span><span class="v">{{ maxPain() }}</span></div>
        <div class="stat" [attr.title]="aggTitle('PCR')"><span class="k">PCR</span><span class="v">{{ fixed(stats().pcrOi) }}</span></div>
        <div class="stat" [attr.title]="aggTitle('PCR (Vol)')"><span class="k">PCR (Vol)</span><span class="v">{{ fixed(stats().pcrVol) }}</span></div>
      </div>
    </div>
  `,
  styles: `
    :host { display: block; color: var(--ts-fg); background: var(--ts-bg); font-family: var(--ts-font); }
    .strip { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 6px 14px; padding: 8px 14px; border-bottom: 1px solid var(--ts-line); font-size: 13px; }
    .left { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; min-width: 0; }
    .exp { display: flex; gap: 2px; flex-wrap: wrap; }
    .exp button {
      border: 0; background: transparent; color: var(--ts-fg); font: inherit; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums;
      padding: 4px 10px; min-height: 30px; border-radius: 6px; cursor: pointer;
    }
    .exp button:hover { background: var(--ts-bg2); }
    .exp button[aria-pressed='true'] { color: var(--ts-outline); background: var(--ts-blue-soft); font-weight: 600; box-shadow: inset 0 0 0 1px var(--ts-outline); }
    .exp button:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
    .more {
      font: inherit; font-size: 13px; font-weight: 500; color: var(--ts-fg); background: var(--ts-input-bg); min-height: 30px;
      border: 1px solid var(--ts-input-border); border-radius: 5px; padding: 2px 6px; cursor: pointer;
    }
    .more.on { color: var(--ts-outline); border-color: var(--ts-outline); background: var(--ts-blue-soft); font-weight: 600; }
    .more:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
    .exp-date { justify-self: center; font-size: 12px; color: var(--ts-muted); white-space: nowrap; }
    .exp-date b { color: var(--ts-fg); font-weight: 600; }
    .stats { display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: flex-end; align-items: center; min-width: 0; }
    .stat { display: flex; gap: 6px; align-items: baseline; }
    .k { color: var(--ts-muted); font-size: 12px; }
    .v { font-weight: 500; font-size: 13px; font-variant-numeric: tabular-nums; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ts-green); display: inline-block; }
    .dot.stale { background: var(--ts-warn); }
    .dot.off { background: var(--ts-muted); }
    .dot.err { background: var(--ts-red); }
    .badge { font-size: 11px; font-weight: 600; border-radius: 4px; padding: 1px 6px; background: var(--ts-warn-soft); color: var(--ts-warn); }
  `,
})
export class ExpiryStripComponent {
  readonly expiries = input.required<Expiry[]>();
  readonly selected = input.required<Expiry>();
  readonly nowMs = input.required<number>();
  readonly stats = input.required<ExpiryStats>();
  readonly feedStatus = input<FeedStatus>('connecting');
  readonly partial = input(false);

  readonly expiryChange = output<Expiry>();

  protected readonly chips = computed(() =>
    this.expiries().map((expiry) => ({ expiry, label: dteLabel(this.nowMs(), expiry.iso), title: formatExpiryDate(expiry.iso) })),
  );
  /** The nearest expiries get their own buttons; the rest go in the "Next expiry" drop-down. */
  protected readonly near = computed(() => this.chips().slice(0, NEAR_COUNT));
  protected readonly more = computed(() => this.chips().slice(NEAR_COUNT));
  protected readonly inMore = computed(() => this.more().some((e) => e.expiry.iso === this.selected().iso));
  protected readonly selectedDate = computed(() => formatExpiryDate(this.selected().iso));
  protected readonly dot = computed(() => DOT[this.feedStatus()]);
  protected readonly dotClass = computed(() => `dot ${this.dot().cls}`.trim());
  protected readonly atmIv = computed(() => this.fixed(this.stats().atmIv === null ? null : this.stats().atmIv! * 100));
  protected readonly cumOi = computed(() => {
    const v = this.stats().cumOi;
    return v === null ? DASH : `${(v / LAKH).toFixed(0)} L`;
  });
  protected readonly maxPain = computed(() => {
    const v = this.stats().maxPain;
    return v === null ? DASH : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  });
  protected readonly ivTitle = computed(() => {
    const { forward, forwardSource } = this.stats();
    return forward === null || forwardSource === null ? null : `Forward ${forward.toFixed(1)} (${SOURCE_TEXT[forwardSource]})`;
  });

  protected pickMore(el: HTMLSelectElement): void {
    const pick = this.more().find((e) => e.expiry.iso === el.value);
    if (pick) this.expiryChange.emit(pick.expiry);
  }

  /** Spec §3.3: on a partial chain the aggregates cover the subscribed strikes only, and say so. */
  protected aggTitle(label: string): string | null {
    return this.partial() ? `${label} (subscribed strikes)` : null;
  }

  protected fixed(v: number | null): string {
    return v === null || !Number.isFinite(v) ? DASH : v.toFixed(2);
  }
}
