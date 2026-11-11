import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import { Underlying } from '../../data-access/models';

export interface Ohlc {
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
}
export interface QuickPrice { ltp: number; chgPct: number }

export const SEARCH_DEBOUNCE_MS = 250;
const DASH = '–';
let nextId = 0;

const money = (v: number | null | undefined): string =>
  typeof v === 'number' && Number.isFinite(v)
    ? v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : DASH;

@Component({
  selector: 'oc-underlying-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="quick">
      <div class="quick-list">
        @for (u of quick(); track u.sym) {
          <button
            type="button"
            class="qbtn"
            [attr.aria-pressed]="u.sym === selected().sym"
            [disabled]="!!u.unavailable"
            [attr.title]="u.unavailable ?? null"
            (click)="select.emit(u)"
          >
            <b>{{ u.sym }}</b>
            @if (quickPrices()[u.sym]; as p) {
              <span>
                {{ fmt(p.ltp) }}
                <span [class]="p.chgPct > 0 ? 'pos' : p.chgPct < 0 ? 'neg' : ''">{{ signed(p.chgPct) }}%</span>
              </span>
            }
          </button>
        }
      </div>
      <!-- Selected underlying: price, change, and the day's OHLC as one horizontal candle (TradingView-style). -->
      <div class="und-bar">
        <b>{{ selected().sym }}</b>
        <span class="exch">{{ selected().exch }}</span>
        @if (ltp() !== null) {
          <span class="px" data-testid="underlying-ltp">{{ fmt(ltp()) }}</span>
          @if (change(); as c) {
            <span class="chg" [class]="'chg ' + c.cls">{{ c.text }}</span>
          }
        }
        @if (candle(); as k) {
          <div class="ohlc" data-testid="ohlc-candle" role="img" [attr.aria-label]="k.label" [attr.title]="k.label">
            <span class="end">L {{ fmt(ohlc().low) }}</span>
            <span class="track">
              <span class="wick"></span>
              @if (k.open !== null && k.close !== null) {
                <span [class]="'body ' + k.cls" [style.left.%]="k.bodyLeft" [style.width.%]="k.bodyWidth"></span>
              }
              @if (k.open !== null) {
                <span class="tick" [style.left.%]="k.open"></span>
              }
              @if (k.close !== null) {
                <span [class]="'dot ' + k.cls" [style.left.%]="k.close"></span>
              }
            </span>
            <span class="end">H {{ fmt(ohlc().high) }}</span>
          </div>
        }
        @if (lotSize() !== null) {
          <span class="lot" title="Lot size for this expiry">Lot <b>{{ lotSize() }}</b></span>
        }
      </div>
      <div class="search">
        <label class="sr" [for]="inputId">Search index or stock</label>
        <input
          [id]="inputId"
          type="search"
          data-testid="underlying-search"
          role="combobox"
          autocomplete="off"
          placeholder="Search index or stock, e.g. RELIANCE"
          [value]="text()"
          aria-autocomplete="list"
          [attr.aria-expanded]="listOpen()"
          [attr.aria-controls]="listId"
          [attr.aria-activedescendant]="listOpen() ? optionId(activeIdx()) : null"
          (input)="onInput($any($event.target).value)"
          (keydown)="onKey($event)"
        />
        @if (listOpen()) {
          <ul role="listbox" [id]="listId" aria-label="Search results">
            @for (r of searchResults(); track r.exch + r.token; let i = $index) {
              <li
                role="option"
                [id]="optionId(i)"
                [attr.aria-selected]="i === activeIdx()"
                (mousedown)="$event.preventDefault(); choose(r)"
              >
                <span><b>{{ r.sym }}</b> <small>{{ r.name }}</small></span>
                <small>{{ r.isIndex ? 'Index' : 'Stock' }} · {{ r.foExch }}</small>
              </li>
            }
          </ul>
        } @else if (noMatch()) {
          <p class="none" role="status">No index or stock with options matches "{{ text().trim() }}"</p>
        }
      </div>
      <div class="tools"><ng-content /></div>
    </div>
  `,
  styles: `
    :host { display: block; color: var(--ts-fg); background: var(--ts-bg); font-family: var(--ts-font); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .quick { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--ts-line); }
    .quick-list { display: flex; flex-wrap: wrap; gap: 6px; }
    .qbtn {
      border: 1px solid var(--ts-line); background: var(--ts-bg); color: var(--ts-fg); border-radius: 8px;
      padding: 5px 10px; font: inherit; font-size: 12.5px; cursor: pointer; display: flex; flex-direction: column;
      align-items: flex-start; line-height: 1.25; min-width: 96px; min-height: 44px;
    }
    .qbtn b { font-weight: 600; }
    .qbtn:disabled { color: var(--ts-muted); background: var(--ts-bg2); cursor: not-allowed; }
    .qbtn span { font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .qbtn[aria-pressed='true'] { border-color: var(--ts-blue); box-shadow: inset 0 0 0 1px var(--ts-blue); background: var(--ts-blue-soft); }
    .qbtn:focus-visible, input:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
    .pos { color: var(--ts-green); }
    .neg { color: var(--ts-red); }
    .tools { display: flex; align-items: center; gap: 10px; }
    .search { position: relative; margin-left: auto; flex: 0 1 300px; min-width: 200px; }
    .search input {
      width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 7px 10px;
      border: 1px solid var(--ts-input-border); border-radius: 4px; background: var(--ts-input-bg); color: var(--ts-input-fg);
    }
    .search ul {
      position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; margin: 0; padding: 4px; list-style: none;
      background: var(--ts-bg); border: 1px solid var(--ts-line); border-radius: 8px;
      box-shadow: 0 12px 30px -14px var(--ts-shadow); max-height: 260px; overflow: auto;
    }
    .search li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .search small { color: var(--ts-muted); font-size: 11.5px; }
    .search li[aria-selected='true'], .search li:hover { background: var(--ts-blue-soft); }
    .none { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; margin: 0; padding: 8px 10px; font-size: 13px;
      color: var(--ts-muted); background: var(--ts-bg); border: 1px solid var(--ts-line); border-radius: 8px; }
    .und-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 13px; }
    .px { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .chg { font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .exch { font-size: 11px; font-weight: 600; color: var(--ts-muted); border: 1px solid var(--ts-line); border-radius: 4px; padding: 0 5px; }
    /* Day's range as a horizontal candle: the wick runs low to high, the body open to last price (green up, red down),
       a tick marks the open and a dot the last price. All values are in the tooltip and the accessible name. */
    .ohlc { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ts-muted); font-variant-numeric: tabular-nums; cursor: default; }
    .track { position: relative; width: 140px; height: 12px; }
    .wick { position: absolute; left: 0; right: 0; top: 50%; height: 2px; transform: translateY(-50%); border-radius: 1px; background: var(--ts-muted); opacity: 0.5; }
    .body { position: absolute; top: 50%; height: 6px; min-width: 2px; transform: translateY(-50%); border-radius: 1px; }
    .body.pos, .dot.pos { background: var(--ts-green); }
    .body.neg, .dot.neg { background: var(--ts-red); }
    .body.flat, .dot.flat { background: var(--ts-muted); }
    .tick { position: absolute; top: 0; bottom: 0; width: 2px; transform: translateX(-50%); background: var(--ts-fg); opacity: 0.6; }
    .dot { position: absolute; top: 50%; width: 9px; height: 9px; border-radius: 50%; transform: translate(-50%, -50%); box-shadow: 0 0 0 2px var(--ts-bg); }
    .lot { font-size: 12px; color: var(--ts-muted); }
    .lot b { color: var(--ts-fg); font-weight: 500; }
  `,
})
export class UnderlyingBarComponent {
  readonly quick = input.required<readonly Underlying[]>();
  readonly selected = input.required<Underlying>();
  readonly quickPrices = input<Record<string, QuickPrice>>({});
  readonly ohlc = input<Ohlc>({ open: null, high: null, low: null, prevClose: null });
  readonly lotSize = input<number | null>(null);
  /** Last price of the selected underlying; with ohlc().prevClose it gives the change shown after it (D19). */
  readonly ltp = input<number | null>(null);
  readonly searchResults = input<Underlying[]>([]);
  /** The query text `searchResults` belong to (the parent echoes the query it fetched for). */
  readonly resultsFor = input<string | null>(null);

  readonly select = output<Underlying>();
  /** Debounced by 250 ms; never emitted for empty text. */
  readonly search = output<string>();

  protected readonly inputId = `oc-search-${nextId}`;
  protected readonly listId = `oc-search-list-${nextId++}`;
  protected readonly text = signal('');
  /** The query the debounce last fired for. */
  private readonly settled = signal('');
  private readonly open = signal(false);
  private readonly active = signal(0);
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Results are current only when they were fetched for exactly what is typed now. */
  private readonly fresh = computed(() => this.resultsFor() !== null && this.resultsFor() === this.text().trim());
  /** Change vs previous close, e.g. "+166.55 (+0.73%)", en-IN grouped. */
  protected readonly change = computed(() => {
    const ltp = this.ltp();
    const pc = this.ohlc().prevClose;
    if (ltp === null || !pc) return null;
    const d = ltp - pc;
    const sign = d > 0 ? '+' : d < 0 ? '-' : '';
    const pct = (Math.abs(d) / pc) * 100;
    return { text: `${sign}${money(Math.abs(d))} (${sign}${pct.toFixed(2)}%)`, cls: d > 0 ? 'pos' : d < 0 ? 'neg' : '' };
  });
  /**
   * The day's OHLC as positions (% of the low-high range) for the candle; the close is the last price. Null until the
   * low and high are known and differ.
   */
  protected readonly candle = computed(() => {
    const { open, high, low, prevClose } = this.ohlc();
    if (low === null || high === null || !(high > low)) return null;
    const last = this.ltp();
    const pct = (v: number): number => Math.round(Math.min(1, Math.max(0, (v - low) / (high - low))) * 10000) / 100;
    const o = open === null ? null : pct(open);
    const c = last === null ? null : pct(last);
    const cls = open === null || last === null || last === open ? 'flat' : last > open ? 'pos' : 'neg';
    const parts = [`Open ${money(open)}`, `High ${money(high)}`, `Low ${money(low)}`, `Last ${money(last)}`];
    if (prevClose !== null) parts.push(`Prev close ${money(prevClose)}`);
    return {
      open: o, close: c, cls,
      bodyLeft: o === null || c === null ? 0 : Math.min(o, c),
      bodyWidth: o === null || c === null ? 0 : Math.abs(c - o),
      label: `Day range: ${parts.join(', ')}`,
    };
  });
  protected readonly listOpen = computed(() => this.open() && this.fresh() && this.searchResults().length > 0);
  protected readonly activeIdx = computed(() =>
    Math.max(0, Math.min(this.active(), this.searchResults().length - 1)),
  );
  protected readonly noMatch = computed(() => {
    const t = this.text().trim();
    return this.open() && t !== '' && this.settled() === this.text() && this.fresh() && this.searchResults().length === 0;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  protected fmt = money;
  protected signed(v: number): string {
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }
  protected optionId(i: number): string {
    return `${this.listId}-${i}`;
  }

  protected onInput(v: string): void {
    this.text.set(v);
    this.active.set(0);
    this.clearTimer();
    if (v.trim() === '') {
      this.open.set(false);
      this.settled.set('');
      return;
    }
    this.open.set(true);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.settled.set(v);
      this.search.emit(v);
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.searchResults().length;
    switch (e.key) {
      case 'ArrowDown':
        if (this.listOpen()) this.active.set(Math.min(this.activeIdx() + 1, n - 1));
        e.preventDefault();
        break;
      case 'ArrowUp':
        if (this.listOpen()) this.active.set(Math.max(this.activeIdx() - 1, 0));
        e.preventDefault();
        break;
      case 'Enter': {
        const r = this.listOpen() ? this.searchResults()[this.activeIdx()] : undefined;
        if (r) {
          e.preventDefault();
          this.choose(r);
        }
        break;
      }
      case 'Escape':
        this.open.set(false);
        e.preventDefault();
        break;
    }
  }

  protected choose(u: Underlying): void {
    this.clearTimer();
    this.select.emit(u);
    this.text.set('');
    this.settled.set('');
    this.open.set(false);
    this.active.set(0);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
