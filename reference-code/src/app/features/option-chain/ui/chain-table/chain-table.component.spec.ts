import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { analyzeChain, ChainAnalytics, LegQuote, OptType } from '@option-analytics/index';
import { sampleChain, SAMPLE_LOT, SAMPLE_SPOT, sampleToken } from '@option-analytics/testing/sample-chain';
import { ChainMeta, ContractRef, QUICK_UNDERLYINGS } from '../../data-access/models';
import { buildViewModel, ChainViewModel } from '../../view/chain-view-model';
import { GEX_TITLE } from '../../columns/column-registry';
import { ChainTableComponent, TradeEvent } from './chain-table.component';

type Patch = { strike: number; type: OptType; patch: Partial<LegQuote> };

function makeVm(presetId = 'default', patches: Patch[] = [], strikeCount: number | 'all' = 'all'): ChainViewModel {
  const input = sampleChain();
  for (const p of patches) {
    const row = input.strikes.find((s) => s.strike === p.strike)!;
    const key = p.type === 'CE' ? 'ce' : 'pe';
    row[key] = { ...row[key]!, ...p.patch };
  }
  const analytics: ChainAnalytics = analyzeChain(input);
  const ref = (type: OptType, strike: number): ContractRef => ({
    token: sampleToken(type, strike), tsym: `NIFTY03NOV26${type === 'CE' ? 'C' : 'P'}${strike}`,
    lotSize: SAMPLE_LOT, tickSize: 0.05, pricePrecision: 2,
  });
  const meta: ChainMeta = {
    underlying: QUICK_UNDERLYINGS[0]!,
    expiry: { iso: '2026-11-03', exd: '03-NOV-2026', sampleTsym: 'X', foExch: 'NFO' },
    strikes: input.strikes.map((s) => ({ strike: s.strike, ce: ref('CE', s.strike), pe: ref('PE', s.strike) })),
    strikeStep: 50,
  };
  const quotes = new Map<string, LegQuote>();
  for (const s of input.strikes) {
    if (s.ce) quotes.set(s.ce.token, s.ce);
    if (s.pe) quotes.set(s.pe.token, s.pe);
  }
  return buildViewModel({
    meta, quotes, analytics, spot: SAMPLE_SPOT, presetId, customColumns: [], strikeCount, prevSlot: null, hysteresis: 0.1,
  });
}

function setup(vm: ChainViewModel, inputs: Record<string, unknown> = {}): ComponentFixture<ChainTableComponent> {
  TestBed.configureTestingModule({ imports: [ChainTableComponent] });
  const fixture = TestBed.createComponent(ChainTableComponent);
  fixture.componentRef.setInput('vm', vm);
  fixture.componentRef.setInput('spot', SAMPLE_SPOT);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return fixture;
}

const el = (f: ComponentFixture<unknown>): HTMLElement => f.nativeElement as HTMLElement;
const text = (n: Element | null | undefined): string => (n?.textContent ?? '').trim();
function strikeRow(f: ComponentFixture<unknown>, strike: number): HTMLTableRowElement {
  const row = Array.from(el(f).querySelectorAll<HTMLTableRowElement>('tbody tr:not(.spot)'))
    .find((r) => text(r.querySelector('td.k')) === String(strike));
  if (!row) throw new Error(`no row ${strike}`);
  return row;
}
/** A cell's main value, without the hover B/S buttons or the sub-line. */
function val(c: Element): string {
  const k = c.cloneNode(true) as Element;
  k.querySelectorAll('.acts, .sub').forEach((n) => n.remove());
  return text(k);
}
const tds = (r: HTMLTableRowElement): HTMLTableCellElement[] => Array.from(r.querySelectorAll('td'));

