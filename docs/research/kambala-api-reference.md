# Kambala (Noren) API Reference: Option Chain Subset

Source: `Kambala API Doc (2).md` (OCR conversion of the vendor PDF). Line numbers (`L123`) point into that file. The OCR stripped the spaces, so the descriptions below are re-spaced. Field names are as printed.

Conventions used here:
- **Required** = `Y` when the doc marks the field with `*`, `N` when it has no `*`. Treat "N" as "not marked", not as "confirmed optional".
- "(inferred)" marks anything the doc does not state outright.
- The PDF could not be rendered in this environment (no poppler or Python), so all findings come from the `.md` file. Items marked "verify in PDF" should be re-checked against the original.

---

## 0. Transport and encoding

| Item | Value | Ref |
|---|---|---|
| Method | HTTP POST to `/NorenWClientTP/<Endpoint>` | e.g. L964, L1294 |
| Body | `jData=<json>&jKey=<susertoken>` (form-encoded) | L1198-1200, L1306-1307 |
| Example base URL (REST) | `https://apitest.kambala.co.in/NorenWClientTP/...` (test env) | L230, L1659, L4336 |
| Example WebSocket URL | `wss://api.broker1.com/NorenStream/NorenWS` (placeholder host) | L4778 |
| Values | Everything is sent and returned as **strings**, e.g. `"lp":"0.00"`, `"token":"22"`. "One or more input parameters are not in string format" is a listed error. | L302-303, L1406-1412 |
| Special chars | URL-encode `tsym` for symbols such as `M&M` | L1594-1595, L3901-3903 |
| Success / failure | `stat` = `Ok` / `Not_Ok`; `emsg` present only on failure | throughout |
| Session expiry error | `"emsg":"Session Expired : Invalid Session Key"` (OCR: `SessionExpired:InvalidSessionKey`) | L560, L738, L3814, L4164 |

Common errors for any API (L288-341): `Invalid Input : Missing jData`, `Invalid Input : jData is not valid json object`, `Invalid Input : <field> is Missing.`, `Invalid Input : One or more input parameters are not in string format`, `Invalid Input : Invalid App Key`, `Invalid Input : Invalid Vendor code`, `Server Timeout :` / `Error Occurred : 1 "unknown request"` (OMS down, EOD/BOD window), `Invalid Input : Invalid Access Type` (API URL mismatch). Typical no-data error: `Error Occurred : 5 "no data"` (L1291, L1450).

---

## 1. Login (QuickAuth): only what the option chain needs

URI: `/NorenWClientTP/QuickAuth` (L202). The request needs `apkversion, uid, pwd (SHA-256), factor2, vc, appkey (SHA-256 of uid|vendor_key), imei, source` (L209-226). In TradeSmart these are handled by the existing login flow.

| Response field | Description | Ref |
|---|---|---|
| `susertoken` | Session token. Present only when login succeeds. Send it as `jKey` on every later REST call and as `susertoken` in the WebSocket connect message. | L239-241 |
| `uid` | User Id (send it as `uid` in jData) | L263 |
| `actid` | Account id (needed for PlaceOrder, GetBasketMargin, WS connect) | L260 |
| `exarr` | JSON array of enabled exchanges | L256 |
| `prarr` | Array of enabled products | L258 |
| `emsg` | Present only when login fails | L265 |

Session expiry: any authenticated call can return `{"stat":"Not_Ok","emsg":"Session Expired : Invalid Session Key"}`. The doc defines no refresh endpoint, so the user must log in again.

---

## 2. Scrip discovery and quotes

### 2.1 SearchScrip: `/NorenWClientTP/SearchScrip` (L963-1080)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | Logged in user id |
| `stext` | Y | string | Search text |
| `exch` | N | NSE/BSE/NFO... from `exarr` | Exchange |

Response: `stat`, `values[]`, `emsg` (Invalid Input / Session Expired). Fields in `values[]`:
| Field | Description |
|---|---|
| `exch` | Exchange |
| `tsym` | Trading symbol |
| `token` | Contract token |
| `pp` | Price precision |
| `ti` | Tick size |
| `ls` | Lot size |
| `weekly` | Weekly option marker: `W1`..`W4` |
| `nontrd` | Non-tradable instrument flag |

No-data failure: `"emsg":"No Data :"` (L1079).

