<!-- Same content as CLAUDE.md, for AI tools that read AGENTS.md. Keep the two in step. -->

# TradeSmart Option Chain: guide for AI assistants and developers

This repository holds the new option chain for TradeSmart (web.tradesmartonline.in, an Indian broker). It uses only the
Kambala (Noren) API. It is a **reference implementation**: TradeSmart's Ionic Angular team moves it into their app. Read
this file before changing anything; read `docs/developer-guide.md` for recipes and the data flow.

## Where things are

| Path | What |
|---|---|
| `reference-code/` | The Angular 22 app (the code you change). Its `README.md` is the hand-off: run, folder map, every INTEGRATION point. |
| `reference-code/src/libs/option-analytics/` | Pure TypeScript maths (Black-76, IV, forward, Max Pain, GEX, PCR). No Angular. Runs in a Web Worker. |
| `reference-code/src/app/features/option-chain/` | The feature: `data-access/` (Kambala REST + WebSocket, store, market session), `columns/` (column registry, tab presets), `strategy/` (Build your strategy, order placing and tracking), `ui/` (presentational components), `feature-shell/` (the page that wires everything). |
| `docs/developer-guide.md` | How the code fits together and how to make common changes. |
| `docs/research/kambala-api-reference.md` | Kambala endpoints and fields as documented (and the gaps). |
| `docs/research/option-analytics-formulas.md` | The formulas behind IV, Greeks, GEX, Max Pain. |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | Approved designs and plans. Decisions logs live in the specs. |
| `prototype/` | Old clickable HTML prototype (sample data). Not maintained. |

## Commands (run in `reference-code/`)

| Command | Use |
|---|---|
| `npm ci` | Install. |
| `npx ng serve` | Dev server on http://localhost:4200. Demo with simulated prices: `/option-chain?underlying=NSE:NIFTY&feed=mock` (no login). |
| `npx ng test --watch=false` | All unit and component tests (Vitest). Must pass before you finish. `--include=<spec path>` runs one file. |
| `npx ng build` | Production build. A budget warning for `chain-table.component.scss` is known and accepted. |
| `npx playwright test` | End-to-end tests (starts its own server on port 4300). |

## Safety rules (never break these)

1. **Secrets.** `reference-code/.env.local` holds the TradeSmart App Key, Secret Key and API URLs. Never read, print,
   log, copy or commit its values; you may only check that a key exists. The Secret Key must never reach browser code.
2. **Never log** passwords, OTPs, OAuth codes, checksums, access tokens or session tokens.
3. **Real orders.** Live mode places real orders on the signed-in client's account. Test order flows only in demo mode
   (`?feed=mock`, simulated orders `MOCK000001…`). Never place orders on TradeSmart's live site to test.
4. **Demo mode stays dev-only.** `?feed=mock` must keep working only in dev builds (`allowMockFeed`), so a shared
   link can never show simulated prices on a trading page.
5. **Never expose the dev proxy.** With `.env.local` present, never run `ng serve --host 0.0.0.0`.
6. **Git.** Commit or push only when the user asks. Branch first if on `main`.

## How the code is written (follow it)

- Angular 22, **zoneless**, standalone components, **signals**, `ChangeDetectionStrategy.OnPush` everywhere.
- **Presentational components** (`ui/`) take `input()`s and emit `output()`s only; they never inject the store.
  The page (`feature-shell/option-chain-page.component.ts`) is the only place that wires stores to components.
- Feature services are provided per page in `feature-shell/option-chain.providers.ts`, so they die with the page.
- Real vs demo: the page injects `KambalaRestClient` and `FEED_TRANSPORT`; in demo mode the providers swap in
  `MockKambalaRestClient` / the mock transport backed by `MockMarket`. **Anything you add to the REST client must also
  be added to `KambalaRestApi` and `MockKambalaRestClient`.**
- Colours and sizes use the TradeSmart tokens (`--ts-*` in `src/styles/_tradesmart-tokens.scss`); light and dark both
  come from them. Never hard-code colours.
- Comments explain *why*. Anything TradeSmart must plug in is marked `// INTEGRATION:` and listed in the README.
- **Test-first:** add or update a spec with every behaviour change. Tests use plain DOM queries and `TestBed`.
- User-facing text is short, plain English, verb-first on buttons.

## Pitfalls that have bitten before

- **Feed subscriptions are ref-counted.** Kambala sends a `tk` snapshot (with previous close `c`, `poi`, `o`) only when
  a key goes from 0 to 1 subscriber. A re-subscribed key gets no snapshot, which is why `OptionChainStore` keeps a
  `feedCache` of merged ticks. Don't remove it.
- **Market hours** live in one place: `isFoSessionOpen(nowMs, exch)` in `data-access/market-session.service.ts`
  (NFO/BFO 09:15–15:40 IST, MCX 09:00–23:30 or 23:55 in US summer). Don't show closing times in the UI.
- **"Placed" is not "filled".** `executeStrategy` only places; `OrderTracker` follows each order to a final state.
  Never auto-cancel or square off for the user.
- **BSE (BFO) market orders** are not sent (they need `mkt_protection`, not agreed). Keep `BFO_MKT` guards.
- **Windows line endings:** some files are CRLF. Scripted find-and-replace must handle `\r\n`; prefer the Edit tool.
- **Lot sizes** come from each contract's `ls` (SENSEX changes from 20 to 25 for 2027 expiries); never hard-code them.

## Product decisions already made (don't undo without asking)

- Desktop web only; the chain opens in its own browser tab. Quick buttons: NIFTY and SENSEX only.
- No theme switch: the theme follows TradeSmart (`body[color-theme]` from the host, else `?theme=`, else light, the default).
- No Log out button and no client ID on the page.
- Default tab columns: Volume · OI · OI Chg % · LTP Chg (%) · LTP (mirrored for puts). One row height (36 px) on every tab.
- Search lists NSE (NFO) results before BSE (BFO).
- Build your strategy: Limit is the default order type; legs are listed buys first; orders are sent buys first and
  stop at the first rejection; failed legs are handled with **Cancel open orders** / **Retry failed legs**.
- Spot marker: a thin dashed line with a green price label between strikes (Dhan style), with hysteresis; no ATM box.
- Pending ideas, not built: MCX (commodity) options in search; Volume Chg % (Kambala's feed has no previous-day
  volume); Strategy Builder (sub-project 2).
