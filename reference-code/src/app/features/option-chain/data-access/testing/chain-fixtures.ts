import type { LinkedScripsResponse, OptionChainRow } from '../kambala/kambala.types';

/** 2026-10-29 11:30 IST. */
export const NOW_MS = Date.UTC(2026, 9, 29, 6, 0, 0);

/** NIFTY linked scrips: unsorted, one expired (27-Oct), one duplicate, one unparseable. */
export const NIFTY_LINKED: LinkedScripsResponse = {
  stat: 'Ok',
  opt_exp: [
    { exd: '17-NOV-2026', exch: 'NFO', tsym: 'NIFTY17NOV26P24000' },
    { exd: '03-Nov-2026', exch: 'NFO', tsym: 'NIFTY03NOV26P24000' },
    { exd: '27-OCT-2026', exch: 'NFO', tsym: 'NIFTY27OCT26P24000' },
    { exd: '10-NOV-2026', exch: 'NFO', tsym: 'NIFTY10NOV26P24000' },
    { exd: '03-NOV-2026', exch: 'NFO', tsym: 'NIFTY03NOV26C24000' },
    { exd: 'garbage', exch: 'NFO', tsym: 'NIFTYBAD' },
  ],
};

/** CE and PE rows for each strike. Tokens are tokenBase + 2i (CE) and tokenBase + 2i + 1 (PE). */
export function chainRows(
  prefix: string, exch: string, strikes: number[], tokenBase: number, ls = '75',
): OptionChainRow[] {
  const rows: OptionChainRow[] = [];
  strikes.forEach((k, i) => {
    for (const [optt, off] of [['CE', 0], ['PE', 1]] as const) {
      rows.push({
        exch, tsym: `${prefix}${optt === 'CE' ? 'C' : 'P'}${k}`, token: String(tokenBase + 2 * i + off),
        optt, strprc: k.toFixed(2), pp: '2', ti: '0.05', ls,
      });
    }
  });
  return rows;
}

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let k = from; k <= to; k += step) out.push(k);
  return out;
}
