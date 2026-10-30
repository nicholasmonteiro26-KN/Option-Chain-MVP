import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KambalaRestClient } from './kambala/kambala-rest.client';
import { InstrumentsService, parseExd } from './instruments.service';
import { Expiry, QUICK_UNDERLYINGS, Underlying } from './models';
import { chainRows, NIFTY_LINKED, NOW_MS } from './testing/chain-fixtures';

const NIFTY = QUICK_UNDERLYINGS.find((u) => u.sym === 'NIFTY') as Underlying;
const SENSEX = QUICK_UNDERLYINGS.find((u) => u.sym === 'SENSEX') as Underlying;

describe('InstrumentsService', () => {
  let rest: { getLinkedScrips: ReturnType<typeof vi.fn>; getOptionChain: ReturnType<typeof vi.fn> };
  let svc: InstrumentsService;

  beforeEach(() => {
    rest = { getLinkedScrips: vi.fn(), getOptionChain: vi.fn() };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: KambalaRestClient, useValue: rest }],
    });
    svc = TestBed.inject(InstrumentsService);
  });

  it('QUICK_UNDERLYINGS holds NIFTY (NSE|26000 / NFO) and SENSEX (BSE / BFO)', () => {
    expect(NIFTY).toEqual({ sym: 'NIFTY', exch: 'NSE', foExch: 'NFO', token: '26000', name: 'Nifty 50', isIndex: true });
    expect(SENSEX.exch).toBe('BSE');
    expect(SENSEX.foExch).toBe('BFO');
  });

  it('parseExd maps DD-MMM-YYYY (any month case) to ISO and rejects garbage', () => {
    expect(parseExd('03-NOV-2026')).toBe('2026-11-03');
    expect(parseExd('28-jan-2027')).toBe('2027-01-28');
    expect(parseExd('garbage')).toBeNull();
    expect(parseExd('32-NOV-2026')).toBeNull();
    expect(parseExd('03-XYZ-2026')).toBeNull();
  });

  it('loadExpiries returns ascending, unexpired, de-duplicated expiries', async () => {
    rest.getLinkedScrips.mockResolvedValue(NIFTY_LINKED);
    const out = await svc.loadExpiries(NIFTY, NOW_MS);
    expect(rest.getLinkedScrips).toHaveBeenCalledWith('NSE', '26000');
    expect(out.map((e) => e.iso)).toEqual(['2026-11-03', '2026-11-10', '2026-11-17']);
    expect(out[0]).toEqual({ iso: '2026-11-03', exd: '03-Nov-2026', sampleTsym: 'NIFTY03NOV26P24000', foExch: 'NFO' });
  });

  it('loadExpiries drops an expiry on its own day after 15:30 IST', async () => {
    rest.getLinkedScrips.mockResolvedValue({ opt_exp: [{ exd: '29-OCT-2026', exch: 'NFO', tsym: 'X' }] });
    expect(await svc.loadExpiries(NIFTY, Date.UTC(2026, 9, 29, 9, 0))).toHaveLength(1); // 14:30 IST
    expect(await svc.loadExpiries(NIFTY, Date.UTC(2026, 9, 29, 10, 0))).toHaveLength(0); // 15:30 IST
  });

  it('loadChain pairs CE/PE by strprc, sorts strikes and computes strikeStep 50 for NIFTY', async () => {
    const rows = chainRows('NIFTY10NOV26', 'NFO', [24100, 23900, 24000, 24050, 23950], 1000);
    rest.getOptionChain.mockResolvedValue([...rows].reverse());
    const e: Expiry = { iso: '2026-11-10', exd: '10-NOV-2026', sampleTsym: 'NIFTY10NOV26P24000', foExch: 'NFO' };
    const meta = await svc.loadChain(NIFTY, e, 24012.6, 100);

    expect(rest.getOptionChain).toHaveBeenCalledWith('NFO', 'NIFTY10NOV26P24000', 24013, 100);
    expect(meta.underlying).toBe(NIFTY);
    expect(meta.expiry).toBe(e);
    expect(meta.strikeStep).toBe(50);
    expect(meta.strikes.map((s) => s.strike)).toEqual([23900, 23950, 24000, 24050, 24100]);
    const atm = meta.strikes[2]!;
    expect(atm.ce).toEqual({ token: 'NFO|1004', tsym: 'NIFTY10NOV26C24000', lotSize: 75, tickSize: 0.05, pricePrecision: 2 });
    expect(atm.pe?.token).toBe('NFO|1005');
  });

  it('loadChain keeps a missing side as null and strikeStep uses the minimum positive gap', async () => {
    const rows = chainRows('X', 'NFO', [100, 200, 250], 1).filter((r) => !(r.strprc === '200.00' && r.optt === 'PE'));
    rest.getOptionChain.mockResolvedValue(rows);
    const meta = await svc.loadChain(NIFTY, { iso: '2026-11-10', exd: '', sampleTsym: 'X', foExch: 'NFO' }, 200, 10);
    expect(meta.strikes[1]!.pe).toBeNull();
    expect(meta.strikes[1]!.ce).not.toBeNull();
    expect(meta.strikeStep).toBe(50);
  });

  it('strikeStep is 0 for fewer than two strikes', async () => {
    rest.getOptionChain.mockResolvedValue(chainRows('X', 'NFO', [100], 1));
    const meta = await svc.loadChain(NIFTY, { iso: '2026-11-10', exd: '', sampleTsym: 'X', foExch: 'NFO' }, 100, 10);
    expect(meta.strikeStep).toBe(0);
  });

  it('loadChain keeps ls per contract (SENSEX: Nov ls 20, Jan-2027 ls 25)', async () => {
    const nov: Expiry = { iso: '2026-11-05', exd: '05-NOV-2026', sampleTsym: 'SENSEX26N0580000PE', foExch: 'BFO' };
    const jan: Expiry = { iso: '2027-01-28', exd: '28-JAN-2027', sampleTsym: 'SENSEX27JAN80000PE', foExch: 'BFO' };
    rest.getOptionChain.mockImplementation(async (_exch: string, tsym: string) =>
      tsym === nov.sampleTsym
        ? chainRows('SENSEX26N05', 'BFO', [79900, 80000, 80100], 800, '20')
        : chainRows('SENSEX27JAN', 'BFO', [79900, 80000, 80100], 900, '25'));

    const mNov = await svc.loadChain(SENSEX, nov, 80000, 50);
    const mJan = await svc.loadChain(SENSEX, jan, 80000, 50);
    expect(rest.getOptionChain).toHaveBeenCalledWith('BFO', nov.sampleTsym, 80000, 50);
    expect(mNov.strikes.flatMap((s) => [s.ce!.lotSize, s.pe!.lotSize])).toEqual([20, 20, 20, 20, 20, 20]);
    expect(mJan.strikes.flatMap((s) => [s.ce!.lotSize, s.pe!.lotSize])).toEqual([25, 25, 25, 25, 25, 25]);
    expect(mNov.strikes[0]!.ce!.token).toBe('BFO|800');
    expect(mNov.strikeStep).toBe(100);
  });
});
