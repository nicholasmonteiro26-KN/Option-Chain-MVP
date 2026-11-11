import {
  afterRenderEffect, ChangeDetectionStrategy, Component, computed, ElementRef, input, linkedSignal, output, untracked,
  viewChild,
} from '@angular/core';
import type { Expiry } from '../../data-access/models';
import type { MarginState } from '../../strategy/strategy-margin.service';
import {
  BFO_MKT, isBfoMarket, isSendable, legQty, netPremium, resultText, roundToTick,
} from '../../strategy/strategy.models';
import type { LegEdit, LegResult, Product, Strategy, StrategyLeg } from '../../strategy/strategy.models';
import { formatExpiryDate } from '../expiry-strip/expiry-strip.component';

export interface LegSwap { id: string; expiryIso: string; strike: number; type: 'CE' | 'PE' }
type PanelView = 'edit' | 'confirm' | 'results';

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** "₹ 1,18,420"; negatives as "− ₹ 1,121". en-IN grouping, no decimals. */
function formatRupees(n: number): string {
  const body = `₹ ${INR.format(Math.abs(n))}`;
  return Math.round(n) < 0 ? `− ${body}` : body;
}

/** "22850 CE 10 Nov 2026" */
function contract(leg: StrategyLeg): string {
  return `${leg.strike} ${leg.type} ${formatExpiryDate(leg.expiryIso)}`;
}

const PRODUCT_LABEL: Record<Product, string> = { I: 'Intraday', M: 'Normal' };

/**
 * The "Build your strategy" pop-up: one editable row per leg, the margin / premium summary, the action row,
 * an in-panel confirm step and per-leg results. Pure view: every change goes out as an output.
 */
@Component({
  selector: 'oc-strategy-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './strategy-panel.component.html',
  styleUrl: './strategy-panel.component.scss',
  host: { '(keydown.escape)': 'collapse.emit()' },
})
export class StrategyPanelComponent {
  readonly sym = input.required<string>();
  readonly strategy = input.required<Strategy>();
  /** Live prices by feed key ("EXCH|token"). */
  readonly live = input<ReadonlyMap<string, number>>(new Map());
  readonly margin = input<MarginState>({ status: 'empty' });
  readonly expiries = input<Expiry[]>([]);
  /** Strike options for a leg's expiry and type; `ready` is false while they load. */
  readonly pickerFor = input<(leg: StrategyLeg) => { strikes: number[]; ready: boolean }>(() => ({ strikes: [], ready: false }));
  readonly marketOpen = input(false);
  readonly placing = input(false);

  readonly edit = output<{ id: string; edit: LegEdit }>();
  readonly remove = output<string>();
  readonly clearAll = output<void>();
  readonly swap = output<LegSwap>();
  readonly lotMultiplier = output<number>();
  readonly product = output<Product>();
  readonly resetPrices = output<void>();
  readonly retryMargin = output<void>();
  readonly saveToBasket = output<void>();
  /** Emitted from the confirm step only. */
  readonly execute = output<void>();
  readonly collapse = output<void>();

  protected readonly contract = contract;
  protected readonly formatExpiryDate = formatExpiryDate;
  protected readonly productLabel = PRODUCT_LABEL;
  protected readonly products: Product[] = ['I', 'M'];

  private readonly results = computed(() => this.strategy().legs.flatMap((l) => (l.result ? [l.result] : [])));

  /** Switches to 'results' whenever a result appears that wasn't there before; otherwise keeps the user's view. */
  protected readonly view = linkedSignal<readonly LegResult[], PanelView>({
    source: this.results,
    computation: (now, prev) => {
      const seen = prev?.source ?? [];
      if (now.some((r) => !seen.includes(r))) return 'results';
      return prev?.value ?? 'edit';
    },
  });

  /**
   * Set by Place so nothing can be sent or edited twice before `placing` arrives. Cleared when `placing` changes or
   * results arrive, so a page that sets `placing` on and off within one tick can't leave the panel locked.
   */
  private readonly requested = linkedSignal({ source: () => [this.placing(), this.results()] as const, computation: () => false });
  /** Orders are (about to be) in flight: every edit and Back is off. */
  protected readonly busy = computed(() => this.placing() || this.requested());

  protected readonly legs = computed(() => this.strategy().legs);
  /** The legs Execute all sends: included and not already placed. */
  protected readonly included = computed(() => this.legs().filter(isSendable));
  protected readonly withResult = computed(() => this.legs().filter((l) => l.result));
  /** An included limit leg has no price yet (e.g. just moved to another expiry, before its first tick). */
  protected readonly waitingForPrice = computed(() => this.included().some((l) => l.priceType === 'LMT' && l.price <= 0));
  /** A market leg on BFO can't be sent (BFO_MKT says why). */
  protected readonly bfoMarket = computed(() => this.included().some(isBfoMarket));
  protected readonly bfoMktReason = BFO_MKT;
  protected readonly resultText = resultText;
  /** Gates both Execute all and Place. */
  protected readonly cannotPlace = computed(
    () => this.busy() || !this.marketOpen() || this.included().length === 0 || this.waitingForPrice() || this.bfoMarket(),
  );

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly execBtn = viewChild<ElementRef<HTMLElement>>('execBtn');
  private readonly placeBtn = viewChild<ElementRef<HTMLElement>>('placeBtn');
  private readonly confirmBack = viewChild<ElementRef<HTMLElement>>('confirmBack');
  private readonly resultList = viewChild<ElementRef<HTMLElement>>('resultList');
  private shownView: PanelView | null = null;