describe('ChainTableComponent mirrored', () => {
  it('renders Volume OI Bid Ask LTP | Strike | LTP Ask Bid OI Volume for the Default preset', () => {
    const f = setup(makeVm());
    const heads = Array.from(el(f).querySelectorAll('thead tr:nth-child(2) th')).map(text).filter(Boolean);
    expect(heads).toEqual(['Volume', 'OI', 'Bid', 'Ask', 'LTP', 'Strike', 'LTP', 'Ask', 'Bid', 'OI', 'Volume']);
    const top = Array.from(el(f).querySelectorAll('thead tr:first-child th')).map(text);
    expect(top).toEqual(['Calls', '', 'Puts']);
  });

  it('renders PE cells in reverse column order', () => {
    const vm = makeVm('default');
    const f = setup(vm);
    const row = strikeRow(f, 25000);
    const cells = tds(row);
    // chk, 5 CE, strike, 5 PE, chk
    expect(cells.length).toBe(13);
    const q = (t: OptType): LegQuote => sampleChain().strikes.find((s) => s.strike === 25000)![t === 'CE' ? 'ce' : 'pe']!;
    const lakh = (n: number): string => (n / 1e5).toFixed(2);
    expect(val(cells[1]!)).toBe(lakh(q('CE').volume));
    expect(val(cells[2]!)).toBe(lakh(q('CE').oi));
    expect(val(cells[10]!)).toBe(lakh(q('PE').oi));
    expect(val(cells[11]!)).toBe(lakh(q('PE').volume));
  });

  it('inserts the spot line directly after the slot row with the formatted spot', () => {
    const vm = makeVm();
    expect(vm.spotSlot).toBe(24950);
    const f = setup(vm);
    const spot = el(f).querySelector('tr.spot');
    expect(spot).not.toBeNull();
    expect(strikeRow(f, 24950).nextElementSibling).toBe(spot);
    expect(text(spot!.querySelector('.pill'))).toBe(
      SAMPLE_SPOT.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    );
    expect(spot!.querySelectorAll('td').length).toBe(3);
    expect(spot!.querySelectorAll('td')[1]!.querySelector('.pill')).not.toBeNull();
  });

  it('has no spot line when spotSlot is null or not among the visible rows', () => {
    expect(el(setup(makeVm())).querySelectorAll('tr.spot').length).toBe(1);
    TestBed.resetTestingModule();
    const none = setup({ ...makeVm(), spotSlot: null });
    expect(el(none).querySelector('tr.spot')).toBeNull();
    TestBed.resetTestingModule();
    const off = setup({ ...makeVm(), spotSlot: 99999 });
    expect(el(off).querySelector('tr.spot')).toBeNull();
  });

  it('draws the CE OI bar with a width of oi / maxOi.ce', () => {
    const vm = makeVm();
    const f = setup(vm);
    const row = vm.rows.find((r) => r.strike === 25100)!;
    const cell = tds(strikeRow(f, 25100))[2]!;
    expect(cell.classList.contains('bar')).toBe(true);
    expect(cell.classList.contains('ce')).toBe(true);
    const pct = ((row.ce!.quote!.oi / vm.maxOi.ce) * 100).toFixed(1);
    expect(cell.getAttribute('style')).toContain(`background-size: ${pct}% 70%`);
    const pe = tds(strikeRow(f, 25100))[10]!;
    expect(pe.classList.contains('pe')).toBe(true);
    expect(pe.getAttribute('style')).toContain(`${((row.pe!.quote!.oi / vm.maxOi.pe) * 100).toFixed(1)}% 70%`);
  });

  it('shades ITM calls below spot and ITM puts above spot', () => {
    const f = setup(makeVm());
    const below = tds(strikeRow(f, 24950));
    expect(below[1]!.classList.contains('itm')).toBe(true);
    expect(below[11]!.classList.contains('itm')).toBe(false);
    const above = tds(strikeRow(f, 25000));
    expect(above[1]!.classList.contains('itm')).toBe(false);
    expect(above[11]!.classList.contains('itm')).toBe(true);
    expect(below[6]!.classList.contains('itm')).toBe(false);
  });

  it('emits trade when the CE B is clicked', () => {
    const f = setup(makeVm());
    const out: unknown[] = [];
    f.componentInstance.trade.subscribe((e) => out.push(e));
    const row = tds(strikeRow(f, 25000));
    row[1]!.querySelector<HTMLButtonElement>('.acts .b')!.click();
    expect(out.length).toBe(1);
    const ev = out[0] as { side: string; token: string; tsym: string; lotSize: number; ltp: number };
    expect(ev).toMatchObject({ side: 'BUY', token: 'CE25000', tsym: 'NIFTY03NOV26C25000', lotSize: 65 });
    expect(ev.ltp).toBeGreaterThan(0);
    row[11]!.querySelector<HTMLButtonElement>('.acts .s')!.click();
    expect(out[1]).toMatchObject({ side: 'SELL', token: 'PE25000' });
    const b = row[1]!.querySelector<HTMLButtonElement>('.acts .b')!;
    b.focus();
    expect(document.activeElement).toBe(b);
    expect(b.tabIndex).toBe(0);
    expect(b.getAttribute('aria-label')).toBe('Buy 25000 CE');
    expect(row[1]!.querySelector('.acts .s')!.getAttribute('aria-label')).toBe('Sell 25000 CE');
    expect(row[11]!.querySelector('.acts .s')!.getAttribute('aria-label')).toBe('Sell 25000 PE');
    // B/S only on the outermost cell of each side
    expect(el(f).querySelectorAll('tbody tr:not(.spot):first-child .acts').length).toBe(2);
  });

  it('marks only the outermost cell of each side as the B/S positioning context (acts-host)', () => {
    const f = setup(makeVm());
    const row = tds(strikeRow(f, 25000));
    const hosts = row.map((td, i) => (td.classList.contains('acts-host') ? i : -1)).filter((i) => i >= 0);
    expect(hosts).toEqual([1, 11]);
  });

  it('hides B/S when the leg has no ltp', () => {
    const f = setup(makeVm('default', [{ strike: 25100, type: 'CE', patch: { ltp: null } }]));
    const row = tds(strikeRow(f, 25100));
    expect(row[1]!.querySelector('.acts')).toBeNull();
    expect(row[11]!.querySelector('.acts')).not.toBeNull();
  });

  it('shows a dash with the reason in the title for a null IV, and italicises low-confidence IV', () => {
    const vm = makeVm('greeks', [
      { strike: 24800, type: 'PE', patch: { bid: 0, ask: 0, volume: 0 } },
      { strike: 25500, type: 'CE', patch: { bid: null, ask: null, ltp: 0.3, volume: 10 } },
    ]);
    const f = setup(vm);
    // greeks: iv is the outermost column; PE iv is the last data cell
    const pe = tds(strikeRow(f, 24800)).at(-2)!;
    expect(val(pe)).toBe('–');
    expect(pe.getAttribute('title')).toBe('No two-sided quote and no trades today');
    const low = tds(strikeRow(f, 25500))[1]!;
    expect(low.classList.contains('low-conf')).toBe(true);
    expect(low.getAttribute('title')).toBe('Low confidence: price within a few ticks, or under 1 hour to expiry');
    const ok = tds(strikeRow(f, 25000))[1]!;
    expect(ok.classList.contains('low-conf')).toBe(false);
  });

  it('dims the cells of a stale leg only', () => {
    const f = setup(makeVm(), { stale: new Set(['CE25000']) });
    const row = tds(strikeRow(f, 25000));
    expect(row[1]!.classList.contains('stale')).toBe(true);
    expect(row[5]!.classList.contains('stale')).toBe(true);
    expect(row[7]!.classList.contains('stale')).toBe(false);
    expect(row[11]!.classList.contains('stale')).toBe(false);
  });

  it('renders placeholder rows with no numbers and no spot line or sigma row while loading', () => {
    const f = setup(makeVm(), { loading: true });
    const rows = el(f).querySelectorAll('tbody tr');
    expect(rows.length).toBe(10);
    expect(rows[0]!.classList.contains('skel')).toBe(true);
    expect(/\d/.test(text(el(f).querySelector('tbody')))).toBe(false);
    expect(el(f).querySelector('tr.spot')).toBeNull();
    expect(el(f).querySelector('tfoot')).toBeNull();
  });

  it('shows the sums in the Σ row for columns with sum', () => {
    const vm = makeVm();
    const f = setup(vm);
    const cells = Array.from(el(f).querySelectorAll('tfoot td')).map(text);
    // empty, volume, oi, bid, ask, ltp, Σ, ltp, ask, bid, oi, volume, empty
    expect(cells.length).toBe(13);
    expect(cells[2]).toBe((vm.sums['oi']!.ce / 1e5).toFixed(2));
    expect(cells[1]).toBe((vm.sums['volume']!.ce / 1e5).toFixed(2));
    expect(cells[6]).toBe('Σ');
    expect(cells[10]).toBe((vm.sums['oi']!.pe / 1e5).toFixed(2));
    expect(cells[3]).toBe('');
  });

  it('reflects checked tokens and emits toggleCheck', () => {
    const f = setup(makeVm(), { checked: new Set(['PE25000']) });
    const out: string[] = [];
    f.componentInstance.toggleCheck.subscribe((t) => out.push(t));
    const row = tds(strikeRow(f, 25000));
    const ce = row[0]!.querySelector('input')!;
    const pe = row[12]!.querySelector('input')!;
    expect(ce.checked).toBe(false);
    expect(pe.checked).toBe(true);
    expect(ce.getAttribute('aria-label')).toBe('Select 25000 CE');
    ce.click();
    expect(out).toEqual(['CE25000']);
  });

  it('colours signed columns and uses the sub-line for change %', () => {
    const f = setup(makeVm());
    const ceLtp = tds(strikeRow(f, 25000))[5]!;
    const sub = ceLtp.querySelector('.sub')!;
    expect(sub).not.toBeNull();
    // CE prevClose is above ltp, so change is negative; PE prevClose below ltp, so positive
    expect(sub.classList.contains('neg')).toBe(true);
    expect(tds(strikeRow(f, 25000))[7]!.querySelector('.sub')!.classList.contains('pos')).toBe(true);
  });
});

