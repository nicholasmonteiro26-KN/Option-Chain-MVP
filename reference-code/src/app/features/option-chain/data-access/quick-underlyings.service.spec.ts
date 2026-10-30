import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexListEntry, KambalaError } from './kambala/kambala.types';
import { QUICK_UNDERLYINGS } from './models';
import {
  IndexListApi, QuickUnderlyingsService, resolveQuickUnderlyings, SENSEX_UNAVAILABLE,
} from './quick-underlyings.service';

function api(lists: Record<string, IndexListEntry[] | Error>): IndexListApi & { getIndexList: ReturnType<typeof vi.fn> } {
  return {
    getIndexList: vi.fn(async (exch: string) => {
      const v = lists[exch];
      if (v instanceof Error) throw v;
      return v ?? [];
    }),
  };
}

const NSE_LIST: IndexListEntry[] = [
  { idxname: 'Nifty Bank', token: '26009' },
  { idxname: 'Nifty 50', token: '26900' },
];

describe('resolveQuickUnderlyings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes the NIFTY and SENSEX tokens from GetIndexList (NSE "Nifty 50", BSE "SENSEX" in any case)', async () => {
    const rest = api({ NSE: NSE_LIST, BSE: [{ idxname: 'BANKEX', token: '12' }, { idxname: 'Sensex', token: '99' }] });
    const list = await resolveQuickUnderlyings(rest);
    expect(rest.getIndexList).toHaveBeenCalledWith('NSE');
    expect(rest.getIndexList).toHaveBeenCalledWith('BSE');
    expect(list.map((u) => [u.sym, u.token, u.unavailable])).toEqual([
      ['NIFTY', '26900', undefined],
      ['SENSEX', '99', undefined],
    ]);
  });

  it('marks SENSEX unavailable when the BSE list has no SENSEX; NIFTY still works', async () => {
    const list = await resolveQuickUnderlyings(api({ NSE: NSE_LIST, BSE: [{ idxname: 'BANKEX', token: '12' }] }));
    expect(list[0]).toMatchObject({ sym: 'NIFTY', token: '26900' });
    expect(list[1]).toMatchObject({ sym: 'SENSEX', unavailable: SENSEX_UNAVAILABLE });
    expect(SENSEX_UNAVAILABLE).toBe('SENSEX not available for this account');
  });

  it('a BSE "no data" answer (no BSE indices for this account) also means SENSEX is unavailable', async () => {
    const list = await resolveQuickUnderlyings(api({ NSE: NSE_LIST, BSE: new KambalaError('Error Occurred : 5 "no data"') }));
    expect(list[1]!.unavailable).toBe(SENSEX_UNAVAILABLE);
  });

  it('when GetIndexList fails: NIFTY keeps its documented token 26000, SENSEX is unavailable (never the placeholder), with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const list = await resolveQuickUnderlyings(api({ NSE: new Error('HTTP 502'), BSE: new Error('HTTP 502') }));
    expect(list[0]).toEqual(QUICK_UNDERLYINGS[0]);
    expect(list[0]!.token).toBe('26000');
    expect(list[1]).toMatchObject({ sym: 'SENSEX', unavailable: SENSEX_UNAVAILABLE });
    expect(list[1]!.token).not.toBe('1');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain('GetIndexList');
  });

  it('any BSE failure (not only "no data") makes SENSEX unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const list = await resolveQuickUnderlyings(api({ NSE: NSE_LIST, BSE: new KambalaError('Invalid Input : x') }));
    expect(list[0]!.token).toBe('26900');
    expect(list[1]!.unavailable).toBe(SENSEX_UNAVAILABLE);
  });

  it('falls back for NIFTY when the NSE list lacks "Nifty 50"', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const list = await resolveQuickUnderlyings(api({ NSE: [{ idxname: 'Nifty Bank', token: '26009' }], BSE: [{ idxname: 'SENSEX', token: '1' }] }));
    expect(list[0]!.token).toBe(QUICK_UNDERLYINGS[0]!.token);
  });
});

describe('QuickUnderlyingsService', () => {
  it('starts with the built-in list and publishes resolved tokens and feed keys (unavailable ones left out)', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(QuickUnderlyingsService);
    expect(svc.list()).toEqual(QUICK_UNDERLYINGS);
    expect(svc.keys()).toEqual(['NSE|26000', 'BSE|1']);
    await svc.resolve(api({ NSE: NSE_LIST, BSE: [] }));
    expect(svc.list()[0]!.token).toBe('26900');
    expect(svc.keys()).toEqual(['NSE|26900']);
  });

  it('is ready at once by default; after expectResolution() it is ready only once resolve() settles', async () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(QuickUnderlyingsService);
    expect(svc.ready()).toBe(true);
    svc.expectResolution();
    expect(svc.ready()).toBe(false);
    const p = svc.resolve(api({ NSE: NSE_LIST, BSE: [] }));
    expect(svc.ready()).toBe(false);
    await p;
    expect(svc.ready()).toBe(true);
  });
});
