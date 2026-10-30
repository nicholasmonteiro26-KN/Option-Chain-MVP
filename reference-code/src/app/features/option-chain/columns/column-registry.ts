import type { LegAnalytics, LegQuote, OiSense, StrikeAnalytics } from '@option-analytics/index';
import type { RowVM } from '../view/chain-view-model';

export interface ColumnDef {
  id: string;
  label: string;
  scope: 'side' | 'strike';
  value(row: RowVM, side?: 'ce' | 'pe'): number | string | null;
  /**
   * Takes the raw value; percentage / lakh scaling happens here. `pp` is the contract's price precision, used by
   * price columns (default 2); other columns ignore it.
   */
  format(v: number | string | null, pp?: number): string;
  sum?: boolean;
  bar?: 'oi' | 'cumOi';
  flash?: boolean;
  customisable: boolean;
  /** Id of a column rendered as a sub-line under this one. */
  sub?: string;
  /** Cells carry the exact value as a tooltip (OI and volume are shown rounded to lakhs). */
  exact?: boolean;
  /** Tooltip of the header and every cell (e.g. the GEX sign convention). */
  title?: string;
}

/** Price precision when a contract does not say (Kambala `pp`). */
export const DEFAULT_PRICE_PRECISION = 2;

export const GEX_TITLE =
  'Dealer gamma exposure in ₹ crore per 1% move. Convention: dealers long calls, short puts; indicative only.';

const DASH = '–';
const LAKH = 1e5;

type Fmt = (v: number | string | null, pp?: number) => string;
const num = (f: (n: number, pp?: number) => string): Fmt => (v, pp) =>
  (typeof v === 'number' && Number.isFinite(v) ? f(v, pp) : DASH);
/** Sign-prefixed; a value that rounds to zero is plain "0.00" (never "+0.00" or "-0.00"). */
export const signed = (n: number, d: number): string => {
  const s = n.toFixed(d);
  return Number(s) === 0 ? (0).toFixed(d) : (n > 0 ? '+' : '') + s;
};
const ppOf = (pp: number | undefined): number =>
  pp !== undefined && Number.isInteger(pp) && pp >= 0 && pp <= 8 ? pp : DEFAULT_PRICE_PRECISION;
const price: Fmt = num((n, pp) => n.toFixed(ppOf(pp)));
const signedPrice: Fmt = num((n, pp) => signed(n, ppOf(pp)));

const fixed = (d: number): Fmt => num((n) => n.toFixed(d));
const signedFmt = (d: number): Fmt => num((n) => signed(n, d));
const lakh: Fmt = num((n) => (n / LAKH).toFixed(2));
const pct100 = (d: number, suffix = ''): Fmt => num((n) => (n * 100).toFixed(d) + suffix);

const SENSE_LABEL: Record<OiSense, string> = {
  LONG_BUILD_UP: 'Long Build Up',
  SHORT_BUILD_UP: 'Short Build Up',
  SHORT_COVERING: 'Short Covering',
  LONG_UNWINDING: 'Long Unwinding',
  NEUTRAL: '—',
};
const senseFmt: Fmt = (v) => (typeof v === 'string' ? (SENSE_LABEL[v as OiSense] ?? DASH) : DASH);

const q = (row: RowVM, side?: 'ce' | 'pe'): LegQuote | null => (side ? (row[side]?.quote ?? null) : null);
const a = (row: RowVM, side?: 'ce' | 'pe'): LegAnalytics | null => (side ? (row[side]?.a ?? null) : null);

function sideQ(
  id: string, label: string, get: (x: LegQuote) => number | null, format: Fmt, extra: Partial<ColumnDef> = {},
): ColumnDef {
  return {
    id, label, scope: 'side', value: (r, s) => { const x = q(r, s); return x ? get(x) : null; },
    format, customisable: true, ...extra,
  };
}
function sideA(
  id: string, label: string, get: (x: LegAnalytics) => number | string | null, format: Fmt,
  extra: Partial<ColumnDef> = {},
): ColumnDef {
  return {
    id, label, scope: 'side', value: (r, s) => { const x = a(r, s); return x ? get(x) : null; },
    format, customisable: true, ...extra,
  };
}
function strikeCol(
  id: string, label: string, get: (x: StrikeAnalytics) => number | null, format: Fmt, extra: Partial<ColumnDef> = {},
): ColumnDef {
  return { id, label, scope: 'strike', value: (r) => (r.s ? get(r.s) : null), format, customisable: true, ...extra };
}

