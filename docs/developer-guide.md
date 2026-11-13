# Option chain: developer guide

For anyone (person or AI) changing the option chain. Start with `../CLAUDE.md` (rules and decisions), then
`../reference-code/README.md` (run, folder map, integration points). Paths below are relative to
`reference-code/src/app/features/option-chain/` unless they start with `src/`.

## 1. How data flows

```
Kambala REST (GetLinkedScrips, GetOptionChain, SearchScrip, GetIndexList)
        │                                   Kambala WebSocket (touchline ticks, order updates "om")
        ▼                                            ▼
data-access/chain-feed.facade.ts  ── loads chains, subscribes keys ──► data-access/feed/ (transport, 250 ms tick buffer)
        │                                            │
        ▼                                            ▼
data-access/option-chain.store.ts  (signals: meta, quotes per contract, spot, legPrices, feedCache)
        │
        ├─► analytics/analytics.bridge.ts ──► Web Worker running src/libs/option-analytics analyze()
        │                                       (forward, IV, Greeks, PCR, Max Pain, GEX)
        ▼
view/chain-view-model.ts  (rows, columns of the chosen tab, spot slot)
        ▼
ui/chain-table/  (the table)            feature-shell/option-chain-page.component.ts wires all of it
```

- **Forward, not spot or futures:** IV and Greeks use a forward price from put-call parity on the 7 strikes nearest
  the money (`src/libs/option-analytics/forward.ts`), with fallbacks. Delta and gamma are expressed per point of spot.
- **Market session:** `data-access/market-session.service.ts` decides open/closed per options exchange. It drives the
  feed dot (green only when open), Execute all, stale dimming and the after-hours single analysis.

## 2. Build your strategy (orders)

```
tick boxes ─► strategy/strategy.store.ts (legs per underlying, sessionStorage per user)
                 │                      ▲
                 ▼                      │ setResults / setOrderState / retryFailed
ui/strategy-panel/ (edit ─► confirm ─► results)
                 │ execute
                 ▼
strategy/execute-strategy.ts  ── PlaceOrder per leg, buys first, stop at first rejection
                 │ placed order numbers
                 ▼
strategy/order-tracker.service.ts ── SingleOrdHist every 2 s (1 min), then 10 s; WS "om" applied at once
```

- Leg results: `placed` (with `order: OrderState` once known), `rejected` (at placement), `not-sent`.
- `OrderState.phase`: `open`, `partial`, `filled`, `rejected`, `cancelled` (`toOrderState` maps Kambala's statuses).
- **Cancel open orders** → `CancelOrder` for every open / partly filled order, then re-check.
- **Retry failed legs** → `StrategyStore.retryFailed()`: rejected, not-sent and cancelled-unfilled legs go back in
  (included, result cleared). Filled and partly filled legs are never re-sent.
- Default limit price: `entryPrice()` (ask for a buy, bid for a sell, else LTP, rounded to the tick).

## 3. Recipes

### Add a column
1. Add a `ColumnDef` in `columns/column-registry.ts` (`sideQ` for quote fields, `sideA` for analytics, `strikeCol`
   for per-strike values). Give it a format; add `unit`, `title`, `exact` if needed.
2. If its sign should colour it green/red, add its id to `SIGNED` in `ui/chain-table/chain-table.component.ts`.
3. It appears in **Custom** automatically (`customisable: true`). To put it in a tab, add it to `columns/presets.ts`
   (side columns are listed outer → inner; puts mirror them).
4. Update `view/chain-view-model.spec.ts` (preset lists) and `ui/chain-table/chain-table.component.spec.ts` (headers;
   the `CE_IN / K / PE_IN / LAST` constants hold the Default tab's cell positions).

### Change a tab's columns
Edit `columns/presets.ts` and the preset test in `view/chain-view-model.spec.ts`. Row height is one value (`$row-h`
in `ui/chain-table/chain-table.component.scss`), so every tab shows the same number of strikes.

### Change market hours or add an exchange
Edit `isFoSessionOpen` in `data-access/market-session.service.ts` and its spec. For holidays, provide
`MARKET_SESSION_RULE` from TradeSmart's calendar (INTEGRATION 11).

### Add a Kambala REST call
1. Add the method to `data-access/kambala/kambala-rest.client.ts` (use `this.call(endpoint, jData)`; it adds `uid`,
   auth and error mapping) and the response type to `kambala.types.ts`.
2. Add it to the `KambalaRestApi` type and implement it in `data-access/testing/mock-kambala-rest.client.ts`.
3. Mark the path `// INTEGRATION: confirm the path on TradeSmart's v2 base` and add a README row.

### Change the strategy pop-up
UI in `ui/strategy-panel/` (pure: inputs/outputs). State changes go through `StrategyStore` methods, wired in
the page. Specs: `ui/strategy-panel/strategy-panel.component.spec.ts` (find rows with `row('leg-1')`, rows show buys
first), `strategy/*.spec.ts`, and the page spec's "Build your strategy" block (demo mode end to end).

## 4. Testing

- `npx ng test --watch=false` must stay green (about 690 tests). Run one file with `--include=<path>`.
- Page tests (`feature-shell/option-chain-page.component.spec.ts`) run the whole page on the mock market with a fake
  clock: `ctx.advance(ms)` fires timers, `ctx.stable()` settles signals and promises.
- To see a change, run `npx ng serve` and open `/option-chain?underlying=NSE:NIFTY&feed=mock`.
- Visual checks: compare light and dark (`?theme=dark`).

## 5. Integration points

Everything TradeSmart must plug in is marked `// INTEGRATION:`. List them with `grep -rn "INTEGRATION:" src` and
keep the tables in `reference-code/README.md` in step when you add one.

## 6. Open items

- MCX (commodity) options: search shows only NSE/BSE underlyings today; MCX hours are already in the session rule.
- Volume Chg %: needs previous-day volume, which Kambala's feed does not send (only EODChartData per contract).
- Holidays and special sessions (INTEGRATION 11); BFO market orders (`mkt_protection`); freeze-quantity slicing.