### 2.2 GetSecurityInfo: `/NorenWClientTP/GetSecurityInfo` (L1183-1292)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `exch` | N (not marked) | string | Exchange |
| `token` | N (not marked) | string | Contract token |

Example: `jData={"uid":"{{USER_ID}}","exch":"NSE","token":"22"}&jKey=...` (L1198).

Response fields (L1206-1263): `request_time, stat, exch, tsym, cname, symnam` (sample uses `symname`), `seg, exd` (expiry date), `instname, strprc, optt, isin, ti, ls, pp, mult, gp_nd, prcunt, prcqqty, trdunt, delunt, frzqty, gsmind, elmbmrg, elmsmrg, addbmrg, addsmrg, splbmrg, splsmrg, delmrg, tenmrg, tenstrd, tenendd, exestrd, exeendd, mkt_t, issue_d, listing_d, last_trd_d, elmmrg, varmrg, expmrg, token, prcftr_d, weekly, nontrd, dname, uc, lc, ord_msg`.

The fields relevant to the option chain:
| Field | Description |
|---|---|
| `exd` | Expiry date. The format is not stated; GetOptionGreek expects the same value (inferred). |
| `strprc` | Strike price |
| `optt` | Option type (CE/PE, inferred from SpanCalc L4408) |
| `ls` | Lot size |
| `frzqty` | Freeze qty (useful for order slicing) |
| `last_trd_d` | Last trading date |
| `uc` / `lc` | Upper / lower circuit (added 7 Feb 2023, L143) |

### 2.3 GetQuotes: `/NorenWClientTP/GetQuotes` (L1293-1451)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `exch` | N (not marked) | string | Exchange |
| `token` | N (not marked) | string | Contract token |