describe('ChainTableComponent: payloads and tooltips', () => {
  /** makeVm with the 25000 CE leg's contract ref patched. */
  function withCeRef(vm: ChainViewModel, patch: Partial<ContractRef>): ChainViewModel {
    return {
      ...vm,
      rows: vm.rows.map((r) => (r.strike === 25000 && r.ce ? { ...r, ce: { ...r.ce, ref: { ...r.ce.ref, ...patch } } } : r)),
    };
  }

  it('the trade payload carries exch and the raw Kambala token besides the feed key', () => {
    const f = setup(withCeRef(makeVm(), { token: 'NFO|43651' }));
    const out: TradeEvent[] = [];
    f.componentInstance.trade.subscribe((e) => out.push(e));
    tds(strikeRow(f, 25000))[1]!.querySelector<HTMLButtonElement>('.acts .b')!.click();
    expect(out[0]).toMatchObject({ token: 'NFO|43651', exch: 'NFO', rawToken: '43651', side: 'BUY', lotSize: 65 });
  });

  it("prices show the contract's price precision (pp)", () => {
    const f = setup(withCeRef(makeVm(), { pricePrecision: 4 }));
    const row = tds(strikeRow(f, 25000));
    expect(val(row[5]!)).toMatch(/^\d+\.\d{4}$/); // CE LTP, pp 4
    expect(val(row[7]!)).toMatch(/^\d+\.\d{2}$/); // PE LTP, pp 2
  });

  it('OI and Volume cells carry the exact value, en-IN grouped, as a tooltip', () => {
    const vm = makeVm();
    const f = setup(vm);
    const row = tds(strikeRow(f, 25000));
    const oi = vm.rows.find((r) => r.strike === 25000)!.ce!.quote!.oi;
    expect(row[2]!.getAttribute('title')).toBe(oi.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
    expect(row[1]!.getAttribute('title')).toMatch(/^[\d,]+$/); // Volume
    expect(row[5]!.getAttribute('title')).toBeNull(); // LTP: no tooltip
  });

  it('GEX headers and cells carry the sign-convention tooltip; Cum OI cells the exact value', () => {
    const vm = makeVm('stats');
    const f = setup(vm);
    const gexIdx = vm.columns.findIndex((c) => c.id === 'gexOiCr');
    const heads = Array.from(el(f).querySelectorAll('thead th'));
    expect(heads[gexIdx + 1]!.getAttribute('title')).toBe(GEX_TITLE);
    const cells = tds(strikeRow(f, 25000));
    expect(cells[gexIdx + 1]!.getAttribute('title')).toBe(GEX_TITLE);
    const cumIdx = vm.columns.findIndex((c) => c.id === 'cumOi');
    const cum = vm.rows.find((r) => r.strike === 25000)!.s!.cumOi;
    expect(cum).toBeGreaterThan(100000);
    expect(cells[cumIdx + 1]!.getAttribute('title')).toBe(cum.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
  });
});

describe('ChainTableComponent strike mode', () => {
  it('has Strike first, no checkboxes or B/S, Cum OI bar and a total Σ', () => {
    const vm = makeVm('stats');
    const f = setup(vm);
    const heads = Array.from(el(f).querySelectorAll('thead th')).map(text);
    expect(heads[0]).toBe('Strike');
    expect(el(f).querySelector('input[type=checkbox]')).toBeNull();
    expect(el(f).querySelector('.acts')).toBeNull();
    const cells = tds(strikeRow(f, 25000));
    expect(cells.length).toBe(1 + vm.columns.length);
    const cumIdx = vm.columns.findIndex((c) => c.id === 'cumOi') + 1;
    expect(cells[cumIdx]!.classList.contains('bar')).toBe(true);
    expect(cells[cumIdx]!.classList.contains('cum')).toBe(true);
    const foot = Array.from(el(f).querySelectorAll('tfoot td')).map(text);
    expect(foot[0]).toBe('Σ');
    expect(foot[cumIdx]).toBe((vm.sums['cumOi']!.total / 1e5).toFixed(2));
    const spot = el(f).querySelector('tr.spot')!;
    expect(spot.querySelectorAll('td').length).toBe(2);
    expect(strikeRow(f, 24950).nextElementSibling).toBe(spot);
  });
});
