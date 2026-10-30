# TradeSmart Option Chain: reference implementation

## What this is

The reference implementation of the new option chain for web.tradesmartonline.in. It is **sub-project 1 of 5**: the chain itself, with eight column views, expiry strip, live IV and Greeks, OI build-up, straddles, GEX, custom columns and hover Buy/Sell.

It is **not production-ready**. It is meant to be read, adapted and moved into TradeSmart's Ionic Angular app. Everything that needs TradeSmart's own services (login session, order window, watchlist, basket) is marked `// INTEGRATION:` and listed below.

Stack: Angular 22.2 (zoneless, standalone, signals), `@angular/cdk` 22.2, `@ionic/angular` 9.0 (installed but not wired, see the INTEGRATION table), TypeScript 6, Vitest 5 for unit tests, Playwright 1.64 for e2e.

Related documents (relative to this folder):

- Spec: [`../docs/superpowers/specs/2026-10-29-option-chain-core-design.md`](../docs/superpowers/specs/2026-10-29-option-chain-core-design.md)
- Plan: [`../docs/superpowers/plans/2026-10-29-option-chain-core.md`](../docs/superpowers/plans/2026-10-29-option-chain-core.md) (also as [`HTML`](../docs/design/option-chain-core-plan.html))
- Research: [`../docs/research/kambala-api-reference.md`](../docs/research/kambala-api-reference.md), [`../docs/research/option-analytics-formulas.md`](../docs/research/option-analytics-formulas.md), [`../docs/research/angular-architecture.md`](../docs/research/angular-architecture.md)
- Design page (approved mockup): [`../docs/design/option-chain-core-design.html`](../docs/design/option-chain-core-design.html)
- Standalone clickable prototype (sample data, no build needed): [`../prototype/option-chain-prototype.html`](../prototype/option-chain-prototype.html). Serve it with `npx -y http-server prototype -p 8766` from the repository root.

## Run it

```bash
npm ci
npx ng serve
```

Open `http://localhost:4200/option-chain?underlying=NSE:NIFTY&feed=mock`.

**Demo mode (`feed=mock`) works only in dev builds (`ng serve`) and in the `perf` build configuration.** In a normal production build (`ng build`), `?feed=mock` is ignored, so a shareable URL can never put simulated prices on a trading page. Without `feed=mock` the page tries the real Kambala client, which needs the INTEGRATION values below.

URL parameters:

| Parameter | Meaning | Example |
|---|---|---|
| `underlying` | `EXCH:SYMBOL`. Anything else falls back to NIFTY. | `NSE:NIFTY`, `BSE:SENSEX` |
| `expiry` | Expiry date as `YYYY-MM-DD`. The page writes it back to the URL when you change expiry. | `2026-11-10` |
| `feed=mock` | Use the simulated market (dev build or `perf` configuration only). | `feed=mock` |
| `mockStrikes` | Strikes per chain in the mock market (default 35). | `mockStrikes=100` |
| `mockHz` | Mock ticks per second (default 20). | `mockHz=20` |

Commands:

| Command | What it does |
|---|---|
| `npx ng test --watch=false` | Unit and component tests (Vitest, jsdom). Add `--coverage` for coverage. |
| `npx playwright test` | End-to-end tests. The `chromium` project (functional) runs against `ng serve` on port 4300, which Playwright starts itself. The perf test is skipped unless `PERF=1`. Run `npx playwright install chromium` once first. |
| `PERF=1 npx playwright test --project perf` | The wall-clock perf budget test, against an optimised `ng serve --configuration perf` on port 4301 (that server is started only when `PERF=1`). Opt-in because the result depends on the machine. |
| `PERF=1 npx ng test --watch=false` | Also runs the `analyzeChain` wall-clock timing test (skipped otherwise). |
| `npx ng build` | Production build. Mock feed disabled. |
| `npx ng build --configuration perf` | Production-optimised build with `allowMockFeed: true`. Used only by the perf test. Do not deploy it. |

## Folder map

