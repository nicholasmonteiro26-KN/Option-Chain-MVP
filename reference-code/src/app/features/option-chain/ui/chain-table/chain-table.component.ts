import {
  afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, signal,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { CdkMenu, CdkMenuItem, CdkMenuTrigger } from '@angular/cdk/menu';
import type { IvStatus } from '@option-analytics/index';
import type { ColumnDef } from '../../columns/column-registry';
import { COLUMNS, exactTitle, pricePrecision } from '../../columns/column-registry';
import { splitFeedKey } from '../../data-access/models';
import type { LegVM, RowVM, ChainViewModel } from '../../view/chain-view-model';
import { BASKET_ICON, WATCHLIST_ICON } from '../ts-icons';
import { FlashDirective } from './flash.directive';

/**
 * Hover Buy / Sell. `token` is the feed key ("NFO|43651"); `exch` and `rawToken` are Kambala's exchange and raw
 * token ("NFO", "43651"), which the order window needs.
 */
export interface TradeEvent {
  token: string; exch: string; rawToken: string; tsym: string; side: 'BUY' | 'SELL'; ltp: number; lotSize: number;
}

/** The per-contract actions besides Buy / Sell: the chart buttons and the "…" menu, as on TradeSmart's chain. */
export type ContractAction =
  | 'chart' | 'advancedChart' | 'watchlist' | 'basket' | 'ato' | 'marketDepth' | 'gtt' | 'priceAlert';

/** A hover-button or "…" menu action on one contract. Same contract fields as TradeEvent, without the side. */
export interface ContractActionEvent {
  action: ContractAction; token: string; exch: string; rawToken: string; tsym: string; ltp: number; lotSize: number;
}

interface MenuItem { action: ContractAction; label: string; icon: string }
/** TradeSmart's "…" menu, in its order. */
export const MORE_MENU: readonly MenuItem[] = [
  { action: 'watchlist', label: 'Add to Watchlist', icon: 'watchlist' },
  { action: 'basket', label: 'Add to Basket', icon: 'basket' },
  { action: 'ato', label: 'Create ATO', icon: 'alarm' },
  { action: 'advancedChart', label: 'Advanced Chart', icon: 'tv' },
  { action: 'marketDepth', label: 'Market Depth', icon: 'depth' },
  { action: 'gtt', label: 'Create GTT', icon: 'clock' },
  { action: 'priceAlert', label: 'Price Alert', icon: 'bell' },
];

const DASH = '–';
const SKELETON_ROWS = 10;
const SIGNED = new Set(['chg', 'chgPct', 'oiChg', 'oiChgPct', 'strDecay', 'gexOiCr', 'gexVolCr']);
const SENSE_CLASS: Record<string, string> = {
  LONG_BUILD_UP: 's-lb', SHORT_BUILD_UP: 's-sb', SHORT_COVERING: 's-sc', LONG_UNWINDING: 's-lu',
};
const IV_REASON: Partial<Record<IvStatus, string>> = {
  NO_PRICE: 'No two-sided quote and no trades today',
  BELOW_INTRINSIC: 'Price is below intrinsic value',
  ABOVE_MAX: 'Price is above the theoretical maximum',
  BELOW_MIN_VOL: 'Price is too low to imply a volatility',
  ABOVE_MAX_VOL: 'Price is too high to imply a volatility',
  EXPIRED: 'Contract has expired',
  NO_CONVERGENCE: 'Could not solve implied volatility',
};
const LOW_CONF_TITLE = 'Low confidence: price within a few ticks, or under 1 hour to expiry';

interface TradeCtx { token: string; tsym: string; ltp: number; lotSize: number; label: string }
interface CellVM {
  id: string;
  text: string;
  cls: string;
  /** CSS background-size for an OI bar, or null. */
  bar: string | null;
  sub: { text: string; cls: string } | null;
  title: string | null;
  /** Numeric value watched by ocFlash, for flash columns only. */
  flash: number | null;
  trade: TradeCtx | null;
  /** The basket checkbox, on the innermost cell of each side only. */
  check: { token: string; label: string } | null;
}
interface RowView {
  strike: number;
  ce: CellVM[];
  pe: CellVM[];
  /** Strike-mode cells (everything after the strike). */
  cells: CellVM[];
  /** Spot line after this row (ascending order) or before it (descending): the lower strike around spot. */
  spotAfter: boolean;
  spotBefore: boolean;
  /** The analytics ATM strike: its strike chip is highlighted. */
  atm: boolean;
  /**
   * OI line widths, as a % of the row: each side's line runs from the middle of the row outwards, so a full line
   * (the side's largest OI) is 50%.
   */
  ceOi: number;
  peOi: number;
}

const signClass = (v: unknown): string => (typeof v === 'number' ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '');

@Component({
  selector: 'oc-chain-table',
  imports: [FlashDirective, NgTemplateOutlet, CdkMenu, CdkMenuItem, CdkMenuTrigger],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chain-table.component.html',
  styleUrl: './chain-table.component.scss',
})
export class ChainTableComponent {
  readonly vm = input.required<ChainViewModel>();
  readonly spot = input.required<number>();
  readonly checked = input<ReadonlySet<string>>(new Set<string>());
  readonly stale = input<ReadonlySet<string>>(new Set<string>());
  readonly loading = input(false);

  readonly trade = output<TradeEvent>();
  readonly toggleCheck = output<string>();
  readonly contractAction = output<ContractActionEvent>();

  protected readonly menuItems = MORE_MENU;
  /** TradeSmart's watchlist (binoculars) and basket icons, for those two menu entries. */
  protected readonly wl = WATCHLIST_ICON;
  protected readonly bk = BASKET_ICON;
  /** Strike order, flipped by the arrows on the Strike header (TradeSmart). Ascending by default. */
  protected readonly descending = signal(false);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly head = viewChild<ElementRef<HTMLElement>>('head');

  protected readonly mirrored = computed(() => this.vm().mode === 'mirrored');
  protected readonly ceCols = computed(() => this.vm().columns);
  protected readonly peCols = computed(() => [...this.vm().columns].reverse());
  protected readonly skeleton = computed(() => Array.from({ length: SKELETON_ROWS }, (_, i) => i));
  protected readonly skeletonCols = computed(() => this.vm().columns.map((c) => c.id));
  protected readonly spotLabel = computed(() =>
    this.spot().toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  /** What the header height depends on. A string, so tick-only view-model changes leave it equal. */
  private readonly layoutKey = computed(() => {
    const vm = this.vm();
    return `${vm.mode}|${vm.columns.map((c) => c.id).join(',')}|${this.loading()}`;
  });

  protected readonly rows = computed<RowView[]>(() => {
    const vm = this.vm();
    const spot = this.spot();
    const stale = this.stale();
    const cols = vm.columns;
    const mirrored = vm.mode === 'mirrored';
    const peCols = [...cols].reverse();
    const half = (oi: number | undefined, max: number): number =>
      oi && max > 0 ? Math.round(Math.min(oi / max, 1) * 5000) / 100 : 0;
    const desc = this.descending();
    const view = vm.rows.map((row) => {
      const ceStale = !!row.ce && stale.has(row.ce.ref.token);
      const peStale = !!row.pe && stale.has(row.pe.ref.token);
      const build = (list: ColumnDef[], side: 'ce' | 'pe', outer: number): CellVM[] =>
        list.map((c, i) => this.cell(c, row, vm, side, {
          itm: side === 'ce' ? row.strike < spot : row.strike > spot,
          stale: side === 'ce' ? ceStale : peStale,
          acts: i === outer,
        }));
      return {
        strike: row.strike,
        // B/S sit on the innermost cell of each side, next to the strike.
        ce: mirrored ? build(cols, 'ce', cols.length - 1) : [],
        pe: mirrored ? build(peCols, 'pe', 0) : [],
        cells: mirrored ? [] : cols.map((c) => this.cell(c, row, vm, undefined, { itm: false, stale: false, acts: false })),
        spotAfter: !desc && vm.spotSlot !== null && row.strike === vm.spotSlot,
        spotBefore: desc && vm.spotSlot !== null && row.strike === vm.spotSlot,
        atm: vm.atmStrike != null && row.strike === vm.atmStrike,
        ceOi: mirrored ? half(row.ce?.quote?.oi, vm.maxOi.ce) : 0,
        peOi: mirrored ? half(row.pe?.quote?.oi, vm.maxOi.pe) : 0,
      };
    });
    return desc ? view.reverse() : view;
  });

  constructor() {
    // The spot line sticks 12px inside the header so it never hides under it. Measured only when the
    // header structure changes (columns, mode, loading), not on every tick: reading offsetHeight after
    // a tick's DOM writes forces a synchronous layout of the whole table.
    afterRenderEffect(() => {
      this.layoutKey();
      const h = this.head()?.nativeElement.offsetHeight ?? 0;
      const style = this.host.nativeElement.style;
      style.setProperty('--head-h', `${h + 12}px`);
    });
  }

  protected toggleSort(): void {
    this.descending.update((d) => !d);
  }

  /**
   * A controlled box: it shows `checked`, not the click. The click is undone at once; the parent's new `checked`
   * (if it accepts the change) re-ticks or unticks it on the next render. So a refused tick (strategy full) stays off.
   */
  protected onCheck(e: Event, token: string): void {
    (e.target as HTMLInputElement).checked = this.checked().has(token);
    this.toggleCheck.emit(token);
  }

  protected emitTrade(t: TradeCtx, side: 'BUY' | 'SELL'): void {
    this.trade.emit({ token: t.token, ...splitFeedKey(t.token), tsym: t.tsym, side, ltp: t.ltp, lotSize: t.lotSize });
  }

  protected emitAction(t: TradeCtx, action: ContractAction): void {
    this.contractAction.emit({
      action, token: t.token, ...splitFeedKey(t.token), tsym: t.tsym, ltp: t.ltp, lotSize: t.lotSize,
    });
  }

  private cell(
    col: ColumnDef, row: RowVM, vm: ChainViewModel, side: 'ce' | 'pe' | undefined,
    o: { itm: boolean; stale: boolean; acts: boolean },
  ): CellVM {
    const v = col.value(row, side);
    const pp = pricePrecision(row, side);
    const leg: LegVM | null = side ? row[side] : null;
    const cls: string[] = [];
    let bar: string | null = null;
    if (o.itm) cls.push('itm');
    // Per-side OI is drawn as a line under the whole row (see the template); only Cum OI keeps an in-cell bar.
    if (col.bar === 'cumOi') {
      const max = vm.maxOi.cum;
      const pct = typeof v === 'number' && max > 0 ? (v / max) * 100 : 0;
      cls.push('bar', 'cum');
      bar = `${pct.toFixed(1)}% 70%`;
    }
    if (SIGNED.has(col.id)) cls.push(signClass(v));
    if (col.id === 'oiSense' && typeof v === 'string') cls.push('sense', SENSE_CLASS[v] ?? '');
    if (col.flash) cls.push('ltp');
    if (o.stale) cls.push('stale');
    // Positioning context for the checkbox and the hover buttons; in-ce / in-pe leave room for the checkbox.
    if (o.acts) cls.push('acts-host', side === 'ce' ? 'in-ce' : 'in-pe');
    let title: string | null = col.title ?? null;
    if (col.exact && typeof v === 'number') title = exactTitle(v);
    if (col.id === 'iv' && leg?.a) {
      if (v === null) title = IV_REASON[leg.a.ivStatus] ?? null;
      else if (leg.a.lowConfidence) title = LOW_CONF_TITLE;
      if (leg.a.lowConfidence) cls.push('low-conf');
    }
    let sub: CellVM['sub'] = null;
    if (col.sub) {
      const sc = COLUMNS[col.sub];
      if (sc) {
        const sv = sc.value(row, side);
        sub = { text: sv === null ? DASH : sc.format(sv, pp), cls: signClass(sv) };
      }
    }
    const ltp = leg?.quote?.ltp ?? null;
    const trade: TradeCtx | null = o.acts && leg && ltp !== null
      ? { token: leg.ref.token, tsym: leg.ref.tsym, ltp, lotSize: leg.ref.lotSize, label: `% ${row.strike} ${side === 'ce' ? 'CE' : 'PE'}` }
      : null;
    return {
      id: col.id,
      text: v === null ? DASH : col.format(v, pp),
      cls: cls.filter(Boolean).join(' '),
      bar, sub, title,
      flash: col.flash && typeof v === 'number' ? v : null,
      trade,
      check: o.acts && leg
        ? { token: leg.ref.token, label: `Select ${row.strike} ${side === 'ce' ? 'CE' : 'PE'}` }
        : null,
    };
  }
}
