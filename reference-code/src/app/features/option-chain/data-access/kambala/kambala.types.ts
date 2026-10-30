import { InjectionToken } from '@angular/core';

/** Fields shared by the Kambala touchline ack (`tk`) and feed (`tf`). All values are strings on the wire. */
export interface TouchlineFields {
  /** Price precision */
  pp?: string;
  /** Tick size */
  ti?: string;
  /** Lot size */
  ls?: string;
  /** LTP */
  lp?: string;
  /** % change */
  pc?: string;
  /** Volume */
  v?: string;
  /** Open, high, low, close (close = previous close) */
  o?: string;
  h?: string;
  l?: string;
  c?: string;
  /** Open interest and previous-day closing OI */
  oi?: string;
  poi?: string;
  /** Best bid/ask price and quantity (level 1) */
  bp1?: string;
  sp1?: string;
  bq1?: string;
  sq1?: string;
  /** Feed time */
  ft?: string;
}

export interface TouchlineAck extends TouchlineFields {
  t: 'tk';
  /** Exchange */
  e: string;
  /** Token (unique per exchange only) */
  tk: string;
  /** Trading symbol */
  ts?: string;
}

export interface TouchlineFeed extends TouchlineFields {
  t: 'tf';
  e: string;
  tk: string;
}

export interface OptionChainRow {
  exch: string;
  tsym: string;
  token: string;
  optt: string;
  strprc: string;
  pp: string;
  ti: string;
  ls: string;
}

export interface LinkedScripsResponse {
  stat?: string;
  opt_exp: { exd: string; exch: string; tsym: string }[];
  equls?: { exch: string; tsym: string; token: string; pp: string; ti: string; ls: string; mult: string }[];
  fut?: { exch: string; tsym: string; token: string; exd: string; pp: string; ti: string; ls: string; mult: string }[];
}

export interface ScripSearchResult {
  exch: string;
  tsym: string;
  token: string;
  name: string;
}

export class KambalaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KambalaError';
  }
}

export class SessionExpiredError extends KambalaError {
  constructor(message = 'Session Expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * Session/connection details for the Kambala (Noren) API. The login method is chosen by the shape:
 * - **TradeSmart v2 OAuth** (the standalone app): `accessToken` is set. REST calls send
 *   `Authorization: Bearer <accessToken>` and no jKey; the WebSocket connect message is
 *   `{t:"a", uid, actid, source:"API", accesstoken}`, acknowledged with `t:"ak"`.
 * - **Legacy Noren session** (e.g. TradeSmart's own web session): `susertoken` only. REST calls send it as
 *   `jKey`; the connect message is `{t:"c", uid, actid, source, susertoken}`, acknowledged with `t:"ck"`.
 */
export interface NorenSessionConfig {
  /** WebSocket URL, e.g. wss://host/NorenWSAPI/ */
  url: string;
  uid: string;
  actid: string;
  /** v2 OAuth access token (GenAcsTok). When set, the v2 auth path is used everywhere. */
  accessToken?: string;
  /** Legacy Noren session token: `jKey` on REST calls and `susertoken` on the WebSocket connect message. */
  susertoken?: string;
  /** Heartbeat interval in ms. Kambala does not document one; default 30000. */
  heartbeatMs?: number;
  /** `source` on the WebSocket connect message; it should match the login's source. Default 'API' with an
   *  accessToken, else 'WEB'. */
  source?: string;
}

/**
 * A getter, read on every WebSocket connect and every REST call, so a token refreshed by re-login is picked up
 * without recreating the page.
 */
// INTEGRATION: provided by TradeSmart auth/session service, as a getter of the current session (refresh it after
// re-login, then call ChainFeedFacade.reconnect()). Give `accessToken` for a v2 OAuth session (Bearer REST, t:"a"
// WebSocket connect) or only `susertoken` for a legacy Noren web session (jKey REST, t:"c" connect): see above.
export const NOREN_SESSION_CONFIG = new InjectionToken<() => NorenSessionConfig>('NOREN_SESSION_CONFIG');

/** UserDetails: the fields the option chain reads (`exarr`: enabled exchanges). */
export interface UserDetailsResult {
  uid?: string;
  actid?: string;
  uname?: string;
  exarr?: string[];
}

/** One GetIndexList row: index name and the token used to subscribe. */
export interface IndexListEntry {
  idxname: string;
  token: string;
}
