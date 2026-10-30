import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  IndexListEntry, KambalaError, LinkedScripsResponse, NOREN_SESSION_CONFIG, OptionChainRow, ScripSearchResult,
  SessionExpiredError, UserDetailsResult,
} from './kambala.types';
// Shared with the dev-server proxy, so both send the same bytes (raw JSON, & % + as unicode escapes).
import { kambalaFormBody } from './kambala-form.mjs';

/**
 * Kambala REST base: the full path up to the endpoint name, e.g. `https://host/NorenWClientAPIv2`. Calls go to
 * `${base}/${endpoint}`. The standalone app uses its dev-server proxy (`/kambala-api`).
 */
// INTEGRATION: provided by TradeSmart's config or auth service (REST base URL, full path, e.g. https://host/NorenWClientAPIv2)
export const KAMBALA_REST_BASE = new InjectionToken<string>('KAMBALA_REST_BASE');

interface KambalaEnvelope {
  stat?: string;
  emsg?: string;
}

/** The REST surface the feature uses (the mock client implements exactly this). */
export type KambalaRestApi = Pick<KambalaRestClient, 'getLinkedScrips' | 'getOptionChain' | 'searchScrip' | 'getIndexList'>;

const FORM = new HttpHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' });

/** Kambala's wording for a dead session or token (v1 "Session Expired", v2 "Invalid Token" / "invalid access token"). */
const SESSION_GONE = /session expired|invalid (access )?token/i;

@Injectable({ providedIn: 'root' })
export class KambalaRestClient {
  private readonly http = inject(HttpClient);
  private readonly base = inject(KAMBALA_REST_BASE);
  // INTEGRATION: uid and token come from the app's auth service: accessToken (v2: Bearer header) or susertoken (legacy: jKey)
  private readonly session = inject(NOREN_SESSION_CONFIG); // a getter: read per call

  /** UserDetails: confirms the token and gives actid / exarr. */
  userDetails(): Promise<UserDetailsResult> {
    return this.call<UserDetailsResult>('UserDetails', {});
  }

  async getIndexList(exch: string): Promise<IndexListEntry[]> {
    const res = await this.call<{ values?: IndexListEntry[] }>('GetIndexList', { exch });
    return res.values ?? [];
  }

  getLinkedScrips(exch: string, token: string): Promise<LinkedScripsResponse> {
    return this.call<LinkedScripsResponse>('GetLinkedScrips', { exch, token });
  }

  async getOptionChain(exch: string, tsym: string, strprc: number, cnt: number): Promise<OptionChainRow[]> {
    const res = await this.call<{ values?: OptionChainRow[] }>('GetOptionChain', {
      tsym, exch, strprc: String(strprc), cnt: String(cnt),
    });
    return res.values ?? [];
  }

  async searchScrip(text: string): Promise<ScripSearchResult[]> {
    type SearchRes = {
      values?: { exch: string; tsym: string; token: string; cname?: string; symname?: string }[];
    };
    let res: SearchRes;
    try {
      res = await this.call<SearchRes>('SearchScrip', { stext: text });
    } catch (e) {
      // Kambala reports "No Data :" as Not_Ok when nothing matches: that is an empty result.
      if (e instanceof KambalaError && !(e instanceof SessionExpiredError) && e.message.startsWith('No Data')) {
        return [];
      }
      throw e;
    }
    return (res.values ?? []).map((v) => ({
      exch: v.exch,
      tsym: v.tsym,
      token: v.token,
      name: v.cname ?? v.symname ?? v.tsym,
    }));
  }

  /**
   * jData always carries `uid`. A v2 session (accessToken) sends `Authorization: Bearer <token>` and no jKey; a
   * legacy session (susertoken only) sends the token as `jKey`.
   */
  private call<T extends object>(endpoint: string, data: Record<string, string>): Promise<T> {
    const session = this.session();
    const jData = { uid: session.uid, ...data };
    if (session.accessToken) {
      return this.post<T>(endpoint, kambalaFormBody(jData), FORM.set('Authorization', `Bearer ${session.accessToken}`));
    }
    return this.post<T>(endpoint, kambalaFormBody(jData, session.susertoken ?? ''), FORM);
  }

  private async post<T extends object>(endpoint: string, body: string, headers: HttpHeaders): Promise<T> {
    let res: T & KambalaEnvelope;
    try {
      res = await firstValueFrom(this.http.post<T & KambalaEnvelope>(`${this.base}/${endpoint}`, body, { headers }));
    } catch (e) {
      // The v2 server (and the dev proxy) answer Not_Ok with an HTTP error status: surface Kambala's message.
      const env = e instanceof HttpErrorResponse ? (e.error as KambalaEnvelope | null) : null;
      const notOk = !!env && typeof env === 'object' && env.stat === 'Not_Ok';
      if (e instanceof HttpErrorResponse && e.status === 401) {
        throw new SessionExpiredError(notOk && env!.emsg ? env!.emsg : 'Session Expired');
      }
      if (notOk) res = env as T & KambalaEnvelope;
      else throw e;
    }
    if (res.stat === 'Not_Ok') {
      const emsg = res.emsg ?? 'Not_Ok';
      if (SESSION_GONE.test(emsg)) throw new SessionExpiredError(emsg);
      throw new KambalaError(emsg);
    }
    return res;
  }
}
