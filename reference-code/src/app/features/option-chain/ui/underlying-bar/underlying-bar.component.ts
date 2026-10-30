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
          <button type="button" class="qbtn" [attr.aria-pressed]="u.sym === selected().sym" (click)="select.emit(u)">
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
    </div>
    <div class="und-bar">
      <b>{{ selected().sym }}</b>
      <span class="exch">{{ selected().exch }}</span>
      @if (ltp() !== null) {
        <span class="px" data-testid="underlying-ltp">{{ fmt(ltp()) }}</span>
        @if (change(); as c) {
          <span class="chg" [class]="'chg ' + c.cls">{{ c.text }}</span>
        }
      }
      <div class="ohlc">
        <span>O <b>{{ fmt(ohlc().open) }}</b>&ngsp;</span>
        <span>H <b>{{ fmt(ohlc().high) }}</b>&ngsp;</span>
        <span>L <b>{{ fmt(ohlc().low) }}</b>&ngsp;</span>
        <span>Prev close <b>{{ fmt(ohlc().prevClose) }}</b>&ngsp;</span>
        @if (lotSize() !== null) {
          <span>Lot <b>{{ lotSize() }}</b> (this expiry)&ngsp;</span>
        }
      </div>
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
    .qbtn span { font-size: 11.5px; font-variant-numeric: tabular-nums; }
    .qbtn[aria-pressed='true'] { border-color: var(--ts-blue); box-shadow: inset 0 0 0 1px var(--ts-blue); background: var(--ts-blue-soft); }
    .qbtn:focus-visible, input:focus-visible { outline: 2px solid var(--ts-blue); outline-offset: 2px; }
    .pos { color: var(--ts-green); }
    .neg { color: var(--ts-red); }
    .search { position: relative; margin-left: auto; flex: 0 1 300px; min-width: 200px; }
    .search input {
      width: 100%; box-sizing: border-box; font: inherit; font-size: 13px; padding: 7px 10px;
      border: 1px solid var(--ts-line); border-radius: 8px; background: var(--ts-bg); color: var(--ts-fg);
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
    .und-bar { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 22px; padding: 10px 14px; border-bottom: 1px solid var(--ts-line); }
    .px { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .chg { font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .exch { font-size: 11px; font-weight: 600; color: var(--ts-muted); border: 1px solid var(--ts-line); border-radius: 4px; padding: 0 5px; }
    .ohlc { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12.5px; color: var(--ts-muted); font-variant-numeric: tabular-nums; }
    .ohlc b { color: var(--ts-fg); font-weight: 500; }
  `,
})
export class UnderlyingBarComponent {
  readonly quick = input.required<Underlying[]>();
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
