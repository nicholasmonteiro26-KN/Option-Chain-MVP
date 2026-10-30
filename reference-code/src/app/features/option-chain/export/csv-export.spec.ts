import { describe, expect, it, vi } from 'vitest';
import { CSV_BOM, toCsv } from './csv-export';
import { ColumnDef, COLUMNS } from '../columns/column-registry';
import { ChainViewModel, RowVM } from '../view/chain-view-model';

const ref = (t: string) => ({ token: t, tsym: t, lotSize: 75, tickSize: 0.05, pricePrecision: 2 });
const q = (ltp: number | null) => ({
  token: 't', type: 'CE' as const, strike: 100, lotSize: 75, tickSize: 0.05, ltp, bid: null, ask: null,
  bidQty: 0, askQty: 0, volume: 0, oi: 0, prevOi: 0, prevClose: null, open: null, high: null, low: null, lastTickMs: 0,
});
const leg = (t: string, ltp: number | null, a: RowVM['ce'] extends infer L ? L extends { a: infer A } ? A : never : never) =>
  ({ ref: ref(t), quote: q(ltp), a });
const laIv = (iv: number | null) => ({
  token: 't', iv, ivStatus: 'OK' as const, ivSource: null, lowConfidence: false, delta: null, gamma: null,
  theta: null, vega: null, itmProb: null, oiChg: 0, oiChgPct: null, sense: 'NEUTRAL' as const,
});

function vm(mode: 'mirrored' | 'strike', cols: string[], rows: RowVM[]): ChainViewModel {
  return {
    columns: cols.map((c) => COLUMNS[c] as ColumnDef), mode, rows, spotSlot: 100, sums: {},
    maxOi: { ce: 0, pe: 0, cum: 0 },
  };
}
const HDR = { underlying: 'NIFTY', expiry: '2026-11-03', at: new Date('2026-10-29T14:05:00+05:30') };

describe('toCsv', () => {
  const rows: RowVM[] = [
    { strike: 100, ce: leg('c', 1.5, laIv(null)), pe: leg('p', 2, laIv(0.1234)), s: null },
  ];

  it('builds filename, first line, and a mirrored header', () => {
    const { filename, content } = toCsv(vm('mirrored', ['iv', 'ltp'], rows), HDR);
    expect(filename).toBe('optionchain_NIFTY_20261103_1405.csv');
    const lines = content.split('\n');
    expect(lines[0]).toBe(`${CSV_BOM}# NIFTY 2026-11-03 2026-10-29T08:35:00.000Z`);
    expect(lines[1]).toBe('CE IV,CE LTP,Strike,PE LTP,PE IV');
    expect(lines[2]).toBe('–,1.50,100,2.00,12.34');
  });

  it('starts with a UTF-8 byte-order mark, so Excel reads it as UTF-8', () => {
    const { content } = toCsv(vm('mirrored', ['ltp'], rows), HDR);
    expect(CSV_BOM).toBe('﻿');
    expect(content.charCodeAt(0)).toBe(0xfeff);
    expect(content.indexOf('﻿', 1)).toBe(-1); // once only
  });

  it("prices use the contract's price precision (pp), default 2", () => {
    const pp4 = { ...leg('c', 1.5, laIv(null)), ref: { ...ref('c'), pricePrecision: 4 } };
    const r: RowVM[] = [{ strike: 100, ce: pp4, pe: leg('p', 2, laIv(0.1234)), s: null }];
    const lines = toCsv(vm('mirrored', ['ltp'], r), HDR).content.split('\n');
    expect(lines[2]).toBe('1.5000,100,2.00');
  });

  it('strike mode: Strike then labels, same formats', () => {
    const s = { strike: 100, straddle: 12.5, straddleBid: null, straddleAsk: null, strDecay: null, strDecayPct: null,
      cumOi: 250000, avgIv: 0.15, pcrOi: null, pcrVol: null, painCr: null, gexOiCr: 0, gexVolCr: 0 };
    const { content } = toCsv(vm('strike', ['straddle', 'cumOi', 'pcrOi'], [{ strike: 100, ce: null, pe: null, s }]), HDR);
    const lines = content.split('\n');
    expect(lines[1]).toBe('Strike,Straddle,Cum OI,PCR (OI)');
    expect(lines[2]).toBe('100,12.50,2.50,–');
  });

  it('quotes cells containing commas or quotes', () => {
    const odd: ColumnDef = { ...(COLUMNS['ltp'] as ColumnDef), label: 'A,"B"', format: () => 'x,y' };
    const v = { ...vm('mirrored', [], rows), columns: [odd] };
    const lines = toCsv(v, HDR).content.split('\n');
    expect(lines[1]).toBe('"CE A,""B""",Strike,"PE A,""B"""');
    expect(lines[2]).toBe('"x,y",100,"x,y"');
  });

  it('is unaffected by the process time zone', () => {
    try {
      for (const tz of ['America/New_York', 'Pacific/Auckland', 'UTC']) {
        vi.stubEnv('TZ', tz);
        expect(toCsv(vm('mirrored', ['ltp'], rows), HDR).filename).toBe('optionchain_NIFTY_20261103_1405.csv');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses IST for the filename time regardless of machine zone', () => {
    // 20:30Z = 02:00 IST next day -> HHMM 0200
    const at = new Date('2026-10-29T20:30:00Z');
    expect(toCsv(vm('mirrored', ['ltp'], rows), { ...HDR, at }).filename).toBe('optionchain_NIFTY_20261103_0200.csv');
  });
});
