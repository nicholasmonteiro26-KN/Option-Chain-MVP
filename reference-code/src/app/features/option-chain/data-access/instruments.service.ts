import { inject, Injectable } from '@angular/core';
import { DEFAULT_CONFIG } from '@option-analytics/config';
import { minStrikeStep } from '@option-analytics/strikes';
import { expiryInstantMs, isExpired } from '@option-analytics/time';
import { KambalaRestClient } from './kambala/kambala-rest.client';
import { ChainMeta, ChainStrike, ContractRef, Expiry, Underlying } from './models';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Kambala "DD-MMM-YYYY" (month case-insensitive) -> "YYYY-MM-DD", or null if unparseable. */
export function parseExd(exd: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(exd.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2]!.toUpperCase());
  const year = Number(m[3]);
  if (month < 0) return null;
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

@Injectable({ providedIn: 'root' })
export class InstrumentsService {
  private readonly rest = inject(KambalaRestClient);

  /** Expiries from GetLinkedScrips `opt_exp`: unparseable and expired dropped, de-duplicated, ascending. */
  async loadExpiries(u: Underlying, nowMs: number): Promise<Expiry[]> {
    const res = await this.rest.getLinkedScrips(u.exch, u.token);
    const byIso = new Map<string, Expiry>();
    for (const row of res.opt_exp ?? []) {
      const iso = parseExd(row.exd);
      if (!iso || byIso.has(iso)) continue;
      if (isExpired(nowMs, expiryInstantMs(iso), DEFAULT_CONFIG.minTimeToExpirySec)) continue;
      byIso.set(iso, { iso, exd: row.exd, sampleTsym: row.tsym, foExch: row.exch });
    }
    return [...byIso.values()].sort((a, b) => (a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0));
  }

  /** Contracts from GetOptionChain around `spot`, paired CE/PE per strike, ascending. */
  async loadChain(u: Underlying, e: Expiry, spot: number, cnt: number): Promise<ChainMeta> {
    const rows = await this.rest.getOptionChain(e.foExch, e.sampleTsym, Math.round(spot), cnt);
    const byStrike = new Map<number, ChainStrike>();
    for (const row of rows) {
      const strike = +row.strprc;
      if (!Number.isFinite(strike)) continue;
      const side = row.optt === 'CE' ? 'ce' : row.optt === 'PE' ? 'pe' : null;
      if (!side) continue;
      let entry = byStrike.get(strike);
      if (!entry) {
        entry = { strike, ce: null, pe: null };
        byStrike.set(strike, entry);
      }
      const ref: ContractRef = {
        token: `${row.exch}|${row.token}`,
        tsym: row.tsym,
        lotSize: +row.ls,
        tickSize: +row.ti,
        pricePrecision: +row.pp,
      };
      entry[side] = ref;
    }
    const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    return { underlying: u, expiry: e, strikes, strikeStep: minStrikeStep(strikes.map((s) => s.strike)) };
  }
}
