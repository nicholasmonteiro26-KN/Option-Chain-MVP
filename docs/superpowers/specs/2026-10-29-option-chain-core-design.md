# Option Chain Core: Design Spec

| | |
|---|---|
| **Sub-project** | #1 of 5 (Option Chain Core) of the TradeSmart Options Desk |
| **Date** | 2026-10-29 |
| **Status** | Draft, awaiting review |
| **Audience** | TradeSmart tech team (Ionic Angular), product owner |
| **Platform** | Desktop web only (`web.tradesmartonline.in`) |
| **Reference product** | GoCharting Options Desk, "Expiry" tab (`gocharting.com/optionsdesk`) |

Research this spec builds on (read alongside):

- `docs/research/kambala-api-reference.md`: endpoint contracts, with line references into the vendor doc.
- `docs/research/option-analytics-formulas.md`: every formula, edge case and golden test vector (§ numbers below are from this file).
- `docs/research/angular-architecture.md`: grid choice, signals store, socket, worker, folder layout, code sketches.

---

## 1. Goal and success criteria

**Goal.** Bring TradeSmart's option chain to feature parity with the GoCharting "Expiry" tab, using only the Kambala (Noren) REST and WebSocket APIs. Hand the tech team a spec, a clickable prototype and Angular reference code they can integrate.

**What exists today** (TradeSmart, observed 2026-10-29): OI/Greeks toggle, expiry dropdown, call/put LTP with % change, OI and volume in lakhs, a checkbox per contract, *Add to Watchlist* / *Add to Basket*, and PCR and Max Pain in the footer. The OI-change column does not load.

**Success criteria**

1. All 8 views (Default, Price, Greeks, Open Interest, Candle, Statistics, Straddle, Custom) render live for NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX and stock options.
2. IV, Max Pain and PCR match GoCharting and NSE on the same expiry and timestamp: IV within ±0.5 vol points, Max Pain strike exact, PCR within ±0.01.
3. "All strikes" (≤ 200 contracts) at 20 ticks/sec keeps the UI ≥ 50 fps, and an analytics pass takes < 50 ms in the worker.
4. No regression of the existing basket, watchlist and order flows.