  constructor() {
    // The @switch drops the focused button on a view change; move focus into the new view so Esc keeps working.
    afterRenderEffect(() => {
      const v = this.view();
      if (this.shownView !== null && v !== this.shownView) untracked(() => this.focusInto(v));
      this.shownView = v;
    });
  }

  /** Net premium in whole rupees: + receives, − pays. */
  protected readonly net = computed(() => Math.round(netPremium(this.strategy(), this.live())));
  protected readonly netText = computed(() => (this.net() > 0 ? `+ ${formatRupees(this.net())}` : formatRupees(this.net())));

  protected readonly marginText = computed(() => this.moneyOf('margin'));
  protected readonly hedgeText = computed(() => this.moneyOf('hedgeBenefit'));
  protected readonly hedgePositive = computed(() => {
    const m = this.margin();
    return m.status === 'ready' && Math.round(m.hedgeBenefit) > 0;
  });

  protected resultLine(r: LegResult): { label: string; cls: string; detail: string | null } {
    switch (r.status) {
      case 'placed': return { label: 'Placed', cls: 'ok', detail: r.orderNo ? `#${r.orderNo}` : 'order no. unavailable' };
      case 'rejected': return { label: 'Rejected', cls: 'bad', detail: r.reason };
      default: return { label: 'Not sent', cls: 'skip mu', detail: null };
    }
  }

  protected plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  protected qty(leg: StrategyLeg): number {
    return legQty(leg, this.strategy().lotMultiplier);
  }

  /** Lots cell hover: "2 lots × 65 = 130" (lots × Lot ×, times the lot size). */
  protected lotsTitle(leg: StrategyLeg): string {
    return `${this.plural(leg.lots * this.strategy().lotMultiplier, 'lot')} × ${leg.lotSize} = ${this.qty(leg)}`;
  }

  protected liveOf(leg: StrategyLeg): string | null {
    const px = this.live().get(leg.token);
    return px === undefined ? null : px.toFixed(2);
  }

  protected expiryOptions(leg: StrategyLeg): string[] {
    const isos = this.expiries().map((e) => e.iso);
    return isos.includes(leg.expiryIso) ? isos : [leg.expiryIso, ...isos];
  }

  protected strikeOptions(leg: StrategyLeg, picker: { strikes: number[]; ready: boolean }): number[] {
    if (!picker.ready) return [leg.strike];
    return picker.strikes.includes(leg.strike) ? picker.strikes : [...picker.strikes, leg.strike].sort((a, b) => a - b);
  }

  protected editLeg(leg: StrategyLeg, edit: LegEdit): void {
    if (this.busy()) return;
    this.view.set('edit');
    this.edit.emit({ id: leg.id, edit });
  }

  protected removeLeg(leg: StrategyLeg): void {
    if (!this.busy()) this.remove.emit(leg.id);
  }

  protected clear(): void {
    if (!this.busy()) this.clearAll.emit();
  }

  protected reset(): void {
    if (!this.busy()) this.resetPrices.emit();
  }

  protected back(): void {
    if (!this.busy()) this.view.set('edit');
  }

  protected setPrice(leg: StrategyLeg, e: Event): void {
    if (this.busy()) return;
    const el = e.target as HTMLInputElement;
    const price = Number(el.value);
    if (el.value.trim() === '' || !Number.isFinite(price) || price <= 0) {
      el.value = leg.price.toFixed(2);
      return;
    }
    // Kambala rejects off-tick limit prices: round to the contract's tick (the store rounds again on update).
    const onTick = roundToTick(price, leg.tickSize);
    el.value = onTick.toFixed(2);
    this.editLeg(leg, { price: onTick });
  }

  protected swapLeg(leg: StrategyLeg, change: Partial<Omit<LegSwap, 'id'>>): void {
    if (this.busy()) return;
    this.view.set('edit');
    this.swap.emit({ id: leg.id, expiryIso: leg.expiryIso, strike: leg.strike, type: leg.type, ...change });
  }

  /**
   * Expiry / strike picks. The select is put back to the leg's value at once: it changes only when the leg does
   * (the page may refuse the swap, e.g. "Already in your strategy").
   */
  protected pickExpiry(leg: StrategyLeg, e: Event): void {
    const el = e.target as HTMLSelectElement;
    const expiryIso = el.value;
    el.value = leg.expiryIso;
    this.swapLeg(leg, { expiryIso });
  }

  protected pickStrike(leg: StrategyLeg, e: Event): void {
    const el = e.target as HTMLSelectElement;
    const strike = Number(el.value);
    el.value = String(leg.strike);
    this.swapLeg(leg, { strike });
  }

  protected setLotMultiplier(n: number): void {
    if (this.busy()) return;
    this.view.set('edit');
    this.lotMultiplier.emit(n);
  }

  protected setProduct(p: Product): void {
    if (this.busy()) return;
    this.view.set('edit');
    this.product.emit(p);
  }

  protected openConfirm(): void {
    if (!this.cannotPlace()) this.view.set('confirm');
  }

  protected place(): void {
    if (this.cannotPlace()) return;
    this.requested.set(true);
    this.execute.emit();
  }

  /** The view's main control when it can take focus, else the next fallback, else the panel itself. */
  private focusInto(v: PanelView): void {
    const order = v === 'edit' ? [this.execBtn] : v === 'confirm' ? [this.placeBtn, this.confirmBack] : [this.resultList];
    const target = order.map((ref) => ref()?.nativeElement).find((n) => n && !n.matches(':disabled'));
    (target ?? this.panel().nativeElement).focus();
  }

  private moneyOf(field: 'margin' | 'hedgeBenefit'): string {
    const m = this.margin();
    if (m.status === 'loading') return '…';
    if (m.status === 'ready') return formatRupees(m[field]);
    return '—';
  }
}
