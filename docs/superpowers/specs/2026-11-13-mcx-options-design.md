# MCX options in the option chain: design

Status: draft for review (2026-11-13). Sub-project of the TradeSmart option chain (`reference-code/`).

## Goal

A client can search a commodity (Crude Oil, Natural Gas, Gold, Silver, Copper…) and open its MCX option chain with the
same columns, analytics and strategy pop-up as NIFTY, using only the Kambala API.

## Decisions (agreed with the user)

| # | Decision |
|---|---|
| M1 | Search finds **all** MCX commodities with options. No MCX quick buttons. |
| M2 | Each expiry's chain is priced off **the future that expiry settles on** (Dec options → Dec future). The header price, ATM line, IV and Greeks switch with the expiry. |
| M3 | Build your strategy on MCX: legs can be built, priced, margined and saved to basket; **Execute all is off** ("MCX orders are not available yet") until Kambala confirms how MCX quantity is sent. One config switch turns it on. |
| M4 | MCX market orders are off (they need `mkt_protection`), like BSE/BFO. |
| M5 | Market hours: MCX 09:00–23:30 IST, 23:55 during US daylight saving time (already in `isFoSessionOpen`). |

## 1. Search

- `onSearch` also calls `SearchScrip` with `exch: 'MCX'` (in parallel with today's call). Errors from the MCX call are
  ignored (an account without MCX still gets NSE/BSE results).
- MCX rows are commodity futures (and options). They are grouped by commodity symbol (the tsym without its date and
  strike, e.g. `CRUDEOIL19DEC26` → `CRUDEOIL`), one result per commodity, labelled `Commodity · MCX`.
- Order: NFO results, then BFO, then MCX (`FO_EXCH_RANK`).
- The `Underlying` model gains `kind: 'index' | 'stock' | 'commodity'` and `foExch: 'NFO' | 'BFO' | 'MCX'`. For a
  commodity, `exch` and `foExch` are both `MCX` and `token` is the nearest future's token (used to load the chain).
- URL: `?underlying=MCX:CRUDEOIL` opens it (resolved through search, like stocks).

## 2. Loading the chain

- `GetLinkedScrips('MCX', <future token>)` gives `opt_exp[]` (expiries) and `fut[]` (futures).
- Each option expiry is matched to its underlying future: by `GetUnderlyingExchToken` on that expiry's sample option
  (exact), falling back to the first future expiring on or after the option expiry. The match is cached per expiry.
- `GetOptionChain('MCX', <sample tsym>, <future price>, cnt)` gives the strikes, as for NFO.
- The future is subscribed on the WebSocket and drives `store.spot()` for that expiry; switching expiry switches the
  subscription.

## 3. What the client sees

- Header: commodity name, the future (`CRUDEOIL DEC FUT`), its price and change, its O/H/L, lot size.
- Expiry strip: 3 nearest expiries as buttons, the rest in "Next expiry" (as today).
- Columns and tabs: unchanged. Lot size, tick and price precision come from each contract. OI and Volume keep
  Kambala's units; the "(In Lacs)" scaling is checked against real MCX values (commodity OI is much smaller) and may
  switch to plain numbers for MCX.
- Feed dot: green only during MCX hours.
- Analytics: the forward is the expiry's future (options on futures), so parity is checked against it.

## 4. Build your strategy on MCX

- Ticking, editing, margin (`GetBasketMargin`) and Save to basket work.
- Execute all is off for any strategy with an MCX leg, with the note "MCX orders are not available yet". The margin
  shows "to be confirmed" next to it until the quantity rule is confirmed.
- Market is off on MCX legs (title: "Market orders are not available on MCX. Use a limit price.").

## 5. Demo mode

`MockMarket` adds CRUDEOIL, NATURALGAS, GOLD and SILVER with monthly futures and options (MCX-style expiries a few days
before each future), realistic lot sizes and ticks, so everything can be tried with `?feed=mock`.

## 6. Questions for Kambala / TradeSmart (INTEGRATION)

1. MCX order and margin quantity: lots or units? (Blocks M3.)
2. Does `SearchScrip` mark options vs futures (`instname`, e.g. `OPTFUT` / `FUTCOM`) so commodities without options
   can be left out?
3. `mkt_protection` percent for MCX market orders.
4. Is `GetUnderlyingExchToken` available on the v2 base for MCX options?

## Out of scope

Currency options (CDS), MCX quick buttons, MCX order placement (until question 1 is answered), MCX holiday calendar.

## Testing

- Unit: search grouping and ordering, expiry → future matching, session hours (done), strategy gating for MCX.
- Page (mock): search CRUDEOIL → chain loads, header shows the expiry's future, switching expiry switches the future,
  Execute all off with the note, Save to basket works.
- e2e: open `?underlying=MCX:CRUDEOIL&feed=mock`.
