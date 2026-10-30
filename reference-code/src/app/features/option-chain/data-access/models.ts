export interface Underlying {
  sym: string;
  exch: 'NSE' | 'BSE';
  foExch: 'NFO' | 'BFO';
  token: string;
  name: string;
  isIndex: boolean;
}

export interface Expiry {
  /** 'YYYY-MM-DD' */
  iso: string;
  /** Kambala's raw expiry date, 'DD-MMM-YYYY' */
  exd: string;
  /** A trading symbol of this expiry, used as the GetOptionChain anchor. */
  sampleTsym: string;
  foExch: string;
}

export interface ContractRef {
  /** Feed key "EXCH|token" */
  token: string;
  tsym: string;
  lotSize: number;
  tickSize: number;
  pricePrecision: number;
}

export interface ChainStrike {
  strike: number;
  ce: ContractRef | null;
  pe: ContractRef | null;
}

export interface ChainMeta {
  underlying: Underlying;
  expiry: Expiry;
  /** Sorted ascending by strike. */
  strikes: ChainStrike[];
  /** Minimum positive gap between adjacent strikes (0 when fewer than two). */
  strikeStep: number;
}

export const QUICK_UNDERLYINGS: Underlying[] = [
  { sym: 'NIFTY', exch: 'NSE', foExch: 'NFO', token: '26000', name: 'Nifty 50', isIndex: true },
  // INTEGRATION: confirm BSE SENSEX index token and BFO chain lookup (TradeSmart's existing SENSEX chain)
  { sym: 'SENSEX', exch: 'BSE', foExch: 'BFO', token: '1', name: 'BSE Sensex', isIndex: true },
];

/** Feed key of the underlying's spot, "EXCH|token". */
export function underlyingKey(u: Underlying): string {
  return `${u.exch}|${u.token}`;
}

/** Identity of an installed chain, `underlyingKey|expiry.iso` (e.g. "NSE|26000|2026-11-03"). */
export function chainIdentity(meta: ChainMeta): string {
  return `${underlyingKey(meta.underlying)}|${meta.expiry.iso}`;
}

/** A feed key "EXCH|token" split into the exchange and Kambala's raw token (e.g. "NFO|43651" -> NFO, 43651). */
export function splitFeedKey(key: string): { exch: string; rawToken: string } {
  const i = key.indexOf('|');
  return i < 0 ? { exch: '', rawToken: key } : { exch: key.slice(0, i), rawToken: key.slice(i + 1) };
}

/** Feed keys of every contract in the chain (CE then PE per strike). */
export function contractKeys(meta: ChainMeta): string[] {
  const keys: string[] = [];
  for (const s of meta.strikes) {
    if (s.ce) keys.push(s.ce.token);
    if (s.pe) keys.push(s.pe.token);
  }
  return keys;
}
