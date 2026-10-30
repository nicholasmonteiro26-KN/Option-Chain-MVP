import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_NOW, AUTH_REDIRECT, AUTH_SESSION_STORAGE, AuthSessionService, LoginIdentityMismatchError, PENDING_LOGIN_KEY,
  SESSION_STORAGE_KEY, wsUrlFor,
} from './auth-session.service';
import { KambalaRestClient } from './kambala/kambala-rest.client';
import { KambalaError, SessionExpiredError } from './kambala/kambala.types';

// Every code, token and uid here is FAKE.
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: StorageLike = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceeded'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

/** The fake clock AUTH_NOW reads. */
const now = 1_800_000_000_000;
const MIN = 60_000;

function setup(storage: StorageLike | null, userDetails: ReturnType<typeof vi.fn> = vi.fn(async () => ({ actid: 'TESTUID', exarr: ['NSE'] }))) {
  const redirect = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: AUTH_SESSION_STORAGE, useValue: storage },
      { provide: AUTH_REDIRECT, useValue: redirect },
      { provide: AUTH_NOW, useValue: () => now },
      { provide: KambalaRestClient, useValue: { userDetails } },
    ],
  });
  return { auth: TestBed.inject(AuthSessionService), http: TestBed.inject(HttpTestingController), userDetails, redirect };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('AuthSessionService (TradeSmart v2 OAuth)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('beginLogin stores the pending login (Client ID upper-cased) and goes to /auth/start', () => {
    const storage = memoryStorage();
    const { auth, redirect } = setup(storage);
    expect(auth.beginLogin(' testuid ', '/option-chain?underlying=NSE:NIFTY')).toBe(true);
    expect(JSON.parse(storage.data.get(PENDING_LOGIN_KEY)!)).toEqual({
      clientId: 'TESTUID', returnUrl: '/option-chain?underlying=NSE:NIFTY', createdAt: now,
    });
    expect(redirect).toHaveBeenCalledWith('/auth/start');
  });

  it('beginLogin with blocked storage does not leave the page', () => {
    const { auth, redirect } = setup(throwing);
    expect(auth.beginLogin('TESTUID', '/option-chain')).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });

  it('takePendingLogin reads it once', () => {
    const storage = memoryStorage();
    const { auth } = setup(storage);
    storage.data.set(PENDING_LOGIN_KEY, JSON.stringify({ clientId: 'TESTUID', returnUrl: '/x', createdAt: now - MIN }));
    expect(auth.takePendingLogin()).toEqual({ status: 'ok', pending: { clientId: 'TESTUID', returnUrl: '/x', createdAt: now - MIN } });
    expect(auth.takePendingLogin()).toEqual({ status: 'none' });
    storage.data.set(PENDING_LOGIN_KEY, '{"clientId":1');
    expect(auth.takePendingLogin()).toEqual({ status: 'none' });
  });

  it('takePendingLogin rejects a pending login older than 10 minutes, without createdAt, or from the future', () => {
    const storage = memoryStorage();
    const { auth } = setup(storage);
    const put = (extra: object) => storage.data.set(PENDING_LOGIN_KEY, JSON.stringify({ clientId: 'TESTUID', returnUrl: '/x', ...extra }));
    put({ createdAt: now - 10 * MIN });
    expect(auth.takePendingLogin().status).toBe('ok'); // exactly 10 minutes is still fine
    put({ createdAt: now - 10 * MIN - 1 });
    expect(auth.takePendingLogin()).toEqual({ status: 'expired' });
    expect(storage.data.has(PENDING_LOGIN_KEY)).toBe(false); // removed all the same
    put({});
    expect(auth.takePendingLogin()).toEqual({ status: 'expired' });
    put({ createdAt: 'yesterday' });
    expect(auth.takePendingLogin()).toEqual({ status: 'expired' });
    put({ createdAt: now + 5 * MIN });
    expect(auth.takePendingLogin()).toEqual({ status: 'expired' });
  });

  it('completeLogin rejects a GenAcsTok uid that is not the typed Client ID (case-insensitive) and stores nothing', async () => {
    const storage = memoryStorage();
    const { auth, http, userDetails } = setup(storage);
    const p = auth.completeLogin('c', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T', uid: 'OTHERUID' });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginIdentityMismatchError);
    expect((err as Error).message).toBe('You signed in to TradeSmart as OTHERUID, but entered Client ID TESTUID. Please try again.');
    expect(auth.session()).toBeNull();
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(userDetails).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    const ok = setup(memoryStorage());
    const p2 = ok.auth.completeLogin('c', 'TESTUID');
    ok.http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T', uid: 'testuid', actid: 'testuid' });
    expect((await p2).uid).toBe('testuid'); // same id, different case: accepted
  });

  it('completeLogin rejects a UserDetails uid that is not the typed Client ID, and logs out again', async () => {
    for (const details of [{ uid: 'OTHERUID' }, { uid: 'OTHERUID', actid: 'TESTUID' }]) {
      TestBed.resetTestingModule();
      const storage = memoryStorage();
      const { auth, http } = setup(storage, vi.fn(async () => details));
      const p = auth.completeLogin('c', 'TESTUID');
      http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
      const err = await p.catch((e: unknown) => e);
      expect(err, JSON.stringify(details)).toBeInstanceOf(LoginIdentityMismatchError);
      expect((err as Error).message).toContain('as OTHERUID, but entered Client ID TESTUID');
      expect(auth.session()).toBeNull();
      expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
    }
  });

  it('an actid different from the Client ID is accepted and kept as the session actid (exchange or UserDetails)', async () => {
    const { auth, http } = setup(memoryStorage(), vi.fn(async () => ({ uid: 'testuid', actid: 'ACCT-9' })));
    const p = auth.completeLogin('c', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T', uid: 'TESTUID', actid: 'ACCT-1' });
    expect(await p).toEqual({ uid: 'TESTUID', actid: 'ACCT-1', accessToken: 'T' });

    TestBed.resetTestingModule();
    const two = setup(memoryStorage(), vi.fn(async () => ({ actid: 'ACCT-9' })));
    const p2 = two.auth.completeLogin('c', 'TESTUID');
    two.http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
    expect(await p2).toEqual({ uid: 'TESTUID', actid: 'ACCT-9', accessToken: 'T' });
  });

  it('a response with client_id (the App Key) but no uid falls back to the typed Client ID', async () => {
    const { auth, http } = setup(memoryStorage(), vi.fn(async () => ({})));
    const p = auth.completeLogin('c', 'TESTUID');
    // The proxy never maps client_id to uid; even if a raw client_id slipped through, the browser does not read it.
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T', client_id: 'FAKEAPPKEY1' });
    expect(await p).toEqual({ uid: 'TESTUID', actid: 'TESTUID', accessToken: 'T' });
  });

  it('completeLogin POSTs {code} to /auth/exchange, stores {uid, actid, accessToken}, then validates with UserDetails', async () => {
    const storage = memoryStorage();
    const { auth, http, userDetails } = setup(storage);
    const p = auth.completeLogin('fake-code', 'TESTUID');
    const req = http.expectOne('/auth/exchange');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ code: 'fake-code' });
    req.flush({ stat: 'Ok', access_token: 'FAKE_TOKEN', uid: 'TESTUID', actid: 'TESTUID' });
    expect(await p).toEqual({ uid: 'TESTUID', actid: 'TESTUID', accessToken: 'FAKE_TOKEN' });
    expect(userDetails).toHaveBeenCalledTimes(1);
    expect(auth.isLoggedIn()).toBe(true);
    expect(JSON.parse(storage.data.get(SESSION_STORAGE_KEY)!)).toEqual({ uid: 'TESTUID', actid: 'TESTUID', accessToken: 'FAKE_TOKEN' });
    http.verify();
  });

  it('completeLogin: uid falls back to the Client ID, actid to UserDetails, then to uid', async () => {
    const { auth, http } = setup(memoryStorage(), vi.fn(async () => ({ actid: 'testuid' })));
    const p = auth.completeLogin('c', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
    expect(await p).toEqual({ uid: 'TESTUID', actid: 'testuid', accessToken: 'T' });

    TestBed.resetTestingModule();
    const two = setup(memoryStorage(), vi.fn(async () => ({})));
    const p2 = two.auth.completeLogin('c', 'TESTUID');
    two.http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
    expect(await p2).toEqual({ uid: 'TESTUID', actid: 'TESTUID', accessToken: 'T' });
  });

  it('completeLogin: a Not_Ok exchange (any HTTP status) throws KambalaError(emsg) and leaves no session', async () => {
    const { auth, http, userDetails } = setup(memoryStorage());
    const p = auth.completeLogin('bad', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Not_Ok', emsg: 'Invalid Input : Invalid IP' }, { status: 400, statusText: 'Bad Request' });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KambalaError);
    expect((err as Error).message).toBe('Invalid Input : Invalid IP');
    expect(auth.session()).toBeNull();
    expect(userDetails).not.toHaveBeenCalled();
  });

  it('completeLogin: a failed UserDetails check logs out again and passes the error on', async () => {
    const storage = memoryStorage();
    const { auth, http } = setup(storage, vi.fn(async () => { throw new SessionExpiredError('Invalid Token'); }));
    const p = auth.completeLogin('c', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T', uid: 'TESTUID' });
    await expect(p).rejects.toBeInstanceOf(SessionExpiredError);
    expect(auth.session()).toBeNull();
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it('restores a stored session on start (same tab), and ignores a malformed or old-format one', () => {
    const storage = memoryStorage();
    storage.data.set(SESSION_STORAGE_KEY, JSON.stringify({ uid: 'U', actid: 'A', accessToken: 'T' }));
    expect(setup(storage).auth.session()).toEqual({ uid: 'U', actid: 'A', accessToken: 'T' });
    TestBed.resetTestingModule();
    storage.data.set(SESSION_STORAGE_KEY, '{"uid":1');
    expect(setup(storage).auth.session()).toBeNull();
    TestBed.resetTestingModule();
    storage.data.set(SESSION_STORAGE_KEY, JSON.stringify({ uid: 'U', actid: 'A', susertoken: 'T' }));
    expect(setup(storage).auth.session()).toBeNull();
  });

  it('logout clears the signal and the stored session', async () => {
    const storage = memoryStorage();
    const { auth, http } = setup(storage);
    const p = auth.completeLogin('c', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
    await p;
    auth.logout();
    expect(auth.session()).toBeNull();
    expect(auth.isLoggedIn()).toBe(false);
    expect(storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it('tolerates a throwing storage (private mode, blocked storage): the session lives in memory', async () => {
    const { auth, http } = setup(throwing);
    expect(auth.session()).toBeNull();
    expect(auth.takePendingLogin()).toEqual({ status: 'none' });
    const p = auth.completeLogin('c', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
    await p;
    await settle();
    expect(auth.isLoggedIn()).toBe(true);
    expect(() => auth.logout()).not.toThrow();
    expect(auth.session()).toBeNull();
  });

  it('norenConfig gives the WebSocket URL on this host, the v2 accessToken and source API (no susertoken)', async () => {
    const { auth, http } = setup(memoryStorage());
    const p = auth.completeLogin('c', 'TESTUID');
    http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'FAKE_TOKEN', uid: 'TESTUID', actid: 'TESTUID' });
    await p;
    expect(auth.norenConfig()).toEqual({
      url: wsUrlFor(location), uid: 'TESTUID', actid: 'TESTUID', accessToken: 'FAKE_TOKEN', source: 'API',
    });
  });

  it('wsUrlFor picks ws or wss from the page protocol', () => {
    expect(wsUrlFor({ protocol: 'http:', host: 'localhost:4200' })).toBe('ws://localhost:4200/kambala-ws');
    expect(wsUrlFor({ protocol: 'https:', host: 'app.example' })).toBe('wss://app.example/kambala-ws');
  });
});