**Out of scope for this sub-project:** Strategy builder and payoff (#2), Analysis charts (#3), OI and MultiStrike time series (#4), Flow (#5, no data source), Chart tab (already exists), and mobile layout.

---

## 2. Decisions log

| # | Decision | Choice |
|---|---|---|
| D1 | Decomposition | 5 sub-projects. This spec covers #1 only. |
| D2 | Platform | Desktop web only |
| D3 | Where analytics run | Browser, in a Web Worker, about once a second. The library is pure TypeScript and portable to Node. |
| D4 | Data approach | **A: subscribe to the full chain** of the selected expiry. The strike count only filters visible rows. |
| D5 | Trading from the chain | Keep the checkboxes and basket/watchlist. Add hover **B / S** that opens the existing order window pre-filled. The chain never places orders. |
| D6 | Preferences storage | localStorage, versioned, behind a `PrefsStore` interface |
| D7 | Grid | Custom `<table>` with sticky CSS (not AG Grid). CDK virtual scroll only if profiling demands it. |
| D8 | State / change detection | Angular signals, one signal per strike row, zoneless, OnPush |
| D9 | Pricing model | Black-76 on a put-call-parity forward per expiry (formulas §1) |
| D10 | Price used for IV | Mid price when the spread is sane, else LTP if the contract traded today, else no IV (§2.5) |
| D11 | Time convention | Calendar time ACT/365 to the second, expiry at 15:30 IST. DTE label is the calendar-date difference (§3). |
| D12 | Risk-free rate | Config, default 5.75% (§4) |
| D13 | ITM probability | N(d2) (§9) |
| D14 | ATM strike | Nearest to the forward (§12). ATM IV is the mean of CE and PE IV at ATM. |
| D15 | Aggregates (Max Pain, PCR, Cum OI, GEX) | Always from **all subscribed strikes**, independent of the visible strike count |
| D16 | Tests | Vitest (unit and component) and Playwright (e2e on the mock feed) |
| D17 | Where the chain opens | **Standalone page in a new browser tab**: `/option-chain?underlying=<EXCH>:<SYMBOL>[&expiry=<YYYY-MM-DD>]`, opened with `window.open(url, '_blank', 'noopener')` from the chart page's *Option Chain* button, the watchlist and the scrip context menu. The URL is bookmarkable and each tab is independent. |
| D18 | Changing underlying | Quick-switch buttons for **NIFTY and SENSEX only**, the most traded (each shows live LTP and % change). Every other index and stock is reached through a type-ahead search over underlyings with options (`SearchScrip`, filtered to F&O underlyings). Switching updates the URL with `history.replaceState`. |
| D19 | Underlying OHLC | The header shows LTP, change, change %, Open, High, Low, Previous close of the selected underlying, from its touchline (`o`, `h`, `l`, `c`, `lp`, `pc`), and the **lot size of the selected expiry** |
| D20 | Custom view editor | The column editor appears **only when the user clicks Custom**. *Done* collapses it to an *Edit columns* button, also shown only in Custom. Other views never show any of it. |
| D21 | Lot size source | Lot size is **never hard-coded**. It is read per contract from `ls` in the `GetOptionChain` response, because it can differ between expiries of the same underlying: SENSEX is 20 for Nov and Dec 2026 expiries and 25 from Jan 2027 (BSE notice 20260930-58). The header, the order-window hand-off, GEX and Max Pain all use the selected contract's `ls`. |

---

## 3. Architecture

```
Kambala REST ──► InstrumentsService ─────────┐  expiries, tokens, lot size, strike step
                                             ▼
Kambala WS ──► NorenSocket ──► TickBuffer ──► OptionChainStore (signals; quotes by token)
               (shared, auth,   (merge partial    │                ▲
                heartbeat,       ticks, flush     │ snapshot 1/s   │ AnalyticsResult
                reconnect)       on rAF ≈ 4/s)    ▼                │
                                          AnalyticsBridge ──► analytics.worker.ts
                                                                  └─ libs/option-analytics (pure TS)
                                             ▼
                                   ChainViewModel (computed): visible rows, preset columns,
                                   Σ row, header stats, spot-row position
                                             ▼
          UI: header-stats · expiry-strip · preset-tabs · chain-table · footer-actions
```

### 3.1 Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `kambala-client` | Typed REST calls (`GetIndexList`, `GetLinkedScrips`, `GetOptionChain`, `SearchScrip`) and WS message types. If TradeSmart already has a Kambala service, this is a thin adapter over it. | Existing session (`uid`, `susertoken`) |
| `NorenSocket` (app core) | One shared socket per session: connect (`t:'c'`), heartbeat, reconnect with backoff and jitter, ref-counted subscriptions. | Session |
| `ChainFeedFacade` | Diffs the wanted token set against the current one and sends `t`/`u` messages. Request IDs discard stale expiry loads. | `NorenSocket`, `InstrumentsService` |
| `TickBuffer` | Merges partial `tf` updates by token and flushes once per animation frame | none |
| `OptionChainStore` | Holds meta, quotes and analytics. Exposes signals per row and global. No UI knowledge. | none |
| `libs/option-analytics` | Pure functions: forward, IV, Greeks, Max Pain, PCR, OI Sense, ITM probability, straddle, GEX, DTE. No Angular, no DOM. | none |
| `AnalyticsBridge` + `analytics.worker.ts` | Snapshots the store once a second, posts to the worker and skips a run if one is in flight. Restarts the worker once on crash. | library |
| `columns/column-registry.ts` | **Single source of truth** for each column: id, label, accessor, formatter, width, `sum`, flash, side. Used by presets, the Custom chooser, the Σ row and CSV. | none |
| `PrefsStore` | Load and save preferences (versioned JSON in localStorage) | none |
| `ui/*` | Presentational components (inputs and outputs only). Never inject stores. | registry |
| `feature-shell` | Page and route. Wires everything together, owns effects, calls the existing order window and basket services. | all |

Folder layout: `angular-architecture.md` §7.

### 3.2 Data flow per expiry

1. **Underlying resolve.** Taken from the page URL's `underlying` parameter (set by whichever button opened the tab). Defaults to NIFTY if missing or invalid. Quick-switch and search change it in place (D17, D18). Index tokens come from `GetIndexList` (e.g. NIFTY = `NSE|26000`); stocks come from `SearchScrip`. SENSEX/BANKEX on BSE/BFO is undocumented in the vendor doc, so **reuse TradeSmart's current SENSEX chain mapping**.
2. **Expiries.** Call `GetLinkedScrips(exch, token)`. `opt_exp[]` gives `exd` plus a sample `tsym` per expiry. Build the expiry strip from it, sorted ascending, and drop expired entries.
3. **Contracts.** Call `GetOptionChain(tsym, exch, strprc = spot rounded to the strike step, cnt = CHAIN_CNT)`. It returns `tsym, token, optt, strprc, ls, ti, pp`. Group by `strprc` into CE/PE pairs. `CHAIN_CNT` is config (default 100 per side), pending Kambala's max.
4. **Subscribe.** Touchline for all contract tokens, the underlying spot and (if listed) the same-expiry future.
5. **Stream.** `tk` acks seed the full quote; `tf` updates are partial. Merge them in `TickBuffer` and flush to the store.
6. **Analyse.** Once a second the bridge sends `{spot, fut?, quotes[], strikes[], expiryTs, r, oiUnit, lotSize}` to the worker, which returns per-contract `{iv, delta, gamma, theta, vega, itmProb, ivSource}`, per-strike `{straddle*, avgIV, pcrOI, pcrVol, pain, gexOI, gexVol, cumOI}` and global `{forward, fwdSource, atmStrike, atmIV, maxPain, pcrOI, pcrVol, totals}`.
7. **Render.** `ChainViewModel` picks the visible window. The strike count is centred on the **spot slot** (the hysteresis-stable strike the spot line sits under), not on the forward ATM, so the spot line is always mid-window; ATM appears only in the header and footer. maps the active preset's columns through the registry, and positions the spot separator row between the strikes bracketing spot.
8. **Switch expiry or underlying.** Unsubscribe the old set, then load and subscribe the new one. Responses with an old request ID are dropped.

### 3.3 Subscription limit fallback

If the subscribe ack or a Kambala-confirmed limit indicates the full chain can't be subscribed, subscribe ±N strikes around ATM (N = largest that fits), show a **"Partial chain"** badge on header stats, and suffix aggregates with "(subscribed strikes)".

---

## 4. Calculations

All formulas, units and edge cases are in `option-analytics-formulas.md`. Summary of what each displayed value uses:

| Displayed | Definition | Ref |
|---|---|---|
| Forward F | Median put-call-parity forward over ±3 strikes around ATM using mid prices. Fallback: same-expiry future, then S·e^{rT}. Source shown in the header tooltip. | §1.3 |
| IV | Safeguarded Newton with bisection fallback, σ ∈ [0.001, 5], warm start. Price input per D10. Null with a reason code if the price is below intrinsic, non-converged or there is no price. | §2 |
| Delta, Gamma | Spot-equivalent | §5 |
| Theta | ₹ per calendar day | §5 |
| Vega | ₹ per 1 vol point | §5 |
| ITM Prob | N(d2) / N(−d2) using the strike's IV | §9 |
| OI Chg, OI Chg % | `oi − poi`, `/ poi × 100`. Shows "New" when poi = 0. | §8 |
| OI Sense | Sign of ΔP (vs prev close `c`) × sign of ΔOI: Long Build Up / Short Build Up / Short Covering / Long Unwinding / "—" | §8 |
| Straddle Price / Bid / Ask | CE + PE LTP / bid / ask | §10 |
| Str Decay | Straddle LTP − (CE prev close + PE prev close) | §10 |
| Avg IV | Mean of valid CE and PE IV | §12 |
| PCR (OI), PCR (Vol) | Overall: ΣPE / ΣCE. Per strike: PE / CE. | §7 |
| Cum OI | CE OI + PE OI per strike; Σ in header | §14 |
| Max Pain | Strike minimising total writer payout; per-strike pain value in the Straddle view | §6 |
| GEX-OI, GEX-Vol | (Γ_CE·units_CE − Γ_PE·units_PE)·S²·0.01, in ₹ crore, calls +, puts −. A tooltip states the convention. | §11 |
| ATM IV | Mean of CE and PE IV at the ATM strike | §12 |
| DTE label | Calendar-date difference (`0d` on expiry day) | §3.2 |

**Config** (one `OptionChainConfig` object): `riskFreeRate = 0.0575`, `oiUnit = 'lots' | 'qty'` (pending Kambala), `maxSpreadForMid = max(5 ticks, 10%)`, `minTimeToExpirySec = 60` (EXPIRED floor), `lowConfidenceBelowSec = 3600`, `chainCnt = 100`, `spotSlotHysteresis = 0.1`, `forwardStrikesEachSide = 3`, `oiUnit` normalised to quantity at ingestion, `recalcIntervalMs = 1000`, `staleAfterMs = 30000`.

---

## 5. Screen design

### 5.1 Layout (top to bottom)

The chain is its own page in its own browser tab (D17). There are no Chart / Option Chain tabs inside it.

1. **Quick-switch and search bar:** Buttons for NIFTY and SENSEX, each with live LTP and % change; the active one is highlighted. On the right, a search box ("Search index or stock") with a keyboard-navigable suggestion list showing symbol, name, Index/Stock and F&O exchange. A "no match" message when nothing has options (D18).
2. **Underlying bar:** Symbol, exchange tag, LTP, Δ, Δ%, then **O · H · L · Prev close · Lot (this expiry)** (D19, D21).

**Reference lot sizes as of 29 Oct 2026**, for QA only. Production reads `ls` per contract.

| Underlying | Lot | Note |
|---|---|---|
| NIFTY | 65 | Since the Jan 2026 series (NSE circular FAOP70616) |
| SENSEX | 20 → 25 | 20 for Nov and Dec 2026 expiries, 25 from Jan 2027 expiries |
| BANKNIFTY / FINNIFTY / MIDCPNIFTY / BANKEX | 30 / 60 / 120 / 30 | |
| RELIANCE / TCS / HDFCBANK / ICICIBANK / INFY / SBIN / AXISBANK | 500 / 225 / 650 / 700 / 400 / 750 / 625 | Oct–Dec 2026 contracts |
3. **Toolbar:** Preset chips `Default · Price · Greeks · Open Interest · Candle · Statistics · Straddle · Custom`. Then *Edit columns* (shown only in Custom, D20), ⚙ strike count `4 / 6 / 8 / 16 / 32 / 40 / 64 / All` (default 16), and ⬇ CSV.
4. **Expiry strip and header stats:** Expiry chips labelled with DTE (`5d 11d 19d …`), with the date in a tooltip; the selected chip is filled. Then **ATM IV · Cum OI · Max Pain · PCR · PCR(Vol)**, plus a live/stale/reconnecting dot.
5. **Chain table:**
   - Sticky header. Calls on the left, **Strike in the centre**, puts on the right.
   - ITM cells shaded: calls below spot, puts above.
   - **Spot line** (reference: Dhan's option chain): a thin dashed green line between the two strikes that bracket spot, with a green price label (spot LTP) centred on the strike column. It is **part of the chain and scrolls with its strikes**, so it always marks the right place and never covers a row. When spot is scrolled out of view, CSS `position: sticky` holds it just under the column headers (or just above the footer) so the price stays visible. The chain opens with the spot line in the middle of the table box.
     - **Steady placement (hysteresis).** The line keeps its gap until spot moves more than **10 % of the strike step** beyond either neighbouring strike (e.g. 5 points for NIFTY's 50-point step). Spot wobbling around a strike therefore never makes the line flip back and forth. The label's price still updates every tick.
     - **No ATM outline box** on the strike cell, because it jumped between strikes as the forward moved. ATM is shown in the header stats and footer only.
   - OI bars: **call (CE) OI bars red, put (PE) OI bars green**, growing out from the strike column. Cum OI bars in the strike-centric views are TradeSmart blue.
   - LTP cells flash green or red on a change (CSS class toggled outside change detection).
   - **Hover** over a CE or PE half shows `B` and `S` buttons. A click emits `{token, tsym, side, ltp, lotSize}` to the shell, which opens the existing order window.
   - The existing **checkbox** per contract stays.
6. **Footer:** A Σ row (sum of every column with `sum: true`), then *Add to Watchlist (n)* and *Add to Basket (n)*, acting on the checked contracts as today.

### 5.2 Column presets

Call side listed outer → inner; the put side mirrors it (inner → outer).

| Preset | Per side |
|---|---|
| Default | Volume · OI (bar) · Bid · Ask · LTP (+ chg % sub-line) |
| Price | Chg % · Chg · Bid · Ask · LTP |
| Greeks | IV · Theta · Vega · Gamma · Delta |
| Open Interest | OI Sense · OI Chg % · OI Chg · OI (bar) · ITM Prob |
| Candle | Volume · Low · High · Open · LTP |

Strike-centric presets (one row per strike, not mirrored):

| Preset | Columns |
|---|---|
| Statistics | Strike · Straddle · Cum OI (bar) · Avg IV · PCR(OI) · PCR(Vol) · GEX-OI · GEX-Vol |
| Straddle | Strike · Straddle Price · Straddle Bid · Straddle Ask · Str Decay · Cum OI (bar) · Avg IV · PCR(OI) · PCR(Vol) · Pain |

**Custom.** The chooser lists every registry column (about 30), with drag-to-reorder (CDK drag-drop) and a side mode (mirrored or strike-centric). Up to **5 named custom presets**, listed in the editor with *New*, *Rename* and *Delete*. The editor is visible **only while Custom is selected** (D20).

### 5.3 Formatting

- Prices to the contract's `pp` decimals.
- OI and volume in **lakhs** with 2 decimals (TradeSmart's existing convention), with exact values in a tooltip. Configurable to K/M/B.
- IV and percentages to 2 decimals. Greeks: delta 4, gamma 4, theta 2, vega 2.
- Positive values green, negative red. OI Sense uses GoCharting colours (§8): green, red, orange, cyan.
- **Theme.** Use TradeSmart's existing CSS variables, read from web.tradesmartonline.in on 29 Oct 2026, so light and dark follow the app's `body[color-theme]` switch. Do not add new colours.

| Role | Light (`:root`) | Dark (`body[color-theme="dark"]`) |
|---|---|---|
| Page / table background | `--bg-color` #fff | #0A1222 |
| Secondary rows, header | `--bg-color-light` #F8F8F8 | #20293F / `--grey-bg-box` #151F35 |
| Strike column | `--strikebg` #dddddd | #151F35 |
| Text / muted text | `--text-color` #000 / `--grey-txt-color` #949494 | #fff / #949494 |
| Borders | `--border-color` rgba(148,148,148,.3) | rgba(148,148,148,.2) |
| ITM cells | `--oi-selected-bg` #FFF9EE | #20293F (#46320E is too strong for whole-row shading) |
| Spot line and price label | #39B00E dashed line; label #39B00E with white text | same |
| Brand blue (Buy, active chip, selected expiry) | #3F71EB (`.buybg-btn`) | #3F71EB |
| Positive change green | #39B00E (`.green-txt-clr`) | #39B00E |
| Negative / Sell red | #E83937 (`.red-text-clr`, `.sell-btn`) | #E83937 |
| CE OI bar / PE OI bar | #E83937 / #39B00E at ~22% opacity | same at ~33% opacity |
| Font | Roboto | Roboto |

- Hover **B** is TradeSmart blue and **S** is red, matching the app's Buy/Sell buttons.

### 5.4 Preferences (localStorage key `ts.optionChain.prefs.v1`)

`{ version: 1, preset: string, strikeCount: number, custom?: {mode, columns: string[]}, customPresets: [{id, name, mode, columns: string[]}], numberFormat: 'lakh' | 'intl' }`. `custom` is the working Custom view; applying a saved preset copies it there. Demo mode (`?feed=mock`) works only in development builds. Every read and write is wrapped in try/catch. An unknown or corrupt version resets to defaults. Keyed per user ID.

---

## 6. Error handling and edge cases

| Situation | Behaviour |
|---|---|
| Session expired (REST `emsg` "Session Expired", or WS connect `s: Not_Ok`) | Stop the feed and emit `sessionExpired` to the shell, which invokes the existing re-login flow. No retry loop. |
| WS drop | Reconnect with backoff 1 → 2 → 4 … 30 s plus jitter. Resubscribe the full current set. Show the "Reconnecting…" banner. Last values stay visible and dimmed. |
| REST failure | 2 retries, then the error state with Retry. An already-loaded expiry list stays usable. |
| Rapid expiry or underlying switch | Request-ID guard. Unsubscribe before subscribing. |
| Subscription limit hit | §3.3 fallback and badge |
| Missing quote / LTP 0 | "–". Excluded from IV and Greeks. OI still counts in aggregates. |
| IV not solvable | "–" with a reason tooltip: below intrinsic / no two-sided quote / not traded today / did not converge |
| No parity forward | Fallback chain (§4); source shown in the tooltip |
| Expiry day after 15:30 / expired | Remove from the strip and select the next expiry |
| < 1 h to expiry | IV and Greeks still computed, but marked low-confidence (italic plus tooltip) below `lowConfidenceBelowSec`. Under `minTimeToExpirySec` (60 s) or after 15:30, the contract is EXPIRED (null IV and Greeks). |
| Market closed / pre-open | "Market closed · as of HH:MM". No flash. One analytics pass. |
| Contract with no tick for `staleAfterMs` during market hours | Its cells are dimmed |
| Worker crash | Restart once. On a second failure, analytics columns show "–" and a banner says "Analytics unavailable". |
| Worker slow | Skip the tick (no queue) |
| Irregular strike steps | No uniform-spacing assumption anywhere |
| OI unit ambiguity | `oiUnit` config flag |
| localStorage unavailable | Defaults. Saving silently does nothing. |
| CSV | Exactly the visible rows × active columns, using the same formatters. A header line with underlying, expiry and timestamp. Filename `optionchain_<UNDERLYING>_<EXPIRY>_<HHMM>.csv`. |

---

## 7. Testing

| Layer | Tool | What |
|---|---|---|
| `libs/option-analytics` | Vitest | Golden vectors V1–V15 (formulas §15): Black-76 price, IV round-trip, Greeks, parity forward, Max Pain, PCR, OI Sense, ITM prob, GEX, DTE, solver edge cases. **≥ 95 % line coverage.** |
| Data access | Vitest | Tick merge (partial updates), subscription diff, reconnect + resubscribe, stale-response discard, prefs migration, against `MockNorenSocket` |
| UI | Vitest + Angular TestBed | Preset switch, strike window centring, spot row placement, "–" states, Σ row, CSV output, Custom chooser save and load |
| E2E | Playwright | Mock-feed mode (`?feed=mock`, replays a recorded NIFTY session): load, switch expiry, Custom preset survives reload, reconnect banner, hover B/S emits the correct payload |
| Performance | Playwright + Chrome trace | "All" with 200 contracts at 20 ticks/s: ≥ 50 fps, worker pass < 50 ms |
| Accuracy (manual, pre-release) | Side-by-side | GoCharting and NSE on the same expiry and time: tolerances per §1 |

---

## 8. Deliverables (this sub-project)

1. **This spec.**
2. **Clickable prototype.** A single self-contained HTML file with mock data and a simulated tick feed, demonstrating every preset, the expiry strip, strike count, Custom editor, hover B/S, Σ row, all states (toggled by a demo menu) and CSV export. Published as a private shareable link.
3. **Angular reference code** in `option-chain/`, laid out as in `angular-architecture.md` §7, plus `libs/option-analytics/`. Standalone components, signals, zoneless-ready, with the Vitest suites above and a mock-feed transport. Reference quality: the team wires in the real session/auth, the order window and the basket service at marked integration points (`// INTEGRATION:` comments).
4. **Research docs** (done): `docs/research/*.md`.

---

## 9. Open questions

**For Kambala**

1. Maximum `cnt` for `GetOptionChain`, and the per-session touchline subscription limit.
2. Whether OI in touchline / `GetQuotes` is in **lots or quantity**.
3. BSE SENSEX/BANKEX: index tokens and the BFO option-chain call (undocumented).
4. Production REST and WS URLs, rate limits, heartbeat interval.
5. Whether `GetQuotes` returns `oi`/`poi` for F&O (not documented).
6. Whether `GetLinkedScrips` takes a token or a tsym for an index underlying.
7. How many WebSocket connections one login session may hold at once, since each chain tab opens its own (D17). If only one is allowed, tabs must share one connection via a `SharedWorker` or `BroadcastChannel` leader tab.
8. Whether `SearchScrip` can be filtered to underlyings that have options, or whether we need a cached F&O underlying list.

**For the TradeSmart tech team**

1. Angular and Ionic versions in production; Zone.js or zoneless.
2. Existing state library (NgRx?), existing Kambala socket service to reuse, existing test runner.
3. Order-window and basket service APIs that the chain's B/S and checkboxes should call.
4. How the current SENSEX chain resolves BFO contracts.
5. Whether a new tab picks up the login session automatically (same-origin storage or cookie), or needs a session hand-off.

**Product decisions (defaults chosen; change if needed)**

1. Mid vs LTP for IV (default mid, D10).
2. Risk-free rate default and who maintains it (5.75 %).
3. ATM based on forward (default) vs spot.
4. "Str Decay" definition: vs previous close (default) vs θ_CE + θ_PE. Verify against a live GoCharting screen.
5. GEX sign-convention disclaimer wording.

---

## 10. Later sub-projects (for context only)

| # | Sub-project | Depends on |
|---|---|---|
| 2 | Strategy Builder / Risk: payoff, predefined strategies, `GetBasketMargin`, basket placement | #1 store and analytics |
| 3 | Analysis charts: volatility smile, OI / OI change / premium / Max Pain by strike, expiry compare | #1 analytics |
| 4 | OI / MultiStrike time series via `TPSeries` (+ backend cache decision) | #1 instruments |
| 5 | Flow | Needs a trade-level data source. Parked. |
