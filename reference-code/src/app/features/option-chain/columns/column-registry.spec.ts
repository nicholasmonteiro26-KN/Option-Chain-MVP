import { describe, expect, it } from 'vitest';
import type { ContractRef } from '../data-access/models';
import type { RowVM } from '../view/chain-view-model';
import { COLUMNS, exactTitle, formatCell, GEX_TITLE, pricePrecision, signed } from './column-registry';

const col = (id: string) => COLUMNS[id]!;
const ref = (pp: number): ContractRef => ({ token: 'NFO|1', tsym: 'X', lotSize: 75, tickSize: 0.05, pricePrecision: pp });

describe('column registry formatting', () => {
  it('signed values that round to zero print as plain 0, never +0.00 or -0.00', () => {
    expect(signed(0, 2)).toBe('0.00');
    expect(signed(-0.001, 2)).toBe('0.00');
    expect(signed(0.004, 2)).toBe('0.00');
    expect(signed(-0, 1)).toBe('0.0');
    expect(signed(0.005001, 2)).toBe('+0.01');
    expect(signed(-1.236, 2)).toBe('-1.24');
    expect(col('chgPct').format(-0.0001)).toBe('0.00');
    expect(col('oiChg').format(-400)).toBe('0.00'); // -0.004 lakh
    expect(col('gexOiCr').format(0.04)).toBe('0.0');
    expect(col('strDecay').format(-0.001)).toBe('0.00');
  });

  it("price columns use the contract's price precision (default 2); others ignore it", () => {
    for (const id of ['bid', 'ask', 'ltp', 'ltpChg', 'open', 'high', 'low', 'straddle', 'straddleBid', 'straddleAsk']) {
      expect(col(id).format(12.5, 4)).toBe('12.5000');
      expect(col(id).format(12.5)).toBe('12.50');
      expect(col(id).format(12.5, 0)).toBe('13');
    }
    expect(col('chg').format(1.5, 3)).toBe('+1.500');
    expect(col('strDecay').format(-1.5, 1)).toBe('-1.5');
    expect(col('ltp').format(12.5, Number.NaN)).toBe('12.50'); // bad pp falls back to 2
    expect(col('chgPct').format(1.5, 4)).toBe('+1.50');
    expect(col('delta').format(0.5, 0)).toBe('0.5000');
  });

  it('pricePrecision / formatCell read the side leg, or for strike columns the CE then PE leg', () => {
    const row: RowVM = {
      strike: 100, s: { straddle: 3 } as RowVM['s'],
      ce: { ref: ref(3), quote: { ltp: 1.25 } as never, a: null },
      pe: { ref: ref(1), quote: { ltp: 2 } as never, a: null },
    };
    expect(pricePrecision(row, 'ce')).toBe(3);
    expect(pricePrecision(row, 'pe')).toBe(1);
    expect(pricePrecision(row)).toBe(3);
    expect(pricePrecision({ ...row, ce: null })).toBe(1);
    expect(pricePrecision({ ...row, ce: null, pe: null })).toBe(2);
    expect(formatCell(col('ltp'), row, 'ce')).toBe('1.250');
    expect(formatCell(col('ltp'), row, 'pe')).toBe('2.0');
    expect(formatCell(col('straddle'), row)).toBe('3.000');
  });

  it('OI, Volume, OI Chg and Cum OI carry an exact-value tooltip (en-IN grouped); GEX carries the convention', () => {
    for (const id of ['oi', 'volume', 'oiChg', 'cumOi']) expect(col(id).exact).toBe(true);
    expect(col('ltp').exact).toBeFalsy();
    expect(exactTitle(1234567)).toBe('12,34,567');
    expect(exactTitle(-25000)).toBe('-25,000');
    expect(col('gexOiCr').title).toBe(GEX_TITLE);
    expect(col('gexVolCr').title).toBe(GEX_TITLE);
    expect(GEX_TITLE).toBe(
      'Dealer gamma exposure in ₹ crore per 1% move. Convention: dealers long calls, short puts; indicative only.',
    );
  });
});
