import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable, InjectionToken } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  KambalaError, LinkedScripsResponse, NOREN_SESSION_CONFIG, OptionChainRow, ScripSearchResult,
  SessionExpiredError,
} from './kambala.types';

// INTEGRATION: provided by TradeSmart auth/session service (REST base URL, e.g. https://host)
export const KAMBALA_REST_BASE = new InjectionToken<string>('KAMBALA_REST_BASE');

interface KambalaEnvelope {
  stat?: string;
  emsg?: string;
}

/** The REST surface the feature uses (the mock client implements exactly this). */
export type KambalaRestApi = Pick<KambalaRestClient, 'getLinkedScrips' | 'getOptionChain' | 'searchScrip'>;

@Injectable({ providedIn: 'root' })
export class KambalaRestClient {
  private readonly http = inject(HttpClient);
  private readonly base = inject(KAMBALA_REST_BASE);
  // INTEGRATION: uid and session token (jKey) come from the app's auth service
  private readonly session = inject(NOREN_SESSION_CONFIG); // a getter: read per call

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

  private async call<T extends object>(endpoint: string, data: Record<string, string>): Promise<T> {
    const session = this.session();
    const jData = { uid: session.uid, ...data };
    const body =
      `jData=${encodeURIComponent(JSON.stringify(jData))}` +
      `&jKey=${encodeURIComponent(session.susertoken)}`;
    const res = await firstValueFrom(
      this.http.post<T & KambalaEnvelope>(`${this.base}/NorenWClientTP/${endpoint}`, body, {
        headers: new HttpHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      }),
    );
    if (res.stat === 'Not_Ok') {
      const emsg = res.emsg ?? 'Not_Ok';
      if (emsg.includes('Session Expired')) throw new SessionExpiredError(emsg);
      throw new KambalaError(emsg);
    }
    return res;
  }
}
