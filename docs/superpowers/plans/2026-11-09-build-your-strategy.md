# Build Your Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Dhan-style "Build your strategy" pop-up at the bottom right of the option chain: the ticked contracts become editable legs with Kambala margin, Save to basket, and Execute all.

**Architecture:** A page-scoped `StrategyStore` (signals) owns the legs per underlying and becomes the single source of the chain's ticks. Kambala's `GetBasketMargin` / `PlaceOrder` are added to `KambalaRestClient` (and the mock client), so mock mode swaps them out as today. A debounced `StrategyMarginService` and a pure `executeStrategy()` sit beside the store. `StrategyPanelComponent` is the pop-up; the page wires everything together.

**Tech Stack:** Angular 22 (zoneless, signals, OnPush, standalone), Vitest via `npx ng test --watch=false`, Kambala REST (form body `jData=`).

**Spec:** `docs/design/build-your-strategy-design.html` (published: https://claude.ai/artifact/Faov6nEKXnXwzqJgLCJjFP)

## Global Constraints

- All paths below are under `reference-code/src/app/features/option-chain/` unless they start with `reference-code/` or `docs/`.
- No git commits or pushes: the user commits on request only. Each task ends with the full test run passing instead.
- Run tests from `reference-code/`: `npx ng test --watch=false` (single file: add `--include="**/<file>.spec.ts"`). Baseline before Task 1: 41 files, 537 passed, 1 skipped.
- Never read, print or log `reference-code/.env.local`, session tokens, `accessToken`, `susertoken`, passwords or OTPs. Errors shown to the user carry Kambala's `emsg` only.
- Mock mode (`?feed=mock`, `OPTION_CHAIN_MOCK_MODE`) must never call a real Kambala endpoint; it is dev-only as today.
- Copy is fixed by the spec: "Build your strategy", "Your strategy · {SYM}", "Margin needed", "Hedge benefit", "Net premium", "Lot ×", "Intraday", "Normal", "Save to basket", "Execute all", "Place {n} orders", "Back", "Placed", "Rejected", "Not sent", "Margin unavailable", "Market closed", "A strategy holds up to 10 legs".
- Max 10 legs per strategy (`MAX_LEGS = 10`). Margin debounce 400 ms. New leg: side B, 1 lot, `LMT` at the live LTP, included.
- qty = lots × lotMultiplier × contract `lotSize` (never hard-coded). `prd`: Intraday → `I`, Normal → `M`. `ret`: `DAY`. `remarks`: `OC-STRATEGY`. MKT on PlaceOrder sends `prc: "0"`; on GetBasketMargin `prc` = live price.
- MKT switch hidden on BFO legs (limit only). Execute all disabled while the market is closed (`MarketSessionService.isOpen()` false).
- Style with the existing `--ts-*` tokens (`src/styles/_tradesmart-tokens.scss`): CE red `--ts-red`, PE green `--ts-green`, Buy `--ts-blue`, Sell `--ts-red`. Every control keyboard reachable with a visible focus ring.
- "See in Builder", payoff chart, drag reorder, AMO, SL order types, freeze-qty splitting: out of scope.

## Review Focus

1. **The same contract ticked twice / swapped onto an existing leg:** a contract is at most one leg; a swap onto a contract already in the strategy is refused with the status "Already in your strategy" and the leg stays unchanged. (Task 2 test.)
2. **Leg prices off the visible chain:** a leg from another expiry keeps updating its live price after the user switches expiry, and switching back does not drop the feed for a leg still in the strategy (ref-counted subscriptions). (Task 4 test.)
3. **Out-of-order margin answers:** a slow older margin response must never overwrite a newer one. (Task 3 test.)
4. **Double Execute:** pressing "Place n orders" twice, or editing legs while orders are going out, must not send a leg twice; the panel locks while placing. (Task 5 test.)
5. **Restored session data that is malformed or from an older shape** must be ignored, not crash the page. (Task 2 test.)

---

### Task 1: Kambala basket margin and order placement

**Files:**
- Modify: `data-access/kambala/kambala.types.ts` (add types)
- Modify: `data-access/kambala/kambala-rest.client.ts` (two methods, widen `call` data type, extend `KambalaRestApi`)
- Modify: `data-access/testing/mock-kambala-rest.client.ts` (mock both)
- Test: `data-access/kambala/kambala-rest.client.spec.ts`, `data-access/testing/mock-kambala-rest.client.spec.ts` (create)

**Interfaces:**
- Produces (in `kambala.types.ts`):
  ```ts
  export interface OrderLeg { exch: string; tsym: string; qty: number; prc: number; prctyp: 'LMT' | 'MKT'; trantype: 'B' | 'S'; prd: 'I' | 'M'; }
  ```
- Produces (on `KambalaRestClient` and `MockKambalaRestClient`; `KambalaRestApi` gains both names):
  - `getBasketMargin(legs: OrderLeg[]): Promise<number>` — `marginused` as a number.
  - `placeOrder(leg: OrderLeg): Promise<string>` — `norenordno`. Rejections throw `KambalaError(emsg)` (existing envelope handling).

- [ ] **Step 1: Write failing client tests** (use the spec's existing `HttpTestingController` pattern):
  - `getBasketMargin posts the first leg at top level and the rest in basketlists`: two legs → one POST to `${base}/GetBasketMargin`; parsed `jData` has `uid`, `actid` (from the session config), first leg's `exch,tsym,qty:"130",prc:"14.95",prd:"I",trantype:"B",prctyp:"LMT"` at top level, and `basketlists` = `[{exch,tsym,qty,prc,prd,trantype,prctyp}]` for the second, all values strings. Response `{stat:'Ok', marginused:'118420.50'}` → resolves `118420.5`.
  - `getBasketMargin with one leg sends no basketlists`.
  - `placeOrder sends ret DAY and remarks OC-STRATEGY and resolves norenordno`: jData includes `ret:'DAY'`, `remarks:'OC-STRATEGY'`, `actid`; `{stat:'Ok', norenordno:'26110900123'}` → `'26110900123'`.
  - `placeOrder rejects with Kambala's emsg`: `{stat:'Not_Ok', emsg:'RMS: insufficient margin'}` → rejects `KambalaError` with that message.
- [ ] **Step 2: Run** `npx ng test --watch=false --include="**/kambala-rest.client.spec.ts"` → the new tests FAIL (methods missing).
- [ ] **Step 3: Implement** the two methods. Widen `call`'s `data` to `Record<string, string | object[]>` (kambalaFormBody already JSON-encodes). Add `actid: this.session().actid` to both requests. Number fields go as strings (`String(qty)`, `prc.toFixed(2)`). Comment both with `// INTEGRATION: confirm the path on TradeSmart's v2 base (the Kambala doc lists /NorenWClientTP/<name>).`
- [ ] **Step 4: Mock client tests** (`mock-kambala-rest.client.spec.ts`, new):
  - `basket margin: each sell is strike × qty × 0.10, each buy is prc × qty, and a basket holding both a buy and a sell is charged 35 % of the sum` (strike parsed from the mock tsym via `MockMarket`'s contract lookup, or pass-through: implementer may read strike from `tsym` digits before `C`/`P` as the mock market names them; assert concrete numbers for one sell 22850 CE qty 65 → 148525 and a 2-leg hedged basket).
  - `placeOrder returns MOCK-prefixed increasing order numbers` (`MOCK000001`, `MOCK000002`).
  - `placeOrder rejects quantities above 1800 with "Quantity exceeds freeze limit"` (KambalaError).
- [ ] **Step 5: Implement** the mock, run the whole suite → all pass.

---

### Task 2: Strategy model and StrategyStore

**Files:**
- Create: `strategy/strategy.models.ts`, `strategy/strategy.store.ts`
- Test: `strategy/strategy.store.spec.ts`

**Interfaces:**
- Consumes: `OPTION_CHAIN_USER_ID` (feature-shell/option-chain.providers.ts).
- Produces (`strategy.models.ts`):
  ```ts
  export const MAX_LEGS = 10;
  export type Product = 'I' | 'M';
  export type LegResult = { status: 'placed'; orderNo: string } | { status: 'rejected'; reason: string } | { status: 'not-sent' };
  /** A contract as offered by the chain or a picker. */
  export interface LegContract { token: string; tsym: string; exch: string; expiryIso: string; strike: number; type: 'CE' | 'PE'; lotSize: number; ltp: number | null; }
  export interface StrategyLeg extends Omit<LegContract, 'ltp'> { id: string; side: 'B' | 'S'; lots: number; priceType: 'LMT' | 'MKT'; price: number; included: boolean; result?: LegResult; }
  export interface Strategy { legs: StrategyLeg[]; lotMultiplier: number; product: Product; }
  export type LegEdit = Partial<Pick<StrategyLeg, 'side' | 'lots' | 'priceType' | 'price' | 'included'>>;
  export function legQty(leg: StrategyLeg, lotMultiplier: number): number; // lots × lotMultiplier × lotSize
  /** Σ over included legs of (S ? +1 : −1) × px × qty; px = live[token] for MKT (falls back to price), else price. */
  export function netPremium(s: Strategy, live: ReadonlyMap<string, number>): number;
  ```
- Produces (`StrategyStore`, `@Injectable()` page-scoped):
  - `readonly current: Signal<Strategy>` — strategy of the active underlying (empty `{legs:[],lotMultiplier:1,product:'I'}` by default).
  - `readonly tokens: Signal<ReadonlySet<string>>` — feed keys of the current legs (the chain's ticks).
  - `readonly allTokens: Signal<string[]>` — feed keys of legs across all underlyings (for the price feed).
  - `setUnderlying(key: string): void`
  - `toggle(c: LegContract): 'added' | 'removed' | 'full'`
  - `remove(id: string): void`, `clear(): void` (current underlying only)
  - `update(id: string, edit: LegEdit): void` — `lots` clamped to ≥ 1; editing clears that leg's `result`.
  - `swap(id: string, c: LegContract): 'ok' | 'duplicate'` — keeps id, side, lots, included, priceType; price ← `c.ltp ?? 0`; clears result.
  - `setLotMultiplier(n: number): void` (≥ 1), `setProduct(p: Product): void`
  - `resetPrices(live: ReadonlyMap<string, number>): void` — every LMT leg's price ← live price when known.
  - `setResults(results: ReadonlyMap<string, LegResult>): void`
  - `forget(): void` — clears everything and the stored copy (log out).

- [ ] **Step 1: Write failing tests:**
  - `toggle adds a Buy of 1 lot, LMT at the LTP, included; toggling again removes it`.
  - `an 11th leg returns "full" and is not added`.
  - `strategies are per underlying`: add on `NSE|26000`, `setUnderlying('BSE|1')` → empty; back → the leg is there.
  - `swap keeps side and lots, takes the new contract and its LTP; swap onto a contract already in the strategy returns "duplicate" and changes nothing`.
  - `update clamps lots to 1 and clears the leg's result`.
  - `netPremium`: S 22850 CE 69.90 ×1 lot (65) + S 22900 PE 68.85 + B 23000 CE 14.95, lotMultiplier 1 → `(69.90 + 68.85 − 14.95) × 65 = 8047`; an excluded leg does not count; a MKT leg uses the live price.
  - `persists to sessionStorage under ts.optionChain.strategy.v1:<uid> and restores on a new store` (strip `result` when saving).
  - `ignores malformed stored data` (`'{'`, `'{"byUnderlying":5}'`, legs missing fields) → empty strategy, no throw.
  - `forget clears the stored copy`.
- [ ] **Step 2: Run** the file → FAIL (module missing).
- [ ] **Step 3: Implement** both files. Legs ids: `leg-${n}` from a per-store counter seeded past restored ids. Storage access wrapped in try/catch; write on every change via an `effect`.
- [ ] **Step 4: Run** the whole suite → all pass.

---

### Task 3: StrategyMarginService

**Files:**
- Create: `strategy/strategy-margin.service.ts`
- Test: `strategy/strategy-margin.service.spec.ts`

**Interfaces:**
- Consumes: `KambalaRestClient` (`getBasketMargin`, Task 1), `StrategyStore.current` (Task 2), `CHAIN_FEED_SCHEDULER` (data-access/chain-feed.facade.ts) for the debounce.
- Produces: `@Injectable()` `StrategyMarginService` with
  - `readonly state: Signal<MarginState>` where `type MarginState = { status: 'empty' } | { status: 'loading' } | { status: 'ready'; margin: number; hedgeBenefit: number } | { status: 'error' }`.
  - `setLivePrices(live: Signal<ReadonlyMap<string, number>>): void` — the source of live prices for MKT legs (read untracked at request time).
  - `retry(): void`
  - `export const MARGIN_DEBOUNCE_MS = 400;`
  - `export function toOrderLeg(leg: StrategyLeg, s: Strategy, livePrice: number | null, forMargin: boolean): OrderLeg` (also used by Task 5).

- [ ] **Step 1: Write failing tests** (fake scheduler; fake REST with controllable promises):
  - `no included legs → empty, no request`.
  - `requests 400 ms after the last change, combined plus one per leg, hedgeBenefit = Σ single − combined` (2 legs: singles 148525 + 972, combined 52323 → `{margin: 52323, hedgeBenefit: 97174}`).
  - `a single leg makes one request and hedgeBenefit 0`.
  - `a newer request's answer wins even when the older one resolves last`.
  - `a price tick alone does not re-request` (live map changes, legs unchanged).
  - `failure → error; retry() requests again`.
  - `toOrderLeg`: qty = lots × multiplier × lotSize; MKT → `prc` live price for margin and `0` for orders; `prd` from the strategy.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Re-request on a computed key built from each included leg's `token|side|lots|priceType|price` plus multiplier and product. Tag each round with an increasing id; ignore answers from older ids.
- [ ] **Step 4: Run** the whole suite → all pass.

---

### Task 4: Live prices for legs off the visible chain

**Files:**
- Modify: `data-access/option-chain.store.ts` (leg price cache)
- Modify: `data-access/chain-feed.facade.ts` (hold leg keys)
- Test: `data-access/option-chain.store.spec.ts`, `data-access/chain-feed.facade.spec.ts`

**Interfaces:**
- Produces on `OptionChainStore`:
  - `readonly legPrices: Signal<ReadonlyMap<string, number>>` — last LTP per key in the held leg set.
  - `setLegKeys(keys: ReadonlySet<string>): void` — keys whose ticks feed `legPrices` (prunes removed keys).
- Produces on `ChainFeedFacade`: `holdLegKeys(keys: string[]): void` — subscribes keys newly held and unsubscribes keys no longer held (the transport ref-counts, so chain and leg subscriptions of the same key coexist); also calls `store.setLegKeys`. Released on destroy. Not touched by `unsubscribeAll()` on underlying / expiry switches.

- [ ] **Step 1: Failing tests:**
  - store: `applyTicks feeds legPrices for held keys, including keys not in the chain`; `setLegKeys drops keys no longer held`; a chain leg key that is also held updates both its quote and `legPrices`.
  - facade (mock transport, existing spec helpers): `holdLegKeys subscribes new keys once and unsubscribes released ones`; `switching expiry keeps a held leg key subscribed` (assert the transport ref count / no `u` for that key after `loadExpiry`); `destroy releases held keys`.
- [ ] **Step 2: Run** both files → FAIL.
- [ ] **Step 3: Implement.** In `applyTicks`, before the existing branches: `if (legKeys.has(key) && partial.ltp != null) changed legPrices`. Publish a new Map once per batch.
- [ ] **Step 4: Run** the whole suite → all pass.

---

### Task 5: executeStrategy

**Files:**
- Create: `strategy/execute-strategy.ts`
- Test: `strategy/execute-strategy.spec.ts`

**Interfaces:**
- Consumes: `toOrderLeg` (Task 3), `Strategy`, `LegResult` (Task 2).
- Produces: `executeStrategy(s: Strategy, live: ReadonlyMap<string, number>, place: (o: OrderLeg) => Promise<string>, onProgress?: (r: ReadonlyMap<string, LegResult>) => void): Promise<Map<string, LegResult>>` — results keyed by leg id, included legs only.

- [ ] **Step 1: Failing tests:**
  - `places buys before sells, keeping listed order within each group` (legs S1, B1, S2, B2 → calls B1, B2, S1, S2).
  - `stops at the first rejection: that leg rejected with emsg, the rest not-sent, earlier ones placed`.
  - `excluded legs are not placed and get no result`.
  - `MKT legs are sent with prctyp MKT and prc 0`.
  - `onProgress is called after each leg with the results so far`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (sequential `await`; a thrown non-Kambala error uses the reason "Could not place the order. Check the order book before retrying."). **Step 4: Run** the whole suite → all pass.

---

### Task 6: StrategyPanelComponent (the pop-up)

**Files:**
- Create: `ui/strategy-panel/strategy-panel.component.ts`, `.html`, `.scss`
- Test: `ui/strategy-panel/strategy-panel.component.spec.ts`

**Interfaces:**
- Consumes: `Strategy`, `StrategyLeg`, `LegContract`, `LegEdit`, `Product`, `netPremium` (Task 2), `MarginState` (Task 3), `formatExpiryDate` (ui/expiry-strip/expiry-strip.component.ts).
- Inputs: `sym: string`, `strategy: Strategy`, `live: ReadonlyMap<string, number>`, `margin: MarginState`, `expiries: Expiry[]`, `pickerFor: (leg: StrategyLeg) => { strikes: number[]; ready: boolean }` (strike options for the leg's expiry + type; `ready` false while loading), `marketOpen: boolean`, `placing: boolean`.
- Outputs: `edit: {id, edit: LegEdit}`, `remove: string`, `clearAll: void`, `swap: { id: string; expiryIso: string; strike: number; type: 'CE' | 'PE' }`, `lotMultiplier: number`, `product: Product`, `resetPrices: void`, `retryMargin: void`, `saveToBasket: void`, `execute: void` (emitted from the confirm step only), `collapse: void`.
- Internal `view` signal: `'edit' | 'confirm' | 'results'` — switches to `'results'` when any leg has a `result`; any edit returns to `'edit'`.

Layout per the spec mock-up: header "Your strategy · {sym}" + "{n} legs" + collapse chevron; table columns include box, B/S, Expiry (select), Strike (select), Type (CE/PE toggle, chip colours as the chain), Lots (− n +), Price (input + MKT toggle + "Live x" line; ↻ in the header), delete; summary row (Margin needed / Hedge benefit / Net premium; "…" while loading; "Margin unavailable" + Retry on error; Net premium + green, − red, formatted `₹ 1,18,420` en-IN, no decimals); action row (Lot × stepper, Intraday/Normal segmented, Save to basket, Execute all). Width 600px, anchored by the page; legs area scrolls inside past ~5 rows. Esc emits `collapse`.

- [ ] **Step 1: Failing tests:**
  - `renders one row per leg with side, expiry, strike, type, lots and price`.
  - `B/S, lots ± and the include box emit edit`; `lots − at 1 stays disabled`.
  - `changing the strike or expiry select emits swap with the new values`.
  - `MKT toggle emits priceType and disables the price input; hidden on BFO legs`.
  - `summary shows "…" while loading, the figures when ready, "Margin unavailable" + Retry on error`; `net premium shows + ₹ 8,047 in green`.
  - `Execute all opens the confirm step listing every included leg (side, contract, qty, price or MKT) and "Place 3 orders"`; `Back returns`; `Place emits execute once and the button disables while placing` (Review Focus 4).
  - `Execute all is disabled with "Market closed" when marketOpen is false`.
  - `results view shows Placed with the order number, Rejected with the reason, Not sent`.
  - `Esc emits collapse`; every control is a button/input/select with an accessible name.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the whole suite → all pass.

---

### Task 7: Page wiring and footer button

**Files:**
- Modify: `ui/footer-actions/footer-actions.component.ts` (+ spec): input `strategyOpen: boolean`, output `buildStrategy: void`; button "Build your strategy" + badge (`checkedCount`) pushed right (`margin-left: auto`), `aria-expanded` = `strategyOpen`, disabled at 0 legs, `.tool` styles with blue text/border.
- Modify: `feature-shell/option-chain-page.component.ts`, `.html`, `.scss`, `option-chain.providers.ts` (provide `StrategyStore`, `StrategyMarginService`).
- Test: `feature-shell/option-chain-page.component.spec.ts`

**Interfaces:** consumes everything above.

Wiring decisions:
- `checked` becomes `computed(() => strategy.tokens())`; `resetSelectionView` no longer clears it; `select()` calls `strategy.setUnderlying(underlyingKey(u))`.
- `onToggleCheck(token)` builds a `LegContract` from the current chain meta + quote (ltp) and calls `strategy.toggle`; `'full'` → `showStatus('A strategy holds up to 10 legs')`.
- Effect: `facade.holdLegKeys(strategy.allTokens())`. Live map for the panel = `store.legPrices()`.
- Picker data: current expiry from `store.meta()`; other expiries loaded once via `InstrumentsService.loadChain(u, e, spot, 40)` into a page-level `Map<expiryIso, ChainMeta>` cache; `swap` resolves the contract from that meta (ltp from `legPrices` or chain quote, else null) and calls `strategy.swap`; `'duplicate'` → `showStatus('Already in your strategy')`.
- `strategyOpen` signal: footer button toggles; panel `collapse` closes. Panel is `position: absolute; right: 14px; bottom: <footer height + 8px>` inside `.page` (`position: relative`), `z-index` above the table's sticky header.
- `onExecute`: `placing.set(true)`; `executeStrategy(strategy.current(), store.legPrices(), (o) => rest.placeOrder(o), (r) => strategy.setResults(r))`; finally `placing.set(false)`. Never runs twice concurrently.
- `onSaveToBasket`: mock → `showStatus('Saves {n} legs to your basket, as today.')`; live → `// INTEGRATION: BasketService.add(legs)` with `{ exch, token: rawToken, tsym, side, qty, price, priceType, product }` per included leg.
- Log out (existing `logout()`): call `strategy.forget()` first.
- Existing footer Add to Watchlist / Add to Basket keep working on `checked` (the leg tokens); `checkedContracts()` reads tsym from the legs.

- [ ] **Step 1: Failing page tests** (mock mode helpers already in the spec):
  - `ticking a call shows "Build your strategy 1"; opening it lists the leg; deleting the leg unticks the chain`.
  - `legs survive an underlying switch and come back` (NIFTY → SENSEX → NIFTY).
  - `margin shows after 400 ms in mock mode` (advance the fake clock).
  - `Execute all → Place → each leg shows Placed with a MOCK order number` and no real REST client is constructed in mock mode.
  - `a held leg from another expiry keeps updating its live price after switching expiry` (Review Focus 2).
  - `logout forgets the strategy`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the whole suite → all pass; `npx ng build` succeeds (the existing chain-table style budget warning is known).

---

### Task 8: Verify in the browser and update docs

- [ ] **Step 1:** With the dev server on 4200, open `http://localhost:4200/option-chain?feed=mock`; tick 3 contracts, open the pop-up, edit B/S, lots, strike, expiry, MKT, include box; check margin, hedge benefit, net premium; Execute all → confirm → results; Save to basket status line; light and dark themes; Esc collapses; keyboard-only pass. Screenshot both themes to `docs/design/screenshots/strategy-panel-light.png` / `-dark.png`.
- [ ] **Step 2:** Add a "Build your strategy" section to `reference-code/README.md` hand-off listing the INTEGRATION points (GetBasketMargin / PlaceOrder paths, `BasketService.add`, `prarr` check, BFO `mkt_protection`).
- [ ] **Step 3:** Full suite and `npx ng build` pass; report results to the user. No commit unless asked.