const chgOf = (x: LegQuote): number | null => (x.ltp === null || x.prevClose === null ? null : x.ltp - x.prevClose);
const chgPctOf = (x: LegQuote): number | null => {
  const c = chgOf(x);
  return c === null || !x.prevClose ? null : (c / x.prevClose) * 100;
};

const DEFS: ColumnDef[] = [
  sideQ('volume', 'Volume', (x) => x.volume, lakh, { sum: true, exact: true }),
  sideQ('oi', 'OI', (x) => x.oi, lakh, { sum: true, bar: 'oi', exact: true }),
  sideA('oiChg', 'OI Chg', (x) => x.oiChg, num((n) => signed(n / LAKH, 2)), { sum: true, exact: true }),
  sideA('oiChgPct', 'OI Chg %', (x) => x.oiChgPct, signedFmt(2)),
  sideA('oiSense', 'OI Sense', (x) => x.sense, senseFmt),
  sideQ('bid', 'Bid', (x) => x.bid, price),
  sideQ('ask', 'Ask', (x) => x.ask, price),
  sideQ('ltp', 'LTP', (x) => x.ltp, price, { flash: true }),
  sideQ('ltpChg', 'LTP', (x) => x.ltp, price, { flash: true, sub: 'chgPct', customisable: false }),
  sideQ('chg', 'Chg', chgOf, signedPrice),
  sideQ('chgPct', 'Chg %', chgPctOf, signedFmt(2)),
  sideQ('open', 'Open', (x) => x.open, price),
  sideQ('high', 'High', (x) => x.high, price),
  sideQ('low', 'Low', (x) => x.low, price),
  sideA('iv', 'IV', (x) => x.iv, pct100(2)),
  sideA('delta', 'Delta', (x) => x.delta, fixed(4)),
  sideA('gamma', 'Gamma', (x) => x.gamma, fixed(4)),
  sideA('theta', 'Theta', (x) => x.theta, fixed(2)),
  sideA('vega', 'Vega', (x) => x.vega, fixed(2)),
  sideA('itmProb', 'ITM Prob', (x) => x.itmProb, pct100(1, '%')),
  strikeCol('straddle', 'Straddle', (x) => x.straddle, price),
  strikeCol('straddleBid', 'Straddle Bid', (x) => x.straddleBid, price),
  strikeCol('straddleAsk', 'Straddle Ask', (x) => x.straddleAsk, price),
  strikeCol('strDecay', 'Str Decay', (x) => x.strDecay, signedPrice),
  strikeCol('cumOi', 'Cum OI', (x) => x.cumOi, lakh, { sum: true, bar: 'cumOi', exact: true }),
  strikeCol('avgIv', 'Avg IV', (x) => x.avgIv, pct100(2)),
  strikeCol('pcrOi', 'PCR (OI)', (x) => x.pcrOi, fixed(2)),
  strikeCol('pcrVol', 'PCR (Vol)', (x) => x.pcrVol, fixed(2)),
  strikeCol('painCr', 'Pain', (x) => x.painCr, fixed(0)),
  strikeCol('gexOiCr', 'GEX-OI', (x) => x.gexOiCr, signedFmt(1), { title: GEX_TITLE }),
  strikeCol('gexVolCr', 'GEX-Vol', (x) => x.gexVolCr, signedFmt(1), { title: GEX_TITLE }),
];

export const COLUMNS: Record<string, ColumnDef> = Object.fromEntries(DEFS.map((d) => [d.id, d]));

/** Price precision of a cell's contract: the side's leg, or for a strike column the CE (else PE) leg. */
export function pricePrecision(row: RowVM, side?: 'ce' | 'pe'): number {
  const leg = side ? row[side] : (row.ce ?? row.pe);
  return leg?.ref.pricePrecision ?? DEFAULT_PRICE_PRECISION;
}

/** A cell's text exactly as the table shows it (the CSV uses the same). */
export function formatCell(col: ColumnDef, row: RowVM, side?: 'ce' | 'pe'): string {
  return col.format(col.value(row, side), pricePrecision(row, side));
}

/** Exact value for a tooltip, grouped the Indian way (12,34,567). */
export function exactTitle(v: number): string {
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
