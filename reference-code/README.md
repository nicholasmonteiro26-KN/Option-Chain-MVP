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

**Demo (simulated market):** open `http://localhost:4200/option-chain?underlying=NSE:NIFTY&feed=mock`. No login needed.

**Demo mode (`feed=mock`) works only in dev builds (`ng serve`) and in the `perf` build configuration.** In a normal production build (`ng build`), `?feed=mock` is ignored, so a shareable URL can never put simulated prices on a trading page. Without `feed=mock` the page uses the real Kambala client and needs a login session.

**Live (local), real TradeSmart market data (TradeSmart v2 OAuth):**

1. In the TradeSmart web app, open **Tools → API** and note your **App Key** and **Secret Key**.
2. On that API dashboard, register the Redirect URL **exactly** `http://localhost:4200/auth/callback` (same scheme, host, port and path; no trailing slash).
3. TradeSmart's v2 API accepts calls only from the **static IP** registered on the dashboard: this machine's public IP must match it.
4. Copy `.env.local.example` to `.env.local` and fill in `KAMBALA_REST_URL` (full REST path, e.g. `https://<host>/NorenWClientAPIv2`), `KAMBALA_WS_URL` (e.g. `wss://<host>/NorenWSAPI/`), `TRADESMART_APP_KEY` and `TRADESMART_SECRET_KEY`. `TRADESMART_AUTHORIZE_URL` is optional (default `https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth`). `.env.local` is git-ignored; never commit it.
5. `npx ng serve`
6. Open `http://localhost:4200/login`, enter your **Client ID** (your TradeSmart login ID) and press **Log in with TradeSmart**. You then sign in on TradeSmart's own page (the password and OTP are entered there, never in this app). TradeSmart sends you back to `/auth/callback`, which finishes the login and opens the option chain.

How it works: the dev server's proxy (`proxy.conf.mjs`, which loads `dev-proxy/proxy-config.mjs`; wired in `angular.json` for the `development` and `perf` serve configurations) is the only thing that reads `.env.local`.

