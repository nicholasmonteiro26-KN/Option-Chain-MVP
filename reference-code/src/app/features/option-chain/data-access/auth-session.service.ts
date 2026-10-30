import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, InjectionToken, Injector, Provider, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { KAMBALA_REST_BASE, KambalaRestClient } from './kambala/kambala-rest.client';
import { KambalaError, NOREN_SESSION_CONFIG, NorenSessionConfig } from './kambala/kambala.types';

/** What the option chain keeps of a login (TradeSmart v2 OAuth). */
export interface AuthSession {
  uid: string;
  actid: string;
  accessToken: string;
}

/** Saved by /login just before the browser goes to TradeSmart; read once by /auth/callback. */
export interface PendingLogin {
  clientId: string;
  returnUrl: string;
  /** Epoch ms when /login saved it. Older than PENDING_LOGIN_MAX_AGE_MS: rejected. */
  createdAt: number;
}

/** What the callback finds: a usable pending login, none, or one too old to finish. */
export type PendingLoginTake =
  | { status: 'ok'; pending: PendingLogin }
  | { status: 'none' }
  | { status: 'expired' };

/** A pending login is good for 10 minutes (TradeSmart's sign-in plus OTP fits easily). */
export const PENDING_LOGIN_MAX_AGE_MS = 10 * 60_000;

/** The TradeSmart account that signed in is not the Client ID typed on /login. */
export class LoginIdentityMismatchError extends KambalaError {
  constructor(signedInAs: string, entered: string) {
    super(`You signed in to TradeSmart as ${signedInAs}, but entered Client ID ${entered}. Please try again.`);
    this.name = 'LoginIdentityMismatchError';
  }
}

const sameId = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const SESSION_STORAGE_KEY = 'ts.optionChain.session.v2';
export const PENDING_LOGIN_KEY = 'ts.optionChain.pendingLogin.v1';
/** The standalone app's dev-server proxy paths (see dev-proxy/proxy-config.mjs). */
export const DEV_PROXY_REST_BASE = '/kambala-api';
export const DEV_PROXY_WS_PATH = '/kambala-ws';
export const AUTH_START_URL = '/auth/start';
export const AUTH_EXCHANGE_URL = '/auth/exchange';

/** Tab-scoped storage (sessionStorage): the session is gone when the tab closes. Null where it is unavailable. */
export const AUTH_SESSION_STORAGE = new InjectionToken<SessionStorageLike | null>('AUTH_SESSION_STORAGE', {
  providedIn: 'root',
  factory: () => {
    try {
      return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
      return null; // access itself can throw (blocked storage)
    }
  },
});

/** The clock for the pending login's age. A token so tests can set the time. */
export const AUTH_NOW = new InjectionToken<() => number>('AUTH_NOW', { providedIn: 'root', factory: () => Date.now });

/** Full-page navigation away from the app (to the proxy's /auth/start). A token so tests can stub it. */
export const AUTH_REDIRECT = new InjectionToken<(url: string) => void>('AUTH_REDIRECT', {
  providedIn: 'root',
  factory: () => (url: string) => {
    window.location.href = url;
  },
});

