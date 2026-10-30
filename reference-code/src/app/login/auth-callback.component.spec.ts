import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_NOW, AUTH_REDIRECT, AUTH_SESSION_STORAGE, AuthSessionService, PENDING_LOGIN_KEY, SESSION_STORAGE_KEY,
} from '../features/option-chain/data-access/auth-session.service';
import { KambalaRestClient } from '../features/option-chain/data-access/kambala/kambala-rest.client';
import { AuthCallbackComponent, loginErrorText } from './auth-callback.component';

// Every code, token and Client ID here is FAKE.
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

/** The fake clock AUTH_NOW reads. */
const NOW = 1_800_000_000_000;
const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const HINT = 'Check that your static IP and the Redirect URL are registered on the TradeSmart API dashboard.';

interface Ctx {
  fixture: ComponentFixture<AuthCallbackComponent>;
  el: HTMLElement;
  storage: ReturnType<typeof memoryStorage>;
  http: HttpTestingController;
  navigate: ReturnType<typeof vi.fn>;
  replaceState: ReturnType<typeof vi.fn>;
  userDetails: ReturnType<typeof vi.fn>;
  /** Order of the side effects, to check that the code leaves the URL before navigation. */
  order: string[];
}

async function setup(opts: {
  query?: Record<string, string>;
  pending?: { clientId: string; returnUrl: string; createdAt?: number } | null;
  userDetails?: ReturnType<typeof vi.fn>;
} = {}): Promise<Ctx> {
  const storage = memoryStorage();
  if (opts.pending !== null) {
    storage.data.set(PENDING_LOGIN_KEY, JSON.stringify({
      createdAt: NOW - 60_000,
      ...(opts.pending ?? { clientId: 'TESTUID', returnUrl: '/option-chain?underlying=BSE:SENSEX' }),
    }));
  }
  const order: string[] = [];
  const userDetails = opts.userDetails ?? vi.fn(async () => {
    order.push('userDetails');
    return { actid: 'TESTUID' };
  });
  TestBed.configureTestingModule({
    imports: [AuthCallbackComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(opts.query ?? { code: 'fake-code' }) } } },
      { provide: AUTH_SESSION_STORAGE, useValue: storage },
      { provide: AUTH_REDIRECT, useValue: vi.fn() },
      { provide: AUTH_NOW, useValue: () => NOW },
      { provide: KambalaRestClient, useValue: { userDetails } },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockImplementation(async () => {
    order.push('navigate');
    return true;
  });
  const replaceState = vi.spyOn(TestBed.inject(Location), 'replaceState').mockImplementation(() => {
    order.push('replaceState');
  });
  const fixture = TestBed.createComponent(AuthCallbackComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return {
    fixture, el: fixture.nativeElement as HTMLElement, storage, http: TestBed.inject(HttpTestingController),
    navigate: navigate as unknown as Ctx['navigate'], replaceState: replaceState as unknown as Ctx['replaceState'],
    userDetails, order,
  };
}

async function done(ctx: Ctx): Promise<void> {
  for (let i = 0; i < 5; i++) await settle();
  await ctx.fixture.whenStable();
}

const alertText = (ctx: Ctx) => ctx.el.querySelector('[role="alert"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('AuthCallbackComponent (/auth/callback)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('success: exchanges the code, stores the session, validates with UserDetails, strips the code and goes to returnUrl', async () => {
    const ctx = await setup();
    expect(ctx.el.textContent).toContain('Logging in');
    const req = ctx.http.expectOne('/auth/exchange');
    expect(req.request.body).toEqual({ code: 'fake-code' });
    req.flush({ stat: 'Ok', access_token: 'FAKE_TOKEN', uid: 'TESTUID', actid: 'TESTUID' });
    await done(ctx);

    expect(JSON.parse(ctx.storage.data.get(SESSION_STORAGE_KEY)!)).toEqual({ uid: 'TESTUID', actid: 'TESTUID', accessToken: 'FAKE_TOKEN' });
    expect(TestBed.inject(AuthSessionService).isLoggedIn()).toBe(true);
    expect(ctx.userDetails).toHaveBeenCalledTimes(1);
    expect(ctx.replaceState).toHaveBeenCalledWith('/auth/callback'); // no ?code= left in the address bar
    expect(ctx.navigate).toHaveBeenCalledWith('/option-chain?underlying=BSE:SENSEX', { replaceUrl: true });
    expect(ctx.order.indexOf('replaceState')).toBeLessThan(ctx.order.indexOf('navigate'));
    expect(ctx.storage.data.has(PENDING_LOGIN_KEY)).toBe(false); // one use only
    ctx.http.verify();
  });

  it('uid falls back to the pending Client ID when the exchange gives none', async () => {
    const ctx = await setup();
    ctx.http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'FAKE_TOKEN' });
    await done(ctx);
    expect(JSON.parse(ctx.storage.data.get(SESSION_STORAGE_KEY)!)).toMatchObject({ uid: 'TESTUID', accessToken: 'FAKE_TOKEN' });
  });

  it('an unsafe returnUrl is not followed: goes to /option-chain', async () => {
    for (const bad of ['https://evil.com', '//evil.com', 'javascript:alert(1)']) {
      TestBed.resetTestingModule();
      const ctx = await setup({ pending: { clientId: 'TESTUID', returnUrl: bad } });
      ctx.http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
      await done(ctx);
      expect(ctx.navigate, bad).toHaveBeenCalledWith('/option-chain', { replaceUrl: true });
    }
  });

  it('a Not_Ok exchange shows emsg plus the IP / Redirect URL hint, a Try again link, and no session', async () => {
    const ctx = await setup();
    ctx.http.expectOne('/auth/exchange').flush({ stat: 'Not_Ok', emsg: 'Invalid Input : Invalid IP' }, { status: 400, statusText: 'Bad Request' });
    await done(ctx);
    expect(alertText(ctx)).toBe(`Login failed: Invalid Input : Invalid IP ${HINT}`);
    const retry = [...ctx.el.querySelectorAll('a')].find((a) => a.textContent?.trim() === 'Try again')!;
    expect(retry.getAttribute('href')).toMatch(/^\/login/);
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(ctx.replaceState).toHaveBeenCalledWith('/auth/callback');
  });

  it('other errors show emsg without the hint; a network failure gets a plain message', async () => {
    const ctx = await setup();
    ctx.http.expectOne('/auth/exchange').flush({ stat: 'Not_Ok', emsg: 'Invalid Input : Invalid checksum' });
    await done(ctx);
    expect(alertText(ctx)).toBe('Login failed: Invalid Input : Invalid checksum');

    TestBed.resetTestingModule();
    const down = await setup();
    down.http.expectOne('/auth/exchange').error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    await done(down);
    expect(alertText(down)).toContain('Login failed: could not reach the server');
  });

  it('a failed UserDetails check shows its message and leaves no session', async () => {
    const { SessionExpiredError } = await import('../features/option-chain/data-access/kambala/kambala.types');
    const ctx = await setup({ userDetails: vi.fn(async () => { throw new SessionExpiredError('Invalid Token'); }) });
    ctx.http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T' });
    await done(ctx);
    expect(alertText(ctx)).toBe('Login failed: Invalid Token');
    expect(ctx.storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('an error param from TradeSmart is shown (with the hint for a redirect problem); no exchange', async () => {
    const ctx = await setup({ query: { error: 'redirect_uri mismatch' } });
    await done(ctx);
    expect(alertText(ctx)).toBe(`Login failed: redirect_uri mismatch ${HINT}`);
    ctx.http.expectNone('/auth/exchange');
  });

  it('no pending login (a direct visit) says so plainly and exchanges nothing', async () => {
    const ctx = await setup({ pending: null });
    await done(ctx);
    expect(alertText(ctx)).toContain('There is no login in progress in this browser tab');
    expect(ctx.el.textContent).toContain('Try again');
    ctx.http.expectNone('/auth/exchange');
    expect(ctx.replaceState).toHaveBeenCalledWith('/auth/callback'); // a stray code is still dropped from the URL
  });

  it('a pending login older than 10 minutes is rejected with a plain message; no exchange', async () => {
    const ctx = await setup({ pending: { clientId: 'TESTUID', returnUrl: '/option-chain', createdAt: NOW - 11 * 60_000 } });
    await done(ctx);
    expect(alertText(ctx)).toContain('took more than 10 minutes');
    ctx.http.expectNone('/auth/exchange');
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('signing in to TradeSmart as another account shows the mismatch message as is, and no session', async () => {
    const ctx = await setup();
    ctx.http.expectOne('/auth/exchange').flush({ stat: 'Ok', access_token: 'T', uid: 'OTHERUID' });
    await done(ctx);
    expect(alertText(ctx)).toBe('You signed in to TradeSmart as OTHERUID, but entered Client ID TESTUID. Please try again.');
    expect(ctx.storage.data.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('a pending login but no code says TradeSmart sent none', async () => {
    const ctx = await setup({ query: {} });
    await done(ctx);
    expect(alertText(ctx)).toContain('TradeSmart did not send a login code');
    ctx.http.expectNone('/auth/exchange');
  });
});

describe('loginErrorText', () => {
  it('adds the dashboard hint only for IP or redirect messages', () => {
    expect(loginErrorText('Invalid IP address')).toContain(HINT);
    expect(loginErrorText('IP not whitelisted')).toContain(HINT);
    expect(loginErrorText('Redirect URL mismatch')).toContain(HINT);
    expect(loginErrorText('Invalid checksum')).toBe('Login failed: Invalid checksum');
    expect(loginErrorText('Invalid description')).not.toContain(HINT); // "ip" inside a word does not count
  });
});
