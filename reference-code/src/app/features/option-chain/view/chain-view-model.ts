import type { ChainAnalytics, LegAnalytics, LegQuote, StrikeAnalytics } from '@option-analytics/index';
import { nearestStrikeIndex } from '@option-analytics/strikes';
import { ColumnDef, COLUMNS } from '../columns/column-registry';
import { PRESETS } from '../columns/presets';
import type { ChainMeta, ContractRef } from '../data-access/models';
import { spotSlot as computeSpotSlot } from './spot-slot';

export interface LegVM { ref: ContractRef; quote: LegQuote | null; a: LegAnalytics | null }
export interface RowVM { strike: number; ce: LegVM | null; pe: LegVM | null; s: StrikeAnalytics | null }

export interface ChainViewModel {
  columns: ColumnDef[];
  mode: 'mirrored' | 'strike';
  rows: RowVM[];
  spotSlot: number | null;
  sums: Record<string, { ce: number; pe: number; total: number }>;
  maxOi: { ce: number; pe: number; cum: number };
}

export interface BuildArgs {
  meta: ChainMeta;
  quotes: Map<string, LegQuote>;
  analytics: ChainAnalytics | null;
  spot: number;
  presetId: string;
  customColumns: string[];
  strikeCount: number | 'all';
  prevSlot: number | null;
  hysteresis: number;
}

function resolveColumns(
  presetId: string, customColumns: string[],
): { mode: 'mirrored' | 'strike'; columns: ColumnDef[] } {
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;
  let ids = preset.columns;
  if (preset.id === 'custom') {
    ids = customColumns.filter((c) => COLUMNS[c]);
    if (ids.length === 0) ids = ['ltp'];
  }
  return { mode: preset.mode, columns: ids.map((id) => COLUMNS[id] as ColumnDef) };
}

function centreIndex(strikes: number[], analytics: ChainAnalytics | null, spot: number): number {
  if (analytics && analytics.atmStrike !== 0) {
    const i = strikes.indexOf(analytics.atmStrike);
    if (i >= 0) return i;
  }
  return Math.max(0, nearestStrikeIndex(strikes, spot)); // ties keep the lower strike
}

export function buildViewModel(args: BuildArgs): ChainViewModel {
  const { meta, quotes, analytics } = args;
  const { mode, columns } = resolveColumns(args.presetId, args.customColumns);
  const all = meta.strikes;
  const strikeNums = all.map((s) => s.strike);

  // The spot line sits directly after the slot row, so centring the window on the slot keeps the line mid-window
  // (floor(n/2) rows at or below the slot, the rest above). It does not depend on analytics, so the first render
  // and the post-analytics render show the same rows.
  const slot = strikeNums.length === 0
    ? null
    : computeSpotSlot(args.prevSlot, args.spot, strikeNums, meta.strikeStep, args.hysteresis);

  let start = 0;
  let end = all.length;
  if (args.strikeCount !== 'all' && all.length > args.strikeCount) {
    const n = Math.max(1, args.strikeCount);
    const slotIdx = slot === null ? -1 : strikeNums.indexOf(slot);
    const first = slotIdx >= 0
      ? slotIdx - Math.floor(n / 2) + 1
      : centreIndex(strikeNums, analytics, args.spot) - Math.floor(n / 2);
    start = Math.min(Math.max(0, first), all.length - n);
    end = start + n;
  }

  const byStrike = new Map<number, StrikeAnalytics>();
  for (const s of analytics?.strikes ?? []) byStrike.set(s.strike, s);
  const leg = (r: ContractRef | null): LegVM | null =>
    r ? { ref: r, quote: quotes.get(r.token) ?? null, a: analytics?.legs[r.token] ?? null } : null;

  const rows: RowVM[] = all.slice(start, end).map((s) => ({
    strike: s.strike, ce: leg(s.ce), pe: leg(s.pe), s: byStrike.get(s.strike) ?? null,
  }));

  const sums: ChainViewModel['sums'] = {};
  for (const col of columns) {
    if (!col.sum) continue;
    const add = (r: RowVM, side?: 'ce' | 'pe'): number => {
      const v = col.value(r, side);
      return typeof v === 'number' ? v : 0;
    };
    if (col.scope === 'strike') {
      sums[col.id] = { ce: 0, pe: 0, total: rows.reduce((t, r) => t + add(r), 0) };
    } else {
      const ce = rows.reduce((t, r) => t + add(r, 'ce'), 0);
      const pe = rows.reduce((t, r) => t + add(r, 'pe'), 0);
      sums[col.id] = { ce, pe, total: ce + pe };
    }
  }

  const maxOi = { ce: 0, pe: 0, cum: 0 };
  for (const r of rows) {
    maxOi.ce = Math.max(maxOi.ce, r.ce?.quote?.oi ?? 0);
    maxOi.pe = Math.max(maxOi.pe, r.pe?.quote?.oi ?? 0);
    maxOi.cum = Math.max(maxOi.cum, r.s?.cumOi ?? 0);
  }

  return { columns, mode, rows, spotSlot: slot, sums, maxOi };
}