Response fields (L1316-1385):
| Field | Description |
|---|---|
| `stat`, `request_time` | Status, time |
| `exch`, `tsym`, `cname`, `symname`, `seg`, `instname`, `isin` | Identity |
| `pp`, `ls`, `ti`, `mult`, `prcftr_d` | Precision, **lot size**, tick, multiplier, price factor |
| `uc`, `lc` | Circuit limits |
| `token` | Token |
| `lp` | LTP |
| `o`, `c`, `h`, `l` | Open, **Close (previous close; added 27 Feb 2023, L160)**, High, Low |
| `v` | Volume |
| `ap` | Average trade price / VWAP |
| `ltq`, `ltt`, `ltd` | Last trade qty, time, date (`dd-mm-yy`) |
| `bp1..bp5`, `sp1..sp5` | Best bid/ask prices 1-5 |
| `bq1..bq5`, `sq1..sq5` | Best bid/ask qty 1-5 |
| `bo1..bo5`, `so1..so5` | Best bid/ask order counts 1-5 |
| `und_exch`, `und_tk` | Underlying exchange segment and token (added 22 Feb, L148) |
| `ord_msg` | Order message (added 21 Apr 2023, L165) |
| `sptprc` | Spot price. **[#] disabled by default; enabled on request** (L1384-1385) |

Not documented in GetQuotes: **`oi`, `poi`, `toi`, `exd`/expiry, `strprc`, `optt`**. The 08 May 2023 changelog entry "Added new fields in /GetQuotes, /MarketWatch, /Holdings and /ExchStatus" (L175-177) names no fields, and the GetQuotes table was not updated. The MarketWatch table did gain `oi` [#] (L910). It is possible that GetQuotes returns `oi` but this is undocumented. **Gap.**

Sample bug: the sample response has `"So5"` (capital S, L1444). The real key is `so5` (inferred).

---

## 3. Option chain building blocks

### 3.1 GetIndexList: `/NorenWClientTP/GetIndexList` (L3817-3890)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `exch` | Y | NSE / BSE ... | Exchange |

Response: `stat`, `values[]` of `{ idxname, token }` ("Index token used to subscribe"), `request_time`, `emsg`.
Sample (NSE): `Nifty 50`→`26000`, `Nifty Bank`→`26009`, `Nifty IT`→`26008`, `India VIX`→`26017`, `Nifty Next 50`→`26013`, and others (L3846-3889). The doc gives **no BSE sample**. Calling with `exch:"BSE"` should return SENSEX (inferred), but this is unverified.

### 3.2 GetLinkedScrips: `/NorenWClientTP/GetLinkedScrips` (L3939-4007)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `token` | Y | string | The doc's description is copy-pasted from GetOptionChain ("Trading symbol of any of the options or future..."). Whether to send a token or a tsym is **ambiguous**. |
| `exch` | Y | NFO/CDS/MCX... | Exchange |

Response: `stat`, `equls[]`, `fut[]`, `opt_exp[]`, `emsg`.
| Array | Fields |
|---|---|
| `equls` | `exch, tsym, token, pp, ti, ls, mult` (underlying cash scrip) |
| `fut` | `exch, tsym, token, exd, pp, ti, ls, mult` |
| `opt_exp` | `exd` ("Used for calling option chain API"), `exch`, `tsym` ("One of the random trading symbols on given expiry, useful in calling option chain"). "Used to show dropdown in option chain" (L3998). |

The doc has no sample request or response. The doc also does not say which exchange/token to pass for an index (e.g. `NSE|26000` or an NFO contract). **Gap.**

### 3.3 GetOptionChain: `/NorenWClientTP/GetOptionChain` (L3891-3937)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `tsym` | Y | string, URL-encoded | Trading symbol of any option or future of the underlying. The chain for that underlying is returned. Expiry is chosen through the tsym (inferred from `opt_exp.tsym`). |
| `exch` | Y | NFO / CDS / MCX / (BFO, inferred) | Must be an options exchange |
| `strprc` | Y | string number | Mid price around which the strikes are selected |
| `cnt` | Y | string int | Strikes per side of mid, for each of CE and PE. `cnt=4` gives 16 contracts and `cnt=5` gives 20 (total = 4 x cnt). |

Response: `stat`, `values[]`, `emsg` (Invalid Input / Session Expired). Fields in `values[]`:
| Field | Description |
|---|---|
| `exch` | Exchange |
| `tsym` | Trading symbol |
| `token` | Token (use it for WS `k`) |
| `optt` | Option type |
| `strprc` | Strike price |
| `pp`, `ti`, `ls` | Precision, tick, lot size |

**It returns no prices, OI, volume, or expiry field.** Prices must come from GetQuotes or the WS touchline. The doc states **no maximum for `cnt`**. **Gap.** It also has no sample.

### 3.4 GetUnderlyingExchToken: `/NorenWClientTP/GetUnderlyingExchToken` (L4079-4117)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | N (not marked) | string | User id |
| `exch` | Y | string | Exchange |
| `token` | Y | string | Token (of a derivative, inferred) |

`jKey` is not marked required here (L4087), probably an OCR omission (inferred).
Response: `stat`, `request_time`, `und_exch`, `und_tk`, `emsg`. Sample: `{"stat":"Ok","und_exch":"NSE","und_tk":"26009"}`. Error: `Invalid Input : Invalid Scrip token/exch`.

### 3.5 ExchangeStatus: `/NorenWClientTP/ExchStatus` (L4118-4165)

Request: `uid` (Y).
Response (array): `stat, exch, exchstat` (e.g. `OPEN`), `exchtype` (e.g. `NORMAL`), and, [#] on request only: `description, norentm, noren_nsecs, exch_tm`. Added 08 May 2023 (L173). **The doc gives no market hours.** WS also pushes `t:"ms"` market status updates (`e, mkt_s, mkt_t, desc`; L5225-5235).

---

## 4. Charts

### 4.1 TPSeries (intraday): `/NorenWClientTP/TPSeries` (L4203-4320)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `exch` | Y | string | Exchange |
| `token` | Y | string | Token (no description) |
| `st` | N (not marked) | epoch seconds | Start time |
| `et` | N (not marked) | epoch seconds | End time |
| `intrv` | N | `"1","3","5","10","15","30","60","120","240"` | Candle minutes, default `"1"` |

Response: an array of `{ stat, time ("DD/MM/CCYY hh:mm:ss"; the sample uses dd-mm-yyyy), into, inth, intl, intc, intvwap, intv, v, intoi, oi }`.
- `intoi`: "Interval oi change" (L4244)
- `oi`: open interest (L4245)
- `v`: cumulative day volume (inferred from the sample)
- The sample is in reverse chronological order (newest first).

### 4.2 EODChartData: `/NorenWClientTP/EODChartData` (L4321-4380)

Request:
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `sym` | Y | `"EXCH:TSYM"` e.g. `NSE:RELIANCE-EQ` | Symbol |
| `from` | Y | epoch seconds (number in sample) | From date |
| `to` | Y | epoch seconds | To date |

`uid` does not appear in the request. Response: an array of **JSON strings** (each element is a stringified object) with `time` (`DD-MON-YYYY`), `into, inth, intl, intc, ssboe, intv`. **There is no `oi` field in EOD data.**

---

## 5. GetOptionGreek: `/NorenWClient/GetOptionGreek` (L4427-4504)

**URI confirmed as printed: `/NorenWClient/GetOptionGreek` (no `TP`, L4428).** Every other endpoint uses `/NorenWClientTP/`. Kambala must confirm whether this is a typo.

Request (no `uid` is listed):
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `exd` | Y | Format **not stated** | Expiry date. Possibly `DD-MON-YYYY` as in SpanCalc (L4407) (inferred). |
| `strprc` | Y | string number | Strike |
| `sptprc` | Y | string number | Spot price |
| `int_rate` | Y | Format **not stated** (percent vs decimal unknown) | "Init Rate" (interest rate) |
| `volatility` | Y | Format **not stated** | Volatility (an **input**) |
| `optt` | N (not marked) | CE/PE (inferred) | Option type |

Response: `stat, request_time, cal_price, put_price, cal_delta, put_delta, cal_gamma, put_gamma, cal_theta, put_theta, cal_rho, put_rho, cal_vego, put_vego`. Note **`vego`** (not `vega`) and the prefix **`cal_`** (not `call_`). The call and put values come back together, so `optt` may be ignored (inferred).
Sample: `"stat":"OK"` (upper-case, unlike other endpoints) and `cal_vego/put_vego:"0.006307"`. Failure: `Invalid Input : jData is Missing.`

---

## 6. Order-related (request fields only)

### 6.1 PlaceOrder: `/NorenWClientTP/PlaceOrder` (L1575-1684)

| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `actid` | Y | string | Account id |
| `exch` | Y | NSE/NFO/BSE/MCX (from `exarr`) | Exchange |
| `tsym` | Y | URL-encoded | Contract |
| `qty` | Y | string | Quantity |
| `prc` | Y | string | Price (the curl sample wrongly uses `price`, L1661) |
| `trgprc` | N | string | Only for SL-LMT / SL-MKT |
| `dscqty` | N | string | Disclosed qty |
| `prd` | Y | C / M / H (also I, B per prarr) | C=Delivery, M=Margin(NRML), H=Cover |
| `trantype` | Y | B / S | Buy / Sell |
| `prctyp` | Y | LMT / MKT / SL-LMT / SL-MKT / DS / 2L / 3L | Price type |
| `mkt_protection` | N | percent | MKT orders on BSE/BFO/BCS/MCX only |
| `ret` | Y | DAY / EOS / IOC | Retention |
| `remarks` | N | string | User tag |
| `ordersource` | N | MOB / WEB / TT | Listed twice |
| `bpprc`, `blprc`, `trailprc` | N | string | Bracket and high-leverage legs |
| `ext_remarks`, `cl_ord_id`, `channel`, `usr_agent`, `app_inst_id` | N | string | Meta (cl_ord_id/ext_remarks added 27 Apr 2023) |
| `amo` | N | `Yes` | AMO flag |
| `tsym2, trantype2, qty2, prc2` | Cond. | string | Required for 2L/3L |
| `tsym3, trantype3, qty3, prc3` | Cond. | string | Required for 3L |
| `algo_id`, `naic_code`, `instname` | N | string | Algo/regulatory |

Response: `stat`, `request_time`, `norenordno` (on success), `emsg`.

### 6.2 GetBasketMargin: `/NorenWClientTP/GetBasketMargin` (L1893-1979)

Top-level (first leg):
| Field | Required | Type/Values | Description |
|---|---|---|---|
| `uid` | Y | string | User id |
| `actid` | Y | string | Account |
| `exch` | Y | NSE/NFO/BSE/MCX | Exchange |
| `tsym` | Y | URL-encoded | Contract |
| `qty` | Y | string | Qty |
| `prc` | Y | string | Price |
| `trgprc` | N | string | SL only |
| `prd` | Y | C/M/H | Product |
| `trantype` | Y | B/S | Side |
| `prctyp` | Y | LMT/MKT/SL-LMT/SL-MKT | Price type |
| `blprc` | N | string | H/B only |
| `rorgqty`, `fillshares`, `rorgprc`, `orgtrgprc`, `norenordno`, `snonum` | N | string | Modify-order context only |
| `basketlists` | N | array | Additional legs |

`basketlists[]` items: `exch*`, `tsym*`, `qty*`, `prc*`, `trgprc`, `prd*`, `trantype*`, `prctyp*`.
Response (for reference): `stat, request_time, remarks, marginused, marginusedtrade`.

---

## 7. WebSocket (L4777-5235)

URL (example): `wss://api.broker1.com/NorenStream/NorenWS`. All messages are JSON. An ATO price is sent as `"42949672.95"` (L4783).

### 7.1 Connect (send first, immediately after open)
| Field | Value | Description |
|---|---|---|
| `t` | `"c"` | Connect task |
| `uid` | string | User id |
| `actid` | string | Account id |
| `source` | `WEB` / `MOB` | Must match the login source (`API` for API logins, inferred) |
| `susertoken` | string | Session token from QuickAuth |

Ack: `{ t:"ck", uid, s:"Ok" | "Not_Ok" }`. `Not_Ok` means an invalid user or session.

### 7.2 Key format `k`
`EXCH|TOKEN` joined with `#`, for example `NSE|22#BSE|508123#NFO|12345#NSE|26000`. The doc's touchline example also shows `NSE|NIFTY` (L4804), which suggests a symbol may be accepted in place of a token for indices (unverified). Token form is recommended.

### 7.3 SubscribeTouchline: request `{ t:"t", k:"..." }`
You get one ack per scrip in `k`.

Ack `t:"tk"` fields (L4808-4835):
| Field | Description |
|---|---|
| `t` | `tk` |
| `e` | Exchange |
| `tk` | Token |
| `pp` | Price precision (2 for NSE/BSE, 4 for CDS USDINR) |
| `ts` | Trading symbol |
| `ti` | Tick size |
| `ls` | Lot size |
| `lp` | LTP |
| `pc` | % change |
| `v` | Volume |
| `o`, `h`, `l`, `c` | Open, High, Low, Close |
| `ap` | Average trade price |
| `oi` | Open interest |
| `poi` | Previous-day closing OI |
| `toi` | Total OI for the underlying |
| `bq1`, `bp1`, `sq1`, `sp1` | Best bid qty/price, best ask qty/price (level 1) |
| `ft` | Feed time |

Feed `t:"tf"` fields (L4836-4859): `t, e, tk, lp, pc, v, o, h, l, c, ap, oi, poi, toi, bq1, bp1, sq1, sp1, ft`. **"Except for t, e, and tk, other fields may / may not be present"** (L4837). Feeds therefore carry only changed fields (inferred), so the client must merge each feed into the snapshot from the `tk` ack.

Unsubscribe: `{ t:"u", k }` gives ack `{ t:"uk", k }`.

### 7.4 SubscribeDepth: request `{ t:"d", k:"..." }`
Ack `t:"dk"` and feed `t:"df"` fields (L4882-5002): `e, tk, lp, pc, v, o, h, l, c, ap, ltt, ltq, tbq, tsq, bq1..bq5, bp1..bp5, bo1..bo5, sq1..sq5, sp1..sp5, so1..so5, lc, uc, 52h, 52l` (52-week high/low; lifetime on MCX), `oi, poi, toi, ft`. The doc does not repeat the "may not be present" note for depth, but the sample `df` (L5005-5038) omits `lp`, `pc`, `oi` and others, so partial updates apply here too (inferred).

Unsubscribe: `{ t:"ud", k }` gives ack `{ t:"udk", k }`.

### 7.5 HeartBeat
Request `{ t:"h" }`. Response `{ t:"hk", ft: <timestamp seconds> }` (L5199-5207). **The interval is not stated.** **Gap.**

### 7.6 Other pushes received after connect
`t:"ms"` market status (`e, mkt_s, mkt_t, desc`), `t:"am"` alert (`dmsg`), `t:"rm"` admin message, and order/position updates.

---

## 8. CHANGELOG entries relevant to quotes and touchline (L105-181)

| Date | Change |
|---|---|
| 7 Feb 2023 | `uc`, `lc` added to GetSecurityInfo |
| 22 Feb 2022 [sic, probably 2023] | `und_exch`, `und_tk`, `ltd` added to GetQuotes |
| 27 Feb 2023 | Close price added to GetQuotes |
| 21 Apr 2023 | `ord_msg` added to GetQuotes and GetSecurityInfo |
| 08 May 2023 | `description, norentm, noren_nsecs, exch_tm` added to ExchStatus. "Added new fields in /GetQuotes, /MarketWatch, /Holdings and /ExchStatus" (the GetQuotes fields are not named) |

There is no changelog entry for touchline fields, and no entry for GetOptionChain, GetLinkedScrips or GetOptionGreek.

---

## 9. Answers to the explicit questions

1. **Does any endpoint return implied volatility?** No. `volatility` is an **input** to GetOptionGreek (L4444-4446). No response anywhere has an IV field (a search for `iv`, `implied`, or `volatil` finds only L4444). The client must compute IV itself, e.g. by solving the inverse of GetOptionGreek or a local Black-Scholes using LTP.
2. **Does touchline give `poi` and `c`?** Yes. Both the `tk` ack and `tf` feed list `c` (Close price) and `poi` (Previous day closing OI) (L4826, L4829, L4850, L4853). That `c` means the *previous* close is inferred from GetQuotes' "Close Price", which was added as prior close in the 27 Feb 2023 changelog; verify that it does not mean today's close after market hours.
3. **Index spot and token?** Call `GetIndexList {uid, exch:"NSE"}` to get `{idxname, token}` pairs, e.g. Nifty 50 = `26000` and Nifty Bank = `26009` (L3842-3869). Then subscribe to touchline with `k:"NSE|26000"` or call GetQuotes with `exch:"NSE", token:"26000"`. From an option contract, `und_exch` and `und_tk` come from GetQuotes (L1381-1382) or GetUnderlyingExchToken (L4103-4111). **BSE SENSEX is not documented.** `GetIndexList {exch:"BSE"}` would presumably return it (inferred), and SENSEX options would be on `BFO` (only mentioned at L1619).
4. **Listing expiries and choosing a tsym for each?** Call `GetLinkedScrips` and use its `opt_exp[]`. Each entry gives `exd` (the expiry, for the dropdown) and `tsym` ("one of the random trading symbols on given expiry, useful in calling option chain") (L3998-4007). Pass that `tsym` with `exch`, `strprc` = ATM (spot) and `cnt` to GetOptionChain.
5. **Does touchline include bp1/sp1/bq1/sq1?** Yes. `bq1, bp1, sq1, sp1` are in both `tk` and `tf` (L4831-4834, L4855-4858). Levels 2-5 come only from depth.

---

## 10. Gaps the tech team must clarify with Kambala

1. The GetOptionGreek URI is `/NorenWClient/` and not `/NorenWClientTP/`. Is this a typo? Is `uid` needed?
2. GetOptionGreek input formats for `exd`, `int_rate` (percent or decimal) and `volatility` (percent or decimal). Is `optt` needed? Units of theta (per day?) and vega (per 1%?).
3. Does any endpoint provide IV? Can `sptprc` in GetQuotes be enabled for our account?
4. The maximum `cnt` for GetOptionChain, and the ordering of results.
5. GetLinkedScrips: is `token` a token or a tsym? What should be passed for an index underlying? A sample response is needed.
6. Does GetQuotes return `oi`/`poi`/`exd` for F&O contracts? The 08 May 2023 "new fields" are unnamed.
7. Touchline `c`: is it the previous close in all sessions? Is `toi` populated for options?
8. The touchline `k` example uses `NSE|NIFTY`. Are symbol keys supported?
9. WS heartbeat interval and timeout, reconnect and resubscribe expectations, and a per-connection subscription limit.
10. BSE support: the SENSEX/BANKEX index tokens and the `BFO` option chain.
11. Market hours or a holiday calendar endpoint. None is documented beyond ExchStatus and WS `ms`.
12. Production REST and WS base URLs for TradeSmart. The doc only shows `apitest.kambala.co.in` and a placeholder `api.broker1.com`.
13. Rate limits for GetQuotes, GetOptionChain and TPSeries. None are documented.