| Browser calls | Proxy does |
|---|---|
| `GET /auth/start` (full-page navigation from `/login`) | 302 to `https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth?client_id=<App Key>`. TradeSmart redirects back to `/auth/callback?code=…`. |
| `POST /auth/exchange` with `{ code }` (from `/auth/callback`) | Computes `checksum = sha256_hex(App Key + Secret Key + code)`, POSTs `jData={"code","checksum"}` (`Content-Type: text/plain`, no jKey) to `${KAMBALA_REST_URL}/GenAcsTok`, and returns only `{ stat, access_token, uid?, actid?, emsg? }` (never `client_id` as the uid: it is the App Key). It needs `Content-Type: application/json` (else 415), gives up after 15 s (504), and turns GenAcsTok's "no data" into "The login code was not accepted (it may have expired or already been used). Please try again." The logic is in `dev-proxy/oauth.mjs`. |
| `POST /kambala-api/<Endpoint>` with `Authorization: Bearer <access_token>` | `${KAMBALA_REST_URL}/<Endpoint>` (`changeOrigin`). A plain pass-through: the `Authorization` header is forwarded unchanged. |
| WebSocket `ws://localhost:4200/kambala-ws` | `KAMBALA_WS_URL` (`changeOrigin`; the `Origin` header is rewritten to the server's own) |

- **Secret Key:** read only by the Node proxy, for the checksum. It never reaches the browser or the bundle, and neither the checksum nor the secret is ever sent back. The App Key (the OAuth `client_id`) is served by the proxy in the `/auth/start` redirect, not bundled.
- **The callback (`/auth/callback`):** it reads `code` and the pending login (`{ clientId, returnUrl }`, saved by `/login` in `sessionStorage`), and removes the code from the address bar at once (`history.replaceState`). It then exchanges the code, stores the session `{ uid, actid, accessToken }`, and calls `UserDetails` once to confirm the token (and to read `actid` if GenAcsTok gave none). Finally it opens the saved returnUrl. On failure it shows Kambala's message and a **Try again** link. When the message is about the IP or the Redirect URL, it adds "Check that your static IP and the Redirect URL are registered on the TradeSmart API dashboard." A direct visit with no login in progress says so plainly. The callback also rejects a pending login older than 10 minutes, and a TradeSmart sign-in whose user ID (uid, not the account ID) differs from the Client ID typed on `/login` ("You signed in to TradeSmart as X, but entered Client ID Y. Please try again.").
- **Browser history:** the OAuth `code` may still appear in the browser history entry for the redirect from TradeSmart (the callback replaces it in the address bar, but the browser may keep the earlier entry). The code is single-use and short-lived, and it is useless without the Secret Key, which only the proxy holds.
- **REST and WebSocket with the token:** REST calls send `Authorization: Bearer <access_token>` and `jData` with `uid` (no `jKey`). The WebSocket connect message is `{"t":"a","uid","actid","source":"API","accesstoken"}`, acknowledged with `t:"ak"`. HTTP 401, or a message containing "Session Expired" or "Invalid Token" / "invalid access token", counts as an expired session.
- **Missing `.env.local` or key:** the dev server prints the name of the missing key (never a value). `/auth/start`, `/auth/exchange` and the live routes then answer HTTP 500 naming the key, and `?feed=mock` still works.
- **Do not expose the proxy:** with `.env.local` present, never run `ng serve --host 0.0.0.0` (or any non-localhost host). That would put a token-exchange proxy holding your TradeSmart App and Secret Keys on your network. Keep the default `localhost`, which is also the only Redirect URL TradeSmart sends you back to.
- **Prefs per user:** with live data, saved views and settings are stored under the signed-in user ID (`demo` in mock mode).
- **Session:** it is kept in `sessionStorage`, scoped to the browser tab. Closing the tab ends it, and a new tab needs a new login. Without a session, `/option-chain` (live) redirects to `/login?returnUrl=…`, and after login you return there; only same-app paths are accepted. When the session expires, the page logs out and goes back to the login page. **Log out** (top right, live only) clears the session and closes the socket.
- **Index tokens:** after login, the page reads NIFTY and SENSEX index tokens from `GetIndexList` (NSE "Nifty 50", BSE "SENSEX"). If SENSEX is not in the account's BSE list, its quick button is disabled ("SENSEX not available for this account"). If the call fails, NIFTY keeps its documented token (26000), SENSEX is disabled the same way (never the placeholder token), and the console shows a warning. The quick buttons' prices are subscribed only after this lookup.
- **v2 API notes:** this server is TradeSmart's v2 API (`NorenWClientAPIv2`). These points were checked with fake data only, because no real login was tried:
  - it accepts `jData` as **raw JSON** and rejects a URL-encoded one, so the client and the proxy share one encoder (`kambala-form.mjs`). It sends raw JSON with `&`, `%` and `+` written as JSON unicode escapes (backslash-u 0026, 0025, 002b), so there are no form-special characters inside the JSON, and the JSON is valid whether or not the server URL-decodes it;
  - it answers errors with HTTP 4xx and a `Not_Ok` body, which the client maps to Kambala's message;
  - GenAcsTok, the REST pass-through and the WebSocket all reach the server.
- **Legacy session shape:** the REST client and the socket still support a Noren `susertoken` session (`jKey` on REST, `t:"c"` / `ck` on the WebSocket). It is chosen when the session config has no `accessToken`. TradeSmart's own web session may use it (INTEGRATION rows 6 and 10).

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
| `npm run test:proxy` | Unit tests for the dev-server proxy (`node --test dev-proxy/*.spec.mjs`, fake values only). |
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
    app.config.ts, app.routes.ts   Zoneless, router, HttpClient, standalone login wiring. '' redirects to
                                   /option-chain (lazy); /login and /auth/callback (lazy).
    core/theme.service.ts  Light / dark theme (see Themes).
    login/                 Standalone TradeSmart v2 OAuth login: /login (Client ID, then TradeSmart's own
                           page), /auth/callback (code exchange, UserDetails check), safe returnUrl.
    features/option-chain/
      index.ts             Public API: OPTION_CHAIN_ROUTES, openOptionChain, optionChainUrl.
      analytics/           AnalyticsBridge (main thread <-> Web Worker) and the worker that runs analyze().
      columns/             Column registry (every column's label, value, format) and the eight presets.
      data-access/         Store, facade, market session (exchange hours), instruments service,
                           prefs store and shared models. AuthSessionService (tab-scoped login session),
                           QuickUnderlyingsService (NIFTY / SENSEX tokens from GetIndexList).
        feed/              Transport, Noren WebSocket service, tick buffer (250 ms flush), mock transport.
        kambala/           REST client (UserDetails, GetIndexList, GetLinkedScrips, GetOptionChain, SearchScrip)
                           and API types.
        testing/           Mock market, mock REST client and chain fixtures. Dev and perf builds only.
      export/              CSV export of the visible rows.
      feature-shell/       The page component (the only place that injects the store; it also
                           provides the feature's services, so they die with the page), routes,
                           providers (real vs mock wiring), auth guard, openOptionChain() launcher.
      ui/                  Presentational components, inputs and outputs only:
        chain-table/         The table, spot line, OI bars, price-flash directive.
        column-chooser/      Custom view editor.
        expiry-strip/        Expiry buttons.
        footer-actions/      Add to Watchlist / Basket, checked count, footer stats.
        theme-toggle/        Sun / moon icon button (hidden when the host controls the theme).
        status-banner/       Reconnecting, market closed, error, analytics unavailable.
        underlying-bar/      Search box, NIFTY/SENSEX quick buttons, spot, OHLC, lot size.
        view-toolbar/        View chips, strike count, Edit columns, CSV.
      view/                Pure view-model builder and the spot-slot (hysteresis) function.
e2e/                       Playwright specs: option-chain.spec.ts (16), screenshots.spec.ts (4, SCREENSHOTS=1 only), perf.spec.ts (1, PERF=1 only).
dev-proxy/                 Dev-server proxy: .env.local reader (env.mjs), TradeSmart v2 OAuth (oauth.mjs: authorize
                           URL, checksum, GenAcsTok), the route table (proxy-config.mjs) and their node:test spec.
proxy.conf.mjs             Loads .env.local and the route table: /auth/start, /auth/exchange, /kambala-api, /kambala-ws.
.env.local.example         The .env.local keys, empty, with where to find them. Copy to .env.local (git-ignored).
```

Data flow in one line: Kambala REST and WebSocket, then the tick buffer, then the store (signals), then the analytics worker, then the view model, then the table.

## Integration points

Every `// INTEGRATION:` comment in `src`, generated from `grep -rn "INTEGRATION:" src`. Line numbers are as of this hand-off and will move when the code changes; re-run the grep.

| # | File:line | What to plug in |
|---|---|---|
| 1 | `src/app/app.config.ts:10` | Host the `option-chain` route inside TradeSmart's existing Ionic shell. Ionic is not wired in this app. |
| 2 | `src/app/app.config.ts:17` | Standalone login wiring (`provideStandaloneKambalaSession()`: REST via the dev proxy at `/kambala-api`, session from `AuthSessionService`). Inside TradeSmart's app, provide `KAMBALA_REST_BASE` and `NOREN_SESSION_CONFIG` from its own config and auth service instead. |
| 3 | `src/app/app.routes.ts:10` | The standalone `/login` and `/auth/callback` routes (TradeSmart v2 OAuth via the dev proxy). TradeSmart's existing login replaces them. |
| 4 | `src/app/core/theme.service.ts:34` | Theme: inside TradeSmart's app the host sets `body[color-theme]` (`light` or `dark`). `ThemeService` adopts it (also when it is set after startup), follows later changes, never writes it, and the toggle button hides itself. **TradeSmart's host index.html must not include the boot script from this app's index.html; the host sets body[color-theme] itself.** See Themes. |
| 5 | `src/app/features/option-chain/data-access/chain-feed.facade.ts:331` | Session expiry: when `store.sessionExpired()` is true the shell runs re-login. **After re-login, refresh the session config (the `NOREN_SESSION_CONFIG` getter) and call `ChainFeedFacade.reconnect()`**; it reconnects the socket and reloads the current underlying and expiry. |
| 6 | `src/app/features/option-chain/data-access/feed/noren-socket.service.ts:53` | Provide the Noren session config (WS URL, uid, actid, optional `source`, and **`accessToken`** or **`susertoken`**) as a getter; it is read on every connect, so a token refreshed by re-login is used on reconnect. **Its shape picks the connect message:** `accessToken` → v2 `{t:'a', uid, actid, source:'API', accesstoken}`, ack `ak`; `susertoken` only → legacy `{t:'c', …, susertoken}`, ack `ck` (TradeSmart's web session may still use this). |
| 7 | `src/app/features/option-chain/data-access/feed/noren-socket.service.ts:65` | Map Kambala's subscription-limit error to the "Partial chain" state once the real error shape is known. |
| 8 | `src/app/features/option-chain/data-access/kambala/kambala-rest.client.ts:15` | `KAMBALA_REST_BASE`: the REST base as a **full path** (e.g. `https://host/NorenWClientAPIv2`). Calls go to `${base}/${endpoint}`; there is no `NorenWClientTP` prefix any more. |
| 9 | `src/app/features/option-chain/data-access/kambala/kambala-rest.client.ts:35` | Provide the uid and token from the app's auth service (read from the session getter on every call): `accessToken` → `Authorization: Bearer` header and no `jKey` (v2); `susertoken` only → `jKey` (legacy). `uid` always goes in `jData`. |
| 10 | `src/app/features/option-chain/data-access/kambala/kambala.types.ts:117` | `NOREN_SESSION_CONFIG` token: a getter `() => NorenSessionConfig` from TradeSmart's auth/session service, with `accessToken` (v2 OAuth) or only `susertoken` (legacy Noren web session); see `NorenSessionConfig`. **After re-login, refresh it and call `reconnect()`.** |
| 11 | `src/app/features/option-chain/data-access/market-session.service.ts:26` | Exchange holiday calendar and special sessions (Muhurat, Saturday sessions) for `MARKET_SESSION_RULE`. The default knows only 09:15–15:30 IST, Monday to Friday, so a holiday shows as open until this is plugged in. |
| 12 | `src/app/features/option-chain/data-access/models.ts:52` | Confirm the BFO option-chain lookup for SENSEX (TradeSmart's existing SENSEX chain). With live data the SENSEX index token comes from `GetIndexList('BSE')`; `'1'` is only the fallback placeholder. |
| 13 | `src/app/features/option-chain/feature-shell/open-option-chain.ts:10` | Call `openOptionChain()` from the existing entry points: chart "Option Chain" button, watchlist, scrip menu. |
| 14 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:56` | Filter search results to F&O underlyings once Kambala says how (open question 8). |
| 15 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:257` | `AuthService.relogin()`. The standalone app logs out and goes to `/login?returnUrl=…` (a new page, so a fresh session and connection). TradeSmart's shell can swap in its own login. **After re-login, refresh the session config and call `facade.reconnect()`** (the error banner's Retry does the same). No retry loop. |
| 16 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:447` | `OrderWindowService.open(...)` for hover Buy/Sell. The `TradeEvent` payload is `{ token, exch, rawToken, tsym, side, ltp, lotSize }`: `exch` + `rawToken` (e.g. `NFO`, `43651`) are Kambala's order keys, `token` is the feed key `NFO\|43651`, `lotSize` is the contract's `ls`. |
| 17 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:463` | `WatchlistService.add(items)`: one `{ token, exch, rawToken, tsym }` per ticked contract (`token` is the feed key `EXCH\|token`). |
| 18 | `src/app/features/option-chain/feature-shell/option-chain-page.component.ts:472` | `BasketService.add(items)`: one `{ token, exch, rawToken, tsym }` per ticked contract. |
| 19 | `src/app/features/option-chain/feature-shell/option-chain.guard.ts:9` | `optionChainAuthGuard` (live data needs a session, else `/login?returnUrl=…`). Use TradeSmart's own auth guard instead. |
| 20 | `src/app/features/option-chain/feature-shell/option-chain.providers.ts:52` | Provide the signed-in user's id (`OPTION_CHAIN_USER_ID`, default `'demo'`); prefs are stored per user. |
| 21 | `src/app/features/option-chain/feature-shell/option-chain.providers.ts:122` | `KAMBALA_REST_BASE` for the page: `/kambala-api` (dev proxy) with live data, unused in mock mode. Replace with TradeSmart's REST base (full path). |
| 22 | `src/app/features/option-chain/feature-shell/option-chain.providers.ts:125` | `NOREN_SESSION_CONFIG` for the page: reads `AuthSessionService` with live data (WS URL `ws(s)://<host>/kambala-ws`, the v2 `accessToken`, `source: 'API'`), a fake session in mock mode. Replace with the live session getter from TradeSmart's auth service. **After re-login, refresh it and call `reconnect()`.** |

## Themes

The app has a light and a dark theme, using TradeSmart's own palettes (`src/styles/_tradesmart-tokens.scss`: light is `:root`, dark is `body[color-theme='dark']`). Components use only the `--ts-*` tokens, so a new surface needs no theme code.

- **Toggle:** the sun / moon button in the page header (top right on the login pages). The choice is stored in `localStorage` under `ts.theme`.
- **Follows the system:** until the user picks a theme, the app follows `prefers-color-scheme`, live. After a pick it stays put. A small inline script in `index.html` applies the theme before Angular starts, so dark mode does not flash light (a CSP needs a `script-src` hash for it, or move it to a file).
- **Host-controlled (INTEGRATION row 4):** inside TradeSmart's app the host already switches `body[color-theme]`. If that attribute is set before `ThemeService` starts, or later to a value the service did not write, the service adopts it, keeps following changes (MutationObserver), never writes it, stops following the system and storage, and the toggle is hidden. TradeSmart's host index.html must not include this app's boot script; the host sets body[color-theme] itself. Screenshots: `../docs/design/screenshots/option-chain-light.png` and `option-chain-dark.png` (`SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts`).

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

- Figures below are as of 29 Oct 2026, updated on 30 Oct 2026 for live data and the TradeSmart v2 OAuth login (unit, e2e and proxy tests, bundle size); coverage and performance are from 29 Oct.
- **Unit and component:** 41 files, **533 tests**: 532 passing and 1 skipped (the `analyzeChain` wall-clock timing test, which runs only with `PERF=1`) (`npx ng test --watch=false`).
- **Dev proxy:** 35 `node:test` tests (`npm run test:proxy`), all passing, fake values only.
- **End-to-end:** **21 Playwright tests**: 16 functional (dev server), all passing (one checks the redirect to the Client ID login page without a session, one a direct visit to `/auth/callback`); 1 perf (optimised `perf` build), skipped unless `PERF=1`, passing when run.
- **Coverage (as of this hand-off, 29 Oct 2026):** the analytics library (`src/libs/option-analytics`) has 99.1 % statements, 99.0 % branches, 100 % functions (target: at least 95 %). Whole project: 94.7 % statements, 97.0 % lines. The lowest files are the feature-shell providers (real-feed wiring, which needs live credentials) and the view model's fallback branches.
- **Type checks:** `npx tsc -p tsconfig.app.json --noEmit`, `tsconfig.spec.json` and `e2e/tsconfig.json` all exit 0. `npx ng build` and `npx ng build --configuration perf` both succeed with no warnings (initial bundle about 268 kB raw, 73.2 kB transferred; the login page and the OAuth callback are separate lazy chunks of about 5 kB each).
- **Performance** (`perf` build, headless Chromium, 200 contracts at 20 ticks/s, all strikes shown, 10 s of frame samples, on a 12th-gen Core i5-12450HX). Budget: at most 5 % of frames over 20 ms, and every analytics worker round trip under 50 ms.

  | Measure | Result |
  |---|---|
  | Frames over 20 ms | 2.54 % and 3.42 % in the two latest runs (earlier runs 0.67 % to 2.04 %; budget 5 %) |
  | p50 / p95 frame time | 16.7 ms / 16.8 ms |
  | Worker round trip | 3 to 31 ms over 10 to 11 passes (budget under 50 ms); the first pass after showing all strikes is the slowest. |

  The same load on the unoptimised dev build was 36 to 44 % long frames before the optimisations, so measure on the `perf` build, not `ng serve`.

- **Headroom note:** the margin is thin. Each tick flush (about 4 a second) makes Chromium lay out and paint the whole 100-row table, taking 15 to 30 ms. **Row virtualisation (CDK virtual scroll) is recommended** for larger chains and slower machines, so only the visible rows are laid out and painted.

## Known limitations and deferred

- **Subscription-limit error mapping is unknown.** Kambala's error for hitting the per-session subscription limit is not documented, so the "Partial chain" state is not triggered from the real feed yet (INTEGRATION 7).
- **SENSEX / BANKEX token and BFO lookup.** The BSE index tokens and the BFO option-chain call are undocumented; the real-feed path for BSE needs confirming (INTEGRATION 12). The mock market covers SENSEX with its odd lot size for the 91-day expiry.
- **OI in lots or quantity.** Kambala has not confirmed the unit. `oiUnit` defaults to `'qty'`; flip it in config once known (it is normalised to quantity at ingestion).
- **Number format K/M/B ('intl') not implemented; lakhs only.** The `numberFormat` preference is kept in the saved prefs for forward compatibility.
- **Market holidays.** The market session knows weekdays and 09:15–15:30 IST only; exchange holidays and special sessions show as open until a calendar is plugged in (INTEGRATION 11).
- **No retry backoff.** A failed load shows an error banner with Retry; there is no automatic backoff. Session expiry goes to the re-login hook with no retry loop; after re-login the shell (or the Retry button) calls `reconnect()`.
- **The price flash is a held tint, not a fade.** A fading `background-color` repaints every flashing cell every frame, which broke the frame budget (36 to 44 % long frames). The tint is held for at least 400 ms and cleared on the next tick flush (about 500 ms in practice), and is skipped under `prefers-reduced-motion`. The standalone prototype uses a simpler version: its tint clears 400 ms after each render, while the Angular app holds it at least 400 ms and clears it on the next flush.
- **The strike window is centred on the spot slot, not the ATM.** This keeps the spot line mid-table. On a far expiry the ATM row can fall outside a small window; ATM is shown in the header and footer.
- **Search does not filter to F&O underlyings yet** (INTEGRATION 14, open question 8), so non-F&O stocks can appear in the results.
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
