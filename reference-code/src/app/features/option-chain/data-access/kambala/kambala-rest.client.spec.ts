import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { KambalaRestClient, KAMBALA_REST_BASE } from './kambala-rest.client';
import { KambalaError, NOREN_SESSION_CONFIG, SessionExpiredError } from './kambala.types';

function jDataOf(body: unknown): Record<string, unknown> {
  return JSON.parse(decodeURIComponent(String(body).split('&')[0]!.slice('jData='.length)));
}

describe('KambalaRestClient', () => {
  let client: KambalaRestClient;
  let http: HttpTestingController;
  const BASE = 'https://api.test';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: KAMBALA_REST_BASE, useValue: BASE },
        { provide: NOREN_SESSION_CONFIG, useValue: () => ({ url: 'wss://x', uid: 'U1', actid: 'A1', susertoken: 'tok&en=1' }) },
      ],
    });
    client = TestBed.inject(KambalaRestClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('POSTs form-encoded jData and jKey to /NorenWClientTP/<endpoint>', async () => {
    const p = client.getOptionChain('NFO', 'M&M25NOV2800CE', 2800, 10);
    const req = http.expectOne(`${BASE}/NorenWClientTP/GetOptionChain`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const jData = { uid: 'U1', tsym: 'M&M25NOV2800CE', exch: 'NFO', strprc: '2800', cnt: '10' };
    expect(req.request.body).toBe(
      `jData=${encodeURIComponent(JSON.stringify(jData))}&jKey=${encodeURIComponent('tok&en=1')}`,
    );
    req.flush({ stat: 'Ok', values: [{ exch: 'NFO', tsym: 'X', token: '1', optt: 'CE', strprc: '2800', pp: '2', ti: '0.05', ls: '75' }] });
    const rows = await p;
    expect(rows[0]!.token).toBe('1');
  });

  it('sends all jData values as strings', async () => {
    const p = client.getOptionChain('NFO', 'T', 24500.5, 8);
    const req = http.expectOne(`${BASE}/NorenWClientTP/GetOptionChain`);
    const jData = jDataOf(req.request.body);
    expect(jData['strprc']).toBe('24500.5');
    expect(jData['cnt']).toBe('8');
    req.flush({ stat: 'Ok', values: [] });
    await p;
  });

  it('rejects with SessionExpiredError on Session Expired', async () => {
    const p = client.getOptionChain('NFO', 'T', 1, 1);
    http.expectOne(`${BASE}/NorenWClientTP/GetOptionChain`).flush({
      stat: 'Not_Ok', emsg: 'Session Expired : Invalid Session Key',
    });
    await expect(p).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('rejects other Not_Ok with KambalaError carrying emsg (not SessionExpiredError)', async () => {
    const p = client.getLinkedScrips('NSE', '26000');
    http.expectOne(`${BASE}/NorenWClientTP/GetLinkedScrips`).flush({ stat: 'Not_Ok', emsg: 'Error Occurred : 5 "no data"' });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KambalaError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect((err as Error).message).toBe('Error Occurred : 5 "no data"');
  });

  it('getLinkedScrips sends uid/exch/token and returns the parsed response', async () => {
    const p = client.getLinkedScrips('NSE', '26000');
    const req = http.expectOne(`${BASE}/NorenWClientTP/GetLinkedScrips`);
    expect(jDataOf(req.request.body)).toEqual({ uid: 'U1', exch: 'NSE', token: '26000' });
    const body = { stat: 'Ok', opt_exp: [{ exd: '25-NOV-2026', exch: 'NFO', tsym: 'NIFTY25NOV26C24500' }] };
    req.flush(body);
    expect(await p).toEqual(body);
  });

  it('searchScrip maps values to {exch, tsym, token, name}', async () => {
    const p = client.searchScrip('NIFTY');
    const req = http.expectOne(`${BASE}/NorenWClientTP/SearchScrip`);
    expect(jDataOf(req.request.body)).toEqual({ uid: 'U1', stext: 'NIFTY' });
    req.flush({
      stat: 'Ok',
      values: [
        { exch: 'NSE', tsym: 'NIFTY-EQ', token: '1', cname: 'Nifty Co' },
        { exch: 'NFO', tsym: 'NIFTY25NOV', token: '2', symname: 'NIFTY' },
        { exch: 'NFO', tsym: 'ONLYSYM', token: '3' },
      ],
    });
    expect(await p).toEqual([
      { exch: 'NSE', tsym: 'NIFTY-EQ', token: '1', name: 'Nifty Co' },
      { exch: 'NFO', tsym: 'NIFTY25NOV', token: '2', name: 'NIFTY' },
      { exch: 'NFO', tsym: 'ONLYSYM', token: '3', name: 'ONLYSYM' },
    ]);
  });

  it('searchScrip returns [] for Not_Ok "No Data :" but still throws other errors', async () => {
    const p = client.searchScrip('ZZZ');
    http.expectOne(`${BASE}/NorenWClientTP/SearchScrip`).flush({ stat: 'Not_Ok', emsg: 'No Data :' });
    expect(await p).toEqual([]);

    const p2 = client.searchScrip('A');
    http.expectOne(`${BASE}/NorenWClientTP/SearchScrip`).flush({ stat: 'Not_Ok', emsg: 'Invalid Input : x' });
    await expect(p2).rejects.toBeInstanceOf(KambalaError);

    const p3 = client.searchScrip('A');
    http.expectOne(`${BASE}/NorenWClientTP/SearchScrip`).flush({ stat: 'Not_Ok', emsg: 'Session Expired : Invalid Session Key' });
    await expect(p3).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
