import type { KambalaRestApi } from '../kambala/kambala-rest.client';
import type { IndexListEntry, LinkedScripsResponse, OptionChainRow, ScripSearchResult } from '../kambala/kambala.types';
import { QUICK_UNDERLYINGS } from '../models';
import type { MockMarket } from './mock-market';

/** Same public API as `KambalaRestClient`, answered from a `MockMarket` (for `?feed=mock`). */
export class MockKambalaRestClient implements KambalaRestApi {
  constructor(private readonly market: MockMarket) {}

  getLinkedScrips(exch: string, token: string): Promise<LinkedScripsResponse> {
    return Promise.resolve(this.market.linkedScrips(exch, token));
  }

  getOptionChain(exch: string, tsym: string, strprc: number, cnt: number): Promise<OptionChainRow[]> {
    return Promise.resolve(this.market.optionChain(exch, tsym, strprc, cnt));
  }

  searchScrip(text: string): Promise<ScripSearchResult[]> {
    return Promise.resolve(this.market.search(text));
  }

  /** The quick underlyings' built-in tokens, named as Kambala names them ("Nifty 50", "SENSEX"). */
  getIndexList(exch: string): Promise<IndexListEntry[]> {
    const names: Record<string, string> = { NIFTY: 'Nifty 50', SENSEX: 'SENSEX' };
    return Promise.resolve(
      QUICK_UNDERLYINGS.filter((u) => u.exch === exch).map((u) => ({ idxname: names[u.sym] ?? u.name, token: u.token })),
    );
  }
}
