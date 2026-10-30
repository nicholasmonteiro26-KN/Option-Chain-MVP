import {
  afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, output, viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { IvStatus } from '@option-analytics/index';
import type { ColumnDef } from '../../columns/column-registry';
import { COLUMNS, exactTitle, pricePrecision } from '../../columns/column-registry';
import { splitFeedKey } from '../../data-access/models';
import type { LegVM, RowVM, ChainViewModel } from '../../view/chain-view-model';
import { FlashDirective } from './flash.directive';

/**
 * Hover Buy / Sell. `token` is the feed key ("NFO|43651"); `exch` and `rawToken` are Kambala's exchange and raw
 * token ("NFO", "43651"), which the order window needs.
 */
export interface TradeEvent {
  token: string; exch: string; rawToken: string; tsym: string; side: 'BUY' | 'SELL'; ltp: number; lotSize: number;
}

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
}
interface RowView {
  strike: number;
  ceToken: string | null;
  peToken: string | null;
  ce: CellVM[];
  pe: CellVM[];
  /** Strike-mode cells (everything after the strike). */
  cells: CellVM[];
  spotAfter: boolean;
  /** The analytics ATM strike: its strike chip is highlighted. */
  atm: boolean;
}
interface SumCell { id: string; text: string }

const signClass = (v: unknown): string => (typeof v === 'number' ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : '');

@Component({
  selector: 'oc-chain-table',
  imports: [FlashDirective, NgTemplateOutlet],
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

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly head = viewChild<ElementRef<HTMLElement>>('head');
  private readonly foot = viewChild<ElementRef<HTMLElement>>('foot');

  protected readonly mirrored = computed(() => this.vm().mode === 'mirrored');
  protected readonly ceCols = computed(() => this.vm().columns);
  protected readonly peCols = computed(() => [...this.vm().columns].reverse());
  protected readonly skeleton = computed(() => Array.from({ length: SKELETON_ROWS }, (_, i) => i));
  protected readonly skeletonCols = computed(() => this.vm().columns.map((c) => c.id));
  protected readonly spotLabel = computed(() =>
    this.spot().toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  /** What the header / footer heights depend on. A string, so tick-only view-model changes leave it equal. */
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
    return vm.rows.map((row) => {
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
        ceToken: row.ce?.ref.token ?? null,
        peToken: row.pe?.ref.token ?? null,
        ce: mirrored ? build(cols, 'ce', 0) : [],
        pe: mirrored ? build(peCols, 'pe', peCols.length - 1) : [],
        cells: mirrored ? [] : cols.map((c) => this.cell(c, row, vm, undefined, { itm: false, stale: false, acts: false })),
        spotAfter: vm.spotSlot !== null && row.strike === vm.spotSlot,
        atm: vm.atmStrike != null && row.strike === vm.atmStrike,
      };
    });
  });

  protected readonly sums = computed(() => {
    const vm = this.vm();
    const of = (c: ColumnDef, key: 'ce' | 'pe' | 'total'): SumCell => ({
      id: c.id, text: c.sum && vm.sums[c.id] ? c.format(vm.sums[c.id]![key]) : '',
    });
    return {
      ce: vm.columns.map((c) => of(c, 'ce')),
      pe: [...vm.columns].reverse().map((c) => of(c, 'pe')),
      total: vm.columns.map((c) => of(c, 'total')),
    };
  });

  constructor() {
    // The spot line sticks 12px inside the header / footer so it never hides under them. Measured only when the
    // header / footer structure changes (columns, mode, loading), not on every tick: reading offsetHeight after
    // a tick's DOM writes forces a synchronous layout of the whole table.
    afterRenderEffect(() => {
      this.layoutKey();
      const h = this.head()?.nativeElement.offsetHeight ?? 0;
      const h1 = this.head()?.nativeElement.querySelector('tr')?.offsetHeight ?? 0;
      const f = this.foot()?.nativeElement.offsetHeight ?? 0;
      const style = this.host.nativeElement.style;
      style.setProperty('--head-h', `${h + 12}px`);
      style.setProperty('--head1-h', `${h1}px`);
      style.setProperty('--foot-h', `${f + 12}px`);
    });
  }

  protected emitTrade(t: TradeCtx, side: 'BUY' | 'SELL'): void {
    this.trade.emit({ token: t.token, ...splitFeedKey(t.token), tsym: t.tsym, side, ltp: t.ltp, lotSize: t.lotSize });
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
    if (col.bar) {
      const kind = col.bar === 'cumOi' ? 'cum' : side;
      const max = kind === 'cum' ? vm.maxOi.cum : kind === 'ce' ? vm.maxOi.ce : vm.maxOi.pe;
      const pct = typeof v === 'number' && max > 0 ? (v / max) * 100 : 0;
      cls.push('bar', kind ?? 'ce');
      bar = `${pct.toFixed(1)}% 70%`;
    }
    if (SIGNED.has(col.id)) cls.push(signClass(v));
    if (col.id === 'oiSense' && typeof v === 'string') cls.push('sense', SENSE_CLASS[v] ?? '');
    if (col.flash) cls.push('ltp');
    if (o.stale) cls.push('stale');
    if (o.acts) cls.push('acts-host'); // positioning context for the hover Buy / Sell buttons
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
    };
  }
}
