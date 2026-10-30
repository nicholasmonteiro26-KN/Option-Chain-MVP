import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { KambalaRestClient, KAMBALA_REST_BASE } from './kambala-rest.client';
import { KambalaError, NOREN_SESSION_CONFIG, NorenSessionConfig, SessionExpiredError } from './kambala.types';

/** One backslash (keeps the unicode-escape expectations readable). */
const BS = String.fromCharCode(92);

function jDataOf(body: unknown): Record<string, unknown> {
  return JSON.parse(String(body).split('&')[0]!.slice('jData='.length));
}

describe('KambalaRestClient', () => {
  let client: KambalaRestClient;
  let http: HttpTestingController;
  const BASE = 'https://api.test';
  /** The session getter's value. Default: a v2 OAuth session (fake token). */
  let cfg: NorenSessionConfig;
  const V2: NorenSessionConfig = { url: 'wss://x', uid: 'U1', actid: 'A1', accessToken: 'fake-access-token' };
  const LEGACY: NorenSessionConfig = { url: 'wss://x', uid: 'U1', actid: 'A1', susertoken: 'tok&en=1' };

  beforeEach(() => {
    cfg = V2;
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: KAMBALA_REST_BASE, useValue: BASE },
        { provide: NOREN_SESSION_CONFIG, useValue: () => cfg },
      ],
    });
    client = TestBed.inject(KambalaRestClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('v2 session: POSTs jData (uid inside) with Authorization: Bearer <accessToken> and no jKey', async () => {
    const p = client.getOptionChain('NFO', 'M&M25NOV2800CE', 2800, 10);
    const req = http.expectOne(`${BASE}/GetOptionChain`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Authorization')).toBe('Bearer fake-access-token');
    expect(req.request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const body = String(req.request.body);
    expect(body).not.toContain('jKey');
    expect(body).not.toContain('fake-access-token'); // the token travels in the header only
    expect(body).toBe(`jData={"uid":"U1","tsym":"M${BS}u0026M25NOV2800CE","exch":"NFO","strprc":"2800","cnt":"10"}`);
    expect(jDataOf(body)['uid']).toBe('U1');
    req.flush({ stat: 'Ok', values: [] });
    expect(await p).toEqual([]);
  });

  it('v2 session: reads the session per call (a new token after re-login is used at once)', async () => {
    cfg = { ...V2, accessToken: 'fresh-token' };
    const p = client.getIndexList('NSE');
    const req = http.expectOne(`${BASE}/GetIndexList`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer fresh-token');
    req.flush({ stat: 'Ok', values: [] });
    await p;
  });

  it('v2 session: HTTP 401 maps to SessionExpiredError (with or without a Not_Ok body)', async () => {
    const p = client.getIndexList('NSE');
    http.expectOne(`${BASE}/GetIndexList`).flush({ stat: 'Not_Ok', emsg: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
    await expect(p).rejects.toBeInstanceOf(SessionExpiredError);

    const p2 = client.getIndexList('NSE');
    http.expectOne(`${BASE}/GetIndexList`).flush('', { status: 401, statusText: 'Unauthorized' });
    await expect(p2).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('"Invalid Token" / "invalid access token" emsg (any case) maps to SessionExpiredError', async () => {
    for (const emsg of ['Invalid Token', 'Error : invalid access token', 'SESSION EXPIRED : x']) {
      const p = client.getIndexList('NSE');
      http.expectOne(`${BASE}/GetIndexList`).flush({ stat: 'Not_Ok', emsg }, { status: 400, statusText: 'Bad Request' });
      await expect(p, emsg).rejects.toBeInstanceOf(SessionExpiredError);
    }
  });

  it('other HTTP errors without a Not_Ok body are passed on unchanged', async () => {
    const p = client.getIndexList('NSE');
    http.expectOne(`${BASE}/GetIndexList`).flush('oops', { status: 502, statusText: 'Bad Gateway' });
    const err = await p.catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(KambalaError);
  });

  it('userDetails POSTs UserDetails with jData {uid} and returns actid / exarr', async () => {
    const p = client.userDetails();
    const req = http.expectOne(`${BASE}/UserDetails`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer fake-access-token');
    expect(jDataOf(req.request.body)).toEqual({ uid: 'U1' });
    req.flush({ stat: 'Ok', actid: 'A1', uname: 'TEST USER', exarr: ['NSE', 'NFO'] });
    expect(await p).toMatchObject({ actid: 'A1', exarr: ['NSE', 'NFO'] });
  });

  it('legacy session (susertoken only, for TradeSmart\x27s web session): form-encoded jData and jKey, no Authorization header', async () => {
    cfg = LEGACY;
    const p = client.getOptionChain('NFO', 'M&M25NOV2800CE', 2800, 10);
    const req = http.expectOne(`${BASE}/GetOptionChain`);
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(req.request.headers.has('Authorization')).toBe(false);
    const jData = { uid: 'U1', tsym: 'M&M25NOV2800CE', exch: 'NFO', strprc: '2800', cnt: '10' };
    expect(req.request.body).toBe(
      // Raw JSON (the v2 server rejects a URL-encoded jData); & % + are unicode escapes inside it: M&M -> M&M.
      `jData={"uid":"U1","tsym":"M${BS}u0026M25NOV2800CE","exch":"NFO","strprc":"2800","cnt":"10"}&jKey=${encodeURIComponent('tok&en=1')}`,
    );
    const [jPart] = String(req.request.body).split('&jKey=');
    expect(jPart).not.toMatch(/[&%+]/); // nothing form-special inside the JSON
    expect(JSON.parse(jPart!.slice('jData='.length))).toEqual(jData);
    req.flush({ stat: 'Ok', values: [{ exch: 'NFO', tsym: 'X', token: '1', optt: 'CE', strprc: '2800', pp: '2', ti: '0.05', ls: '75' }] });
    const rows = await p;
    expect(rows[0]!.token).toBe('1');
  });

  it('sends all jData values as strings', async () => {
    const p = client.getOptionChain('NFO', 'T', 24500.5, 8);
    const req = http.expectOne(`${BASE}/GetOptionChain`);
    const jData = jDataOf(req.request.body);
    expect(jData['strprc']).toBe('24500.5');
    expect(jData['cnt']).toBe('8');
    req.flush({ stat: 'Ok', values: [] });
    await p;
  });

  it('rejects with SessionExpiredError on Session Expired', async () => {
    const p = client.getOptionChain('NFO', 'T', 1, 1);
    http.expectOne(`${BASE}/GetOptionChain`).flush({
      stat: 'Not_Ok', emsg: 'Session Expired : Invalid Session Key',
    });
    await expect(p).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('rejects other Not_Ok with KambalaError carrying emsg (not SessionExpiredError)', async () => {
    const p = client.getLinkedScrips('NSE', '26000');
    http.expectOne(`${BASE}/GetLinkedScrips`).flush({ stat: 'Not_Ok', emsg: 'Error Occurred : 5 "no data"' });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KambalaError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
    expect((err as Error).message).toBe('Error Occurred : 5 "no data"');
  });

  it('getLinkedScrips sends uid/exch/token and returns the parsed response', async () => {
    const p = client.getLinkedScrips('NSE', '26000');
    const req = http.expectOne(`${BASE}/GetLinkedScrips`);
    expect(jDataOf(req.request.body)).toEqual({ uid: 'U1', exch: 'NSE', token: '26000' });
    const body = { stat: 'Ok', opt_exp: [{ exd: '25-NOV-2026', exch: 'NFO', tsym: 'NIFTY25NOV26C24500' }] };
    req.flush(body);
    expect(await p).toEqual(body);
  });

  it('searchScrip maps values to {exch, tsym, token, name}', async () => {
    const p = client.searchScrip('NIFTY');
    const req = http.expectOne(`${BASE}/SearchScrip`);
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
    http.expectOne(`${BASE}/SearchScrip`).flush({ stat: 'Not_Ok', emsg: 'No Data :' });
    expect(await p).toEqual([]);

    const p2 = client.searchScrip('A');
    http.expectOne(`${BASE}/SearchScrip`).flush({ stat: 'Not_Ok', emsg: 'Invalid Input : x' });
    await expect(p2).rejects.toBeInstanceOf(KambalaError);

    const p3 = client.searchScrip('A');
    http.expectOne(`${BASE}/SearchScrip`).flush({ stat: 'Not_Ok', emsg: 'Session Expired : Invalid Session Key' });
    await expect(p3).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('getIndexList sends uid/exch and returns the values', async () => {
    const p = client.getIndexList('NSE');
    const req = http.expectOne(`${BASE}/GetIndexList`);
    expect(jDataOf(req.request.body)).toEqual({ uid: 'U1', exch: 'NSE' });
    req.flush({ stat: 'Ok', values: [{ idxname: 'Nifty 50', token: '26000' }] });
    expect(await p).toEqual([{ idxname: 'Nifty 50', token: '26000' }]);
  });
});