/** The dev-proxy WebSocket URL on this page's own host: `ws(s)://<host>/kambala-ws`. */
export function wsUrlFor(loc: Pick<Location, 'protocol' | 'host'>): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${DEV_PROXY_WS_PATH}`;
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function isSession(v: unknown): v is AuthSession {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && isStr(o['uid']) && isStr(o['actid']) && isStr(o['accessToken'])
    && !!o['uid'] && !!o['accessToken'];
}

/** What the proxy's POST /auth/exchange answers (normalised from GenAcsTok). */
interface ExchangeResponse {
  stat?: string;
  access_token?: string;
  uid?: string;
  actid?: string;
  emsg?: string;
}

/**
 * The standalone app's login session (TradeSmart v2 OAuth through the dev proxy). Kept in sessionStorage only, so it
 * is scoped to this browser tab. Every storage access is guarded: blocked storage just means an in-memory session.
 * TradeSmart's own app replaces this with its existing auth service (see the INTEGRATION table).
 */
@Injectable({ providedIn: 'root' })
export class AuthSessionService {
  private readonly storage = inject(AUTH_SESSION_STORAGE);
  private readonly injector = inject(Injector);
  private readonly redirect = inject(AUTH_REDIRECT);
  private readonly now = inject(AUTH_NOW);
  private readonly _session = signal<AuthSession | null>(this.read());

  readonly session = this._session.asReadonly();
  readonly isLoggedIn = computed(() => this._session() !== null);

  /**
   * Step 1: remembers `{clientId, returnUrl, createdAt}` for /auth/callback, then sends the browser to /auth/start (the proxy
   * redirects it to TradeSmart's own login page). Returns false, without leaving, when the pending login cannot be
   * stored (blocked storage): the callback would have nothing to finish.
   */
  beginLogin(clientId: string, returnUrl: string): boolean {
    const pending: PendingLogin = { clientId: clientId.trim().toUpperCase(), returnUrl, createdAt: this.now() };
    try {
      if (!this.storage) return false;
      this.storage.setItem(PENDING_LOGIN_KEY, JSON.stringify(pending));
    } catch {
      return false;
    }
    this.redirect(AUTH_START_URL);
    return true;
  }

  /**
   * The pending login, removed as it is read (one use only). 'expired' when it is older than 10 minutes, has no
   * valid `createdAt`, or claims a time in the future (more than a minute of clock slack).
   */
  takePendingLogin(): PendingLoginTake {
    let v: Record<string, unknown> | null;
    try {
      const raw = this.storage?.getItem(PENDING_LOGIN_KEY);
      this.storage?.removeItem(PENDING_LOGIN_KEY);
      if (!raw) return { status: 'none' };
      v = JSON.parse(raw) as Record<string, unknown> | null;
    } catch {
      return { status: 'none' };
    }
    if (!v || typeof v !== 'object' || !isStr(v['clientId']) || !v['clientId'] || !isStr(v['returnUrl'])) {
      return { status: 'none' };
    }
    const createdAt = v['createdAt'];
    const age = typeof createdAt === 'number' && Number.isFinite(createdAt) ? this.now() - createdAt : NaN;
    if (!(age >= -60_000 && age <= PENDING_LOGIN_MAX_AGE_MS)) return { status: 'expired' };
    return { status: 'ok', pending: { clientId: v['clientId'], returnUrl: v['returnUrl'], createdAt: createdAt as number } };
  }

  /**
   * Step 2 (on /auth/callback): exchanges the OAuth code at the proxy, stores the session, then calls UserDetails
   * once to confirm the token (and to read actid when GenAcsTok gave none). The account that signed in must be the
   * Client ID typed on /login (case-insensitive): GenAcsTok's uid, and UserDetails' uid when present, are checked
   * (never actid, which can differ from the login ID), else LoginIdentityMismatchError. Any failure leaves no session and throws: a KambalaError carries
   * Kambala's emsg.
   */
  async completeLogin(code: string, clientId: string): Promise<AuthSession> {
    let res: ExchangeResponse;
    try {
      res = await firstValueFrom(this.injector.get(HttpClient).post<ExchangeResponse>(AUTH_EXCHANGE_URL, { code }));
    } catch (e) {
      const body = e instanceof HttpErrorResponse ? (e.error as ExchangeResponse | null) : null;
      if (body && typeof body === 'object' && body.stat === 'Not_Ok') res = body;
      else throw e;
    }
    if (res.stat !== 'Ok' || !res.access_token) throw new KambalaError(res.emsg || 'Login failed');

    if (res.uid && !sameId(res.uid, clientId)) throw new LoginIdentityMismatchError(res.uid, clientId);

    const uid = res.uid || clientId;
    const session: AuthSession = { uid, actid: res.actid || uid, accessToken: res.access_token };
    this.set(session);
    try {
      // Resolved lazily: the REST client reads NOREN_SESSION_CONFIG, which reads this service.
      const details = await this.injector.get(KambalaRestClient).userDetails();
      // Only the uid identifies the login; an account ID (actid) can legitimately differ from it.
      if (details.uid && !sameId(details.uid, clientId)) throw new LoginIdentityMismatchError(details.uid, clientId);
      if (!res.actid && details.actid && details.actid !== session.actid) {
        this.set({ ...session, actid: details.actid });
      }
    } catch (e) {
      this.logout();
      throw e;
    }
    return this._session()!;
  }

  logout(): void {
    this._session.set(null);
    try {
      this.storage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // storage blocked: nothing was stored
    }
  }

  /** The Noren session config for the REST client and the socket (read on every call / connect). */
  norenConfig(): NorenSessionConfig {
    const s = this._session();
    return {
      url: typeof location === 'undefined' ? '' : wsUrlFor(location),
      uid: s?.uid ?? '',
      actid: s?.actid ?? '',
      accessToken: s?.accessToken ?? '',
      source: 'API', // v2 OAuth API session: the WebSocket connect uses source API
    };
  }

  private set(s: AuthSession): void {
    this._session.set(s);
    try {
      this.storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(s));
    } catch {
      // storage full or blocked: the session lives in memory for this page only
    }
  }

  private read(): AuthSession | null {
    try {
      const raw = this.storage?.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const v: unknown = JSON.parse(raw);
      return isSession(v) ? { uid: v.uid, actid: v.actid || v.uid, accessToken: v.accessToken } : null;
    } catch {
      return null;
    }
  }
}

/**
 * Root-level Kambala wiring for the standalone app: REST through the dev proxy, session from `AuthSessionService`.
 * Used by /auth/callback (UserDetails); the option chain page provides the same tokens itself (see provideOptionChain).
 */
export function provideStandaloneKambalaSession(): Provider[] {
  return [
    { provide: KAMBALA_REST_BASE, useValue: DEV_PROXY_REST_BASE },
    {
      provide: NOREN_SESSION_CONFIG,
      useFactory: () => {
        const injector = inject(Injector);
        return (): NorenSessionConfig => injector.get(AuthSessionService).norenConfig();
      },
    },
  ];
}