```
src/
  environments/            environment.ts (allowMockFeed: false), environment.perf.ts (true)
  libs/option-analytics/   Pure TypeScript, no Angular. Black-76 pricing, implied volatility,
    testing/                 forward, aggregates (PCR, Max Pain, GEX, straddle), analyze() and
                             OptionChainConfig. Runs in the worker. Test fixtures.
  app/
    app.config.ts, app.routes.ts   Zoneless, router, HttpClient. '' redirects to /option-chain (lazy).
    features/option-chain/
      index.ts             Public API: OPTION_CHAIN_ROUTES, openOptionChain, optionChainUrl.
      analytics/           AnalyticsBridge (main thread <-> Web Worker) and the worker that runs analyze().
      columns/             Column registry (every column's label, value, format) and the eight presets.
      data-access/         Store, facade, market session (exchange hours), instruments service,
                           prefs store and shared models.
        feed/              Transport, Noren WebSocket service, tick buffer (250 ms flush), mock transport.
        kambala/           REST client (GetLinkedScrips, GetOptionChain, SearchScrip) and API types.
        testing/           Mock market, mock REST client and chain fixtures. Dev and perf builds only.
      export/              CSV export of the visible rows.
      feature-shell/       The page component (the only place that injects the store; it also
                           provides the feature's services, so they die with the page), routes,
                           providers (real vs mock wiring), openOptionChain() launcher.
      ui/                  Presentational components, inputs and outputs only:
        chain-table/         The table, spot line, OI bars, price-flash directive.
        column-chooser/      Custom view editor.
        expiry-strip/        Expiry buttons.
        footer-actions/      Add to Watchlist / Basket, checked count, footer stats.
        status-banner/       Reconnecting, market closed, error, analytics unavailable.
        underlying-bar/      Search box, NIFTY/SENSEX quick buttons, spot, OHLC, lot size.
        view-toolbar/        View chips, strike count, Edit columns, CSV.
      view/                Pure view-model builder and the spot-slot (hysteresis) function.
e2e/                       Playwright specs: option-chain.spec.ts (11), perf.spec.ts (1, PERF=1 only).
```

Data flow in one line: Kambala REST and WebSocket, then the tick buffer, then the store (signals), then the analytics worker, then the view model, then the table.

## Integration points

Every `// INTEGRATION:` comment in `src`, generated from `grep -rn "INTEGRATION:" src`. Line numbers are as of this hand-off and will move when the code changes; re-run the grep.

