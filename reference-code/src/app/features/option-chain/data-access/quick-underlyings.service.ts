import { computed, Injectable, signal } from '@angular/core';
import { IndexListEntry, KambalaError, SessionExpiredError } from './kambala/kambala.types';
import { QUICK_UNDERLYINGS, Underlying, underlyingKey } from './models';

/** The REST call index resolution needs (the real and the mock client both have it). */
export interface IndexListApi {
  getIndexList(exch: string): Promise<IndexListEntry[]>;
}

export const SENSEX_UNAVAILABLE = 'SENSEX not available for this account';

const NIFTY_NAME = /^nifty 50$/i;
const SENSEX_NAME = /^(s&p )?(bse )?sensex$/i;

/** Kambala's "nothing to list" answers (Not_Ok with no data) as opposed to a failed call. */
function isNoData(e: unknown): boolean {
  return e instanceof KambalaError && !(e instanceof SessionExpiredError) && /no data/i.test(e.message);
}

/**
 * The quick-switch underlyings with this account's index tokens: NIFTY from GetIndexList('NSE') ("Nifty 50"),
 * SENSEX from GetIndexList('BSE') ("SENSEX", any case). A SENSEX missing from the BSE list is marked unavailable;
 * a failed NSE call keeps NIFTY's documented token (26000) and a failed BSE call marks SENSEX unavailable, with a
 * console warning (no request details).
 */
export async function resolveQuickUnderlyings(api: IndexListApi): Promise<Underlying[]> {
  const [nse, bse] = await Promise.allSettled([api.getIndexList('NSE'), api.getIndexList('BSE')]);
  const failures: string[] = [];

  const resolved = QUICK_UNDERLYINGS.map((u): Underlying => {
    const res = u.exch === 'NSE' ? nse : bse;
    const pattern = u.sym === 'NIFTY' ? NIFTY_NAME : SENSEX_NAME;
    if (res.status === 'rejected') {
      if (!(u.sym === 'SENSEX' && isNoData(res.reason))) {
        failures.push(`${u.exch} (${res.reason instanceof Error ? res.reason.name : 'error'})`);
      }
      // SENSEX has no documented token ('1' is a placeholder): never subscribe a guess. NIFTY keeps 26000, NSE's
      // documented Nifty 50 token.
      return u.sym === 'SENSEX' ? { ...u, token: '', unavailable: SENSEX_UNAVAILABLE } : { ...u };
    }
    const hit = res.value.find((e) => pattern.test(String(e.idxname ?? '').trim()));
    if (hit?.token) return { ...u, token: String(hit.token) };
    if (u.sym === 'SENSEX') return { ...u, token: '', unavailable: SENSEX_UNAVAILABLE };
    failures.push(`${u.exch} (no "${u.name}" in the list)`);
    return { ...u };
  });

  if (failures.length > 0) {
    console.warn(
      `[option-chain] GetIndexList did not give every quick underlying's token (${failures.join(', ')}); `
      + 'NIFTY keeps the built-in token 26000, SENSEX is shown as unavailable.',
    );
  }
  return resolved;
}

/**
 * The quick-switch underlyings (NIFTY, SENSEX) as a signal. Starts with the built-in tokens; with live data the
 * page calls `resolve()` after login and before its first select. Provided by each option chain page (and in root,
 * for tests and standalone use).
 */
@Injectable({ providedIn: 'root' })
export class QuickUnderlyingsService {
  private readonly _list = signal<readonly Underlying[]>(QUICK_UNDERLYINGS);
  readonly list = this._list.asReadonly();
  /** Feed keys of the usable quick underlyings (kept subscribed for their live prices). */
  readonly keys = computed(() => this._list().filter((u) => !u.unavailable).map(underlyingKey), {
    equal: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]),
  });

  private readonly _ready = signal(true);
  /** False while live-data tokens are pending: the quick keys are not subscribed until then. */
  readonly ready = this._ready.asReadonly();

  /** Live data: hold the quick keys back until `resolve()` has settled. */
  expectResolution(): void {
    this._ready.set(false);
  }

  async resolve(api: IndexListApi): Promise<void> {
    try {
      this._list.set(await resolveQuickUnderlyings(api));
    } finally {
      this._ready.set(true);
    }
  }
}
