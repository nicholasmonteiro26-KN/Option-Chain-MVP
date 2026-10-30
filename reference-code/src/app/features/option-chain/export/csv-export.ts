import { ColumnDef, formatCell } from '../columns/column-registry';
import type { ChainViewModel, RowVM } from '../view/chain-view-model';

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const pad = (n: number): string => String(n).padStart(2, '0');
/** UTF-8 byte-order mark: Excel then opens the file as UTF-8, so the dash and other non-ASCII text survive. */
export const CSV_BOM = '﻿';

function cell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV of the visible view with the same formatting as the screen (prices to each contract's precision). */
export function toCsv(
  vm: ChainViewModel,
  header: { underlying: string; expiry: string; at: Date },
): { filename: string; content: string } {
  const ist = new Date(header.at.getTime() + IST_OFFSET_MS); // fixed +05:30, read via UTC getters
  const hhmm = pad(ist.getUTCHours()) + pad(ist.getUTCMinutes());
  const filename = `optionchain_${header.underlying}_${header.expiry.replace(/-/g, '')}_${hhmm}.csv`;

  const cols = vm.columns;
  const mirrored = [...cols].reverse();
  const fmt = (c: ColumnDef, r: RowVM, side?: 'ce' | 'pe'): string => cell(formatCell(c, r, side));

  const head: string[] = vm.mode === 'mirrored'
    ? [...cols.map((c) => `CE ${c.label}`), 'Strike', ...mirrored.map((c) => `PE ${c.label}`)]
    : ['Strike', ...cols.map((c) => c.label)];

  const lines = [
    `# ${header.underlying} ${header.expiry} ${header.at.toISOString()}`,
    head.map(cell).join(','),
    ...vm.rows.map((r) =>
      (vm.mode === 'mirrored'
        ? [...cols.map((c) => fmt(c, r, 'ce')), String(r.strike), ...mirrored.map((c) => fmt(c, r, 'pe'))]
        : [String(r.strike), ...cols.map((c) => fmt(c, r))]
      ).join(','),
    ),
  ];
  return { filename, content: CSV_BOM + lines.join('\n') + '\n' };
}