| # | File:line | What to plug in |
|---|---|---|
| 1 | `src/app/app.config.ts:9` | Host the `option-chain` route inside TradeSmart's existing Ionic shell. Ionic is not wired in this app. |
| 2 | `src/app/features/option-chain/data-access/chain-feed.facade.ts:318` | Session expiry: when `store.sessionExpired()` is true the shell runs re-login. **After re-login, refresh the session config (the `NOREN_SESSION_CONFIG` getter) and call `ChainFeedFacade.reconnect()`**; it reconnects the socket and reloads the current underlying and expiry. |
| 3 | `src/app/features/option-chain/data-access/feed/noren-socket.service.ts:42` | Provide the Noren session config (WS URL, uid, actid, susertoken) as a getter; it is read on every connect, so a token refreshed by re-login is used on reconnect. |
| 4 | `src/app/features/option-chain/data-access/feed/noren-socket.service.ts:51` | Map Kambala's subscription-limit error to the "Partial chain" state once the real error shape is known. |
| 5 | `src/app/features/option-chain/data-access/kambala/kambala-rest.client.ts:9` | Provide the REST base URL (for example `https://host`) from TradeSmart's config or auth service. |
| 6 | `src/app/features/option-chain/data-access/kambala/kambala-rest.client.ts:24` | Provide the uid and session token (`jKey`) from the app's auth service (read from the session getter on every call). |
| 7 | `src/app/features/option-chain/data-access/kambala/kambala.types.ts:105` | `NOREN_SESSION_CONFIG` token: a getter `() => NorenSessionConfig` from TradeSmart's auth/session service. **After re-login, refresh it and call `reconnect()`.** |
| 8 | `src/app/features/option-chain/data-access/market-session.service.ts:26` | Exchange holiday calendar and special sessions (Muhurat, Saturday sessions) for `MARKET_SESSION_RULE`. The default knows only 09:15–15:30 IST, Monday to Friday, so a holiday shows as open until this is plugged in. |
| 9 | `src/app/features/option-chain/data-access/models.ts:46` | Confirm the BSE SENSEX index token and the BFO option-chain lookup (TradeSmart's existing SENSEX chain). |
| 10 | `src/app/features/option-chain/feature-shell/open-option-chain.ts:10` | Call `openOptionChain()` from the existing entry points: chart "Option Chain" button, watchlist, scrip menu. |
| 11 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:54` | Filter search results to F&O underlyings once Kambala says how (open question 8). |
| 12 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:244` | `AuthService.relogin()`: hand off to TradeSmart's existing login. No retry loop here. **After re-login, refresh the session config and call `facade.reconnect()`** (the error banner's Retry does the same). |
| 13 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:410` | `OrderWindowService.open(...)` for hover Buy/Sell. The `TradeEvent` payload is `{ token, exch, rawToken, tsym, side, ltp, lotSize }`: `exch` + `rawToken` (e.g. `NFO`, `43651`) are Kambala's order keys, `token` is the feed key `NFO|43651`, `lotSize` is the contract's `ls`. |
| 14 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:426` | `WatchlistService.add(items)`: one `{ token, exch, rawToken, tsym }` per ticked contract (`token` is the feed key `EXCH|token`). |
| 15 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:435` | `BasketService.add(items)`: one `{ token, exch, rawToken, tsym }` per ticked contract. |
| 16 | `src/app/features/option-chain/feature-shell/option-chain.providers.ts:50` | Provide the signed-in user's id (`OPTION_CHAIN_USER_ID`, default `'demo'`); prefs are stored per user. |
| 17 | `src/app/features/option-chain/feature-shell/option-chain.providers.ts:103` | Replace the placeholder `KAMBALA_REST_BASE` with TradeSmart's Kambala REST base URL. |
| 18 | `src/app/features/option-chain/feature-shell/option-chain.providers.ts:105` | Replace the placeholder `NOREN_SESSION_CONFIG` getter with the live session (uid, actid, susertoken, WS URL). **After re-login, refresh it and call `reconnect()`.** |

## Configuration

`OptionChainConfig` (`src/libs/option-analytics/config.ts`), exported as `DEFAULT_CONFIG`:

| Key | Default | Meaning |
|---|---|---|
| `riskFreeRate` | `0.0575` | Rate used in Black-76 (5.75 %). Product decision: who maintains it. |
| `oiUnit` | `'qty'` | Whether Kambala's OI and volume are in quantity (`'qty'`) or lots (`'lots'`). Applied once, at ingestion: with `'lots'` the store multiplies `oi`, `prevOi` and `volume` by each contract's lot size, so the table, header, CSV and analytics all see quantity (`analyzeChain` ignores the flag). Open question; flip it once confirmed (via the `OPTION_CHAIN_CONFIG` token or `DEFAULT_CONFIG`). |
| `chainCnt` | `100` | `cnt` sent to `GetOptionChain`. Kambala's maximum is unknown. |
| `recalcIntervalMs` | `1000` | Minimum time between analytics passes in the worker. |
| `staleAfterMs` | `30000` | During market hours, a contract with no tick for this long is shown dimmed as stale. |
| `minTimeToExpirySec` | `60` | EXPIRED floor: under this many seconds to expiry, IV and Greeks are null. Such expiries also leave the strip, on load and on the 30 s session tick (a selected one hands over to the next expiry). |
| `lowConfidenceBelowSec` | `3600` | Under this many seconds to expiry every solved IV is marked low-confidence (italic, with a tooltip); IV and Greeks are still computed. |
| `forwardStrikesEachSide` | `3` | Strikes each side of the money used to estimate the forward. |
| `spotSlotHysteresis` | `0.1` | The spot line keeps its gap until spot moves this fraction of a strike step past a neighbouring strike. |

Market session: `MarketSessionService` (`data-access/market-session.service.ts`) decides open or closed from the injected clock: NSE/BSE F&O hours 09:15–15:30 IST, Monday to Friday, with a fixed +05:30 (never the machine time zone), re-evaluated every 30 s. It drives the "Market closed" banner, the one-analysis-while-closed rule and stale dimming (none while closed). The reconnecting banner still follows the feed. In mock mode the session is always open (the simulated market trades around the clock). Holidays are an INTEGRATION item.

Number formats: prices use each contract's price precision (`pp`, default 2) on screen and in the CSV. OI, Volume, OI Chg and Cum OI show lakhs, with the exact value (en-IN grouped) as a tooltip. GEX headers and cells explain the sign convention in a tooltip. Signed values that round to zero show as `0.00`. The CSV starts with a UTF-8 byte-order mark for Excel.

Build-time flag: `environment.allowMockFeed` (`src/environments/environment.ts` is `false`; `environment.perf.ts`, swapped in by the `perf` configuration, is `true`). The gate is `(isDevMode() || environment.allowMockFeed) && ?feed=mock`. The production build must keep it `false`.

## Tests and quality

- Figures below are as of this hand-off (29 Oct 2026).
- **Unit and component:** 34 files, **433 tests**: 432 passing and 1 skipped (the `analyzeChain` wall-clock timing test, which runs only with `PERF=1`) (`npx ng test --watch=false`).
- **End-to-end:** **12 Playwright tests**: 11 functional (dev server), all passing; 1 perf (optimised `perf` build), skipped unless `PERF=1`, passing when run.
- **Coverage (as of this hand-off, 29 Oct 2026):** the analytics library (`src/libs/option-analytics`) has 99.1 % statements, 99.0 % branches, 100 % functions (target: at least 95 %). Whole project: 94.7 % statements, 97.0 % lines. The lowest files are the feature-shell providers (real-feed wiring, which needs live credentials) and the view model's fallback branches.
- **Type checks:** `npx tsc -p tsconfig.app.json --noEmit`, `tsconfig.spec.json` and `e2e/tsconfig.json` all exit 0. `npx ng build` and `npx ng build --configuration perf` both succeed with no warnings (initial bundle about 254.5 kB raw).
- **Performance** (`perf` build, headless Chromium, 200 contracts at 20 ticks/s, all strikes shown, 10 s of frame samples, on a 12th-gen Core i5-12450HX). Budget: at most 5 % of frames over 20 ms, and every analytics worker round trip under 50 ms.

  | Measure | Result |
  |---|---|
  | Frames over 20 ms | 2.54 % and 3.42 % in the two latest runs (earlier runs 0.67 % to 2.04 %; budget 5 %) |
  | p50 / p95 frame time | 16.7 ms / 16.8 ms |
  | Worker round trip | 3 to 31 ms over 10 to 11 passes (budget under 50 ms); the first pass after showing all strikes is the slowest. |

  The same load on the unoptimised dev build was 36 to 44 % long frames before the optimisations, so measure on the `perf` build, not `ng serve`.

- **Headroom note:** the margin is thin. Each tick flush (about 4 a second) makes Chromium lay out and paint the whole 100-row table, taking 15 to 30 ms. **Row virtualisation (CDK virtual scroll) is recommended** for larger chains and slower machines, so only the visible rows are laid out and painted.

## Known limitations and deferred

- **Subscription-limit error mapping is unknown.** Kambala's error for hitting the per-session subscription limit is not documented, so the "Partial chain" state is not triggered from the real feed yet (INTEGRATION 4).
- **SENSEX / BANKEX token and BFO lookup.** The BSE index tokens and the BFO option-chain call are undocumented; the real-feed path for BSE needs confirming (INTEGRATION 9). The mock market covers SENSEX with its odd lot size for the 91-day expiry.
- **OI in lots or quantity.** Kambala has not confirmed the unit. `oiUnit` defaults to `'qty'`; flip it in config once known (it is normalised to quantity at ingestion).
- **Number format K/M/B ('intl') not implemented; lakhs only.** The `numberFormat` preference is kept in the saved prefs for forward compatibility.
- **Market holidays.** The market session knows weekdays and 09:15–15:30 IST only; exchange holidays and special sessions show as open until a calendar is plugged in (INTEGRATION 8).
- **No retry backoff.** A failed load shows an error banner with Retry; there is no automatic backoff. Session expiry goes to the re-login hook with no retry loop; after re-login the shell (or the Retry button) calls `reconnect()`.
- **The price flash is a held tint, not a fade.** A fading `background-color` repaints every flashing cell every frame, which broke the frame budget (36 to 44 % long frames). The tint is held for at least 400 ms and cleared on the next tick flush (about 500 ms in practice), and is skipped under `prefers-reduced-motion`. The standalone prototype uses a simpler version: its tint clears 400 ms after each render, while the Angular app holds it at least 400 ms and clears it on the next flush.
- **The strike window is centred on the spot slot, not the ATM.** This keeps the spot line mid-table. On a far expiry the ATM row can fall outside a small window; ATM is shown in the header and footer.
- **Search does not filter to F&O underlyings yet** (INTEGRATION 11, open question 8), so non-F&O stocks can appear in the results.
- **Other small items:** sticky offsets are not re-measured on font or zoom changes; in a hidden tab ticks and analytics fall back to 250 ms timers (no animation frames there), but a flush already waiting for a frame when the tab is hidden waits until it is visible again; the Ionic shell is not wired in; each chain tab opens its own WebSocket (see open question 7).

## Open questions

Copied from spec section 9.

**For Kambala**

1. Maximum `cnt` for `GetOptionChain`, and the per-session touchline subscription limit.
2. Whether OI in the touchline feed is in **lots or quantity**.
3. BSE SENSEX/BANKEX: index tokens and the BFO option-chain call (undocumented).
4. Production REST and WS URLs, rate limits, heartbeat interval.
5. Whether Kambala's quote snapshot endpoint returns `oi`/`poi` for F&O (not documented; this client does not call it).
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
4. "Str Decay" definition: vs previous close (default) vs theta_CE + theta_PE. Verify against a live GoCharting screen.
5. GEX sign-convention disclaimer wording.

## Commits

This code has **not been committed**, by request. It sits in the working tree. The TradeSmart team should review it and commit it themselves, for example as `feat: option chain reference implementation` and `docs: standalone prototype and tech-team README`.
