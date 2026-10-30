# Option Chain Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Angular reference implementation of TradeSmart's upgraded option chain: a tested analytics library, a Kambala data layer with a mock feed, and the desktop-web chain screen. Also produce a standalone clickable prototype and a hand-off README for the tech team.

**Architecture:** A framework-free TypeScript analytics library (`src/libs/option-analytics`) computes IV, Greeks, forward, Max Pain, PCR, OI Sense, straddle and GEX. It runs in a Web Worker once a second. A signals store holds quotes merged from the Kambala touchline feed through a tick buffer. Presentational components render a custom `<table>` driven by a column registry. Everything runs against a `MockFeedTransport` until the team plugs in the real session and socket at `// INTEGRATION:` points.

**Tech Stack:** Angular 22 (standalone, zoneless, signals, OnPush), Ionic 9 (page chrome only), TypeScript strict, Vitest (Angular default runner), Playwright (e2e), Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-10-29-option-chain-core-design.md`. Formulas and golden vectors: `docs/research/option-analytics-formulas.md` (§ numbers below refer to it). API contracts: `docs/research/kambala-api-reference.md`. Architecture sketches: `docs/research/angular-architecture.md`. Visual reference: `docs/design/option-chain-core-design.html` (published at https://claude.ai/artifact/8Ff6bPETBXEySZgbktHc76).

## Global Constraints

- All code lives under `Option chain MVP/reference-code/` (Angular workspace `option-chain-ref`). The prototype lives at `Option chain MVP/prototype/option-chain-prototype.html`.
- Desktop web only. No mobile layout. The table is plain HTML/CSS; Ionic is used only for page chrome. Never render rows with `ion-grid` or `ion-item`.
- `src/libs/option-analytics/**` must not import Angular, RxJS or DOM APIs. It must run unchanged in Node.
- The normal CDF must be double precision (Cody erfc or equivalent, ~1e-15). Abramowitz & Stegun 26.2.17 / 7.1.26 are forbidden.
- Golden-vector tolerances: prices and Greeks relative 1e-8 (absolute 1e-9 when |x| < 1e-3); IV absolute 1e-7.
- Model: Black-76 on the forward. Delta and gamma are reported in spot terms. Theta is ₹ per calendar day with F fixed; vega is ₹ per 1 vol point.
- Time: ACT/365 to the second, expiry at 15:30:00 IST (UTC+05:30). DTE label is the IST calendar-date difference, `"{n}d"`, `"0d"` on expiry day.
- IV bounds σ ∈ [0.001, 5.0], max 100 iterations. Statuses `OK | NO_PRICE | BELOW_INTRINSIC | ABOVE_MAX | BELOW_MIN_VOL | ABOVE_MAX_VOL | EXPIRED | NO_CONVERGENCE`. Never return a clamped σ.
- `OptionChainConfig` defaults: `riskFreeRate 0.0575`, `oiUnit 'qty'`, `chainCnt 100`, `recalcIntervalMs 1000`, `staleAfterMs 30000`, `minTimeToExpirySec 60`, `forwardStrikesEachSide 3`, `spotSlotHysteresis 0.1`.
- Aggregates (Max Pain, PCR, Cum OI, GEX) always use **all subscribed strikes**, never the visible window.
- Lot size is never hard-coded. It is read per contract from Kambala `ls`.
- Quick-switch buttons: NIFTY and SENSEX only. Everything else is reached via search.
- Theme: TradeSmart tokens from spec §5.3 (green `#39B00E`, red `#E83937`, blue `#3F71EB`, Roboto, dark `#0A1222`). CE OI bars red, PE OI bars green, Cum OI bars blue. Hover B is blue, S is red.
- Spot line: a dashed green line plus a green price label between strikes. It scrolls with the chain, is sticky at the top and bottom edges, and moves only past 10 % of a strike step. No ATM outline box.
- Custom column editor is visible only while the Custom view is selected.
- Preferences: localStorage key `ts.optionChain.prefs.v1`, versioned, every access in try/catch.
- Number format: OI and volume in lakhs, 2 decimals. IV and % to 2 decimals. Delta 4, gamma 4, theta 2, vega 2.

## Review Focus

1. **Partial ticks carrying only some fields** (`tf` with just `lp`) must not reset OI, bid or ask to 0 or undefined. Tested in Task 7 (`merges partial tf without clearing missing fields`).
2. **Contracts with zero bid and ask and no volume** (deep OTM, illiquid stocks) must show "–" for IV and Greeks but still count in OI totals, PCR and Max Pain. Tested in Task 6 (`illiquid leg excluded from IV but counted in aggregates`).
3. **Switching expiry twice quickly** must never show the first expiry's strikes under the second expiry's label. Tested in Task 8 (`discards a stale chain load`).
4. **Expiry day after 15:30 and the final minutes** must not produce huge or NaN Greeks. They show `EXPIRED` and null. Tested in Task 4 (`expired returns null greeks`) and Task 6 (`expired chain yields EXPIRED status, no NaN`).
5. **Spot exactly on a strike or wobbling across it** must not make the spot line flip each tick. Tested in Task 10 (`spotSlot holds within hysteresis band`).

---

### Task 1: Workspace scaffold

**Files:**
- Create: `reference-code/` via Angular CLI, `reference-code/src/libs/option-analytics/index.ts`, `reference-code/src/libs/option-analytics/smoke.spec.ts`
- Create: `Option chain MVP/.gitignore` (`node_modules/`, `dist/`, `.angular/`, `test-results/`, `playwright-report/`)

**Interfaces:**
- Produces: a building, testing Angular 22 app with zoneless change detection; path alias `@option-analytics/*` → `src/libs/option-analytics/*`.

- [ ] **Step 1:** In `Option chain MVP/`, run `git init` (the folder is not a repo yet; confirm with the user first) and `npx -y @angular/cli@22 new option-chain-ref --directory reference-code --style=scss --routing --zoneless --ssr=false --skip-git`.
- [ ] **Step 2:** In `reference-code/`, run `npm i @ionic/angular@9 @angular/cdk@22` and `npm i -D @playwright/test`. Add the `@option-analytics/*` path to `tsconfig.json` `compilerOptions.paths`. Enable `"strict": true` (CLI default) and `"noUncheckedIndexedAccess": true`.
- [ ] **Step 3:** Write `smoke.spec.ts`: `it('runs in the test runner', () => expect(1 + 1).toBe(2))`.
- [ ] **Step 4:** Run `npx ng test --watch=false`. Expected: the smoke test and the generated app test PASS.
- [ ] **Step 5:** Commit: `chore: scaffold option-chain reference workspace`.

---

### Task 2: Normal distribution and Black-76 pricing and Greeks

**Files:**
- Create: `src/libs/option-analytics/types.ts`, `normal.ts`, `black76.ts`
- Test: `src/libs/option-analytics/black76.spec.ts`

**Interfaces:**
- Produces:
  - `type OptType = 'CE' | 'PE'`
  - `normCdf(x: number): number`, `normPdf(x: number): number`
  - `black76(type: OptType, F: number, K: number, T: number, r: number, sigma: number): { price: number; d1: number; d2: number }`
  - `greeks(type: OptType, F: number, S: number, K: number, T: number, r: number, sigma: number): { delta: number; gamma: number; theta: number; vega: number; itmProb: number }`. Delta and gamma are spot terms (§5). `theta = [−D·F·n(d1)·σ/(2√T) + r·V]/365`. `vega = D·F·n(d1)·√T/100`. `itmProb = N(d2)` for CE, `N(−d2)` for PE.

- [ ] **Step 1: Write failing tests**, with a helper `close(a, b)` applying the global tolerances:
  - `normCdf(0) === 0.5`, `normCdf(1.96)` ≈ 0.9750021048517795, `normCdf(-8)` ≈ 6.22096057427178e-16 (relative 1e-8).
  - V1 (F = 42·e^{0.05}, K 40, r 0.10, σ 0.20, T 0.5, S 42): CE price 4.759422393, PE 0.8085993729, d1 0.7692626281, CE delta 0.7791312909, PE delta −0.2208687091, gamma 0.04996267041, vega 0.0881341506, CE itmProb 0.7349460368.
  - V2 (S = 100, F = 100·e^{0.05}, K 100, r 0.05, σ 0.2, T 1): CE 10.45058357, PE 5.573526022, CE delta 0.6368306512, gamma 0.01876201735, vega 0.3752403469.
  - V3 (Black-76, F = S = 20, K 20, r 0.09, σ 0.25, T 1/3): PE price 1.116641457.
  - V7 (F 25000, r 0.06, T 0.01432648401826484, S = F·e^{−rT}): 25000 CE σ 0.12 price 143.1278285, theta −13.66176628, vega 11.92711399; 25500 CE σ 0.13 price 18.93560673, itmProb 0.1001966182; 24500 PE σ 0.14 price 22.97919068.
  - V9: spot delta CE 0.5028650183, PE −0.4971349817, spot gamma 0.001111939394.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/libs/option-analytics/black76.spec.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement `normal.ts` with W. J. Cody's rational erfc (`normCdf(x) = 0.5·erfc(−x/√2)`), then `black76.ts` per the signatures above.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(analytics): Black-76 pricing and spot Greeks`.

---

### Task 3: Implied volatility solver and price selection

**Files:**
- Create: `src/libs/option-analytics/iv.ts`; extend `types.ts` with `LegQuote` and `IvStatus`
- Test: `src/libs/option-analytics/iv.spec.ts`

**Interfaces:**
- Consumes: `black76`, `normPdf` (Task 2).
- Produces:
  - `interface LegQuote { token: string; type: OptType; strike: number; lotSize: number; tickSize: number; ltp: number | null; bid: number | null; ask: number | null; bidQty: number; askQty: number; volume: number; oi: number; prevOi: number; prevClose: number | null; open: number | null; high: number | null; low: number | null; lastTickMs: number }`
  - `selectPrice(q: LegQuote): { price: number; source: 'MID' | 'LTP' } | null`. Mid when bid > 0, ask ≥ bid, both qty > 0 and spread ≤ max(5·tickSize, 0.10·mid); else LTP if volume > 0; else null (§2.5).
  - `solveIv(type: OptType, price: number, F: number, K: number, T: number, r: number, warm?: number): { iv: number | null; status: IvStatus; iterations: number }`. Safeguarded Newton exactly as §2.3, on undiscounted P' = price·e^{rT}, with the bound checks from §2.2 before iterating.
  - `isLowConfidence(price: number, tickSize: number): boolean`. True when price < 0.50 or < 4 ticks.

- [ ] **Step 1: Write failing tests** (F 25000, r 0.06, T 0.01432648401826484 unless stated):
  - V8: CE 160 @ 25000 → 0.1341461084; PE 140 @ 25000 → 0.1173775493; CE 20 @ 25500 → 0.1319621404; PE 3 @ 24000 → 0.1618032012; CE 1005 @ 24000 → 0.1797455660; CE 900 @ 24000 → `{iv: null, status: 'BELOW_INTRINSIC'}`.
  - V8 parity: at F = 25020.01719917187, CE 160 and PE 140 @ 25000 both → 0.1255334321.
  - V12: CE 0.05 @ 26500 → 0.1459646448; CE 0.10 @ 26500 → 0.1538365464; PE 0.05 @ 23000 → 0.2046296875; CE 0.05 @ 25000 → `{iv: null, status: 'BELOW_MIN_VOL'}`; T = 1/525600 ATM CE price 2.063543389 → 0.15.
  - Round-trip: each V7 price solves back to its σ within 1e-7, and warm start from the true σ takes ≤ 2 iterations.
  - `selectPrice`: bid 99.9 / ask 100.1 (qty 75/75, tick 0.05) → MID 100; bid 90 / ask 110 → LTP when volume 10, null when volume 0; bid 0 / ask 0 / volume 0 → null.
  - `isLowConfidence(0.10, 0.05) === true`, `isLowConfidence(12, 0.05) === false`.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/libs/option-analytics/iv.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `iv.ts`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(analytics): IV solver with arbitrage bounds and price selection`.

---

### Task 4: Time to expiry, DTE label and forward estimation

**Files:**
- Create: `src/libs/option-analytics/time.ts`, `forward.ts`; extend `types.ts` with `StrikeQuotes` and `ForwardSource`
- Test: `src/libs/option-analytics/time.spec.ts`, `forward.spec.ts`

**Interfaces:**
- Consumes: `selectPrice` (Task 3), `LegQuote`.
- Produces:
  - `expiryInstantMs(isoDate: string): number`. `'2026-11-03'` → epoch ms of 2026-11-03T15:30:00+05:30.
  - `yearsToExpiry(nowMs: number, expiryMs: number): number`. Seconds / (365·86400), floored at 0.
  - `isExpired(nowMs: number, expiryMs: number, minSec: number): boolean`
  - `dteLabel(nowMs: number, isoDate: string): string`
  - `interface StrikeQuotes { strike: number; ce: LegQuote | null; pe: LegQuote | null }`
  - `type ForwardSource = 'PARITY_MID' | 'FUTURES' | 'PARITY_LTP' | 'SPOT_CARRY'`
  - `estimateForward(args: { spot: number; futuresPrice: number | null; strikes: StrikeQuotes[]; T: number; r: number; prevForward: number | null; eachSide: number }): { forward: number; source: ForwardSource }`. Algorithm §1.3: centre on the strike nearest `prevForward ?? spot`, take ±eachSide strikes, `F_K = K + e^{rT}(C − P)` from MID pairs, take the median, reject if |F/S − 1| > 3 %. Fallbacks in order: futures, LTP pairs, `spot·e^{rT}`.

- [ ] **Step 1: Write failing tests:**
  - V6: `yearsToExpiry(Date.parse('2026-10-29T10:00:00+05:30'), expiryInstantMs('2026-11-03'))` → 0.01432648401826484; `dteLabel(same now, '2026-11-03') === '5d'`; on 2026-11-03T11:00+05:30 → `'0d'`.
  - `isExpired(Date.parse('2026-11-03T15:30:30+05:30'), expiryInstantMs('2026-11-03'), 60) === true`; `isExpired` at 15:28:00 → false; at 15:29:30 → true (under 60 s left).
  - V14: mids CE/PE at 24900 (225, 120), 25000 (160, 155.5), 25100 (108, 203); spot 24980, r 0.06, T as V6 → forward 25004.91830393, source `'PARITY_MID'`.
  - No valid quotes and futuresPrice 25010 → `{forward: 25010, source: 'FUTURES'}`; neither → `spot·e^{rT}` with `'SPOT_CARRY'`.
  - One bad pair (CE mid 900 at 25000) among the three V14 strikes: the median ignores it, and forward is within [25004.9, 25005.1].
  - A median forward more than 3 % from spot is rejected and falls back (spot 20000 with the V14 quotes and no futures → `'PARITY_LTP'` or `'SPOT_CARRY'`, never `'PARITY_MID'`).
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/libs/option-analytics/{time,forward}.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `time.ts` and `forward.ts`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(analytics): expiry time, DTE label, parity forward`.

---

### Task 5: Chain aggregates

**Files:**
- Create: `src/libs/option-analytics/aggregates.ts`; extend `types.ts` with `OiSense`
- Test: `src/libs/option-analytics/aggregates.spec.ts`

**Interfaces:**
- Produces:
  - `type OiSense = 'LONG_BUILD_UP' | 'SHORT_BUILD_UP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL'`
  - `oiSense(priceChg: number, oiChg: number): OiSense`
  - `oiChange(oi: number, prevOi: number): { chg: number; pct: number | null }`. pct is null when prevOi is 0.
  - `maxPain(rows: { strike: number; ceOi: number; peOi: number }[], unitsPerOi: number, forward: number): { maxPain: number | null; painRs: Map<number, number> }`. Ties go to the strike nearest the forward. All-zero OI gives null.
  - `pcr(num: number, den: number): number | null`
  - `straddle(ce: LegQuote, pe: LegQuote): { price: number | null; bid: number | null; ask: number | null; decay: number | null; decayPct: number | null }` (§10)
  - `gexCr(spotGamma: { ce: number | null; pe: number | null }, units: { ce: number; pe: number }, S: number): number`. `(Γce·ce − Γpe·pe)·S²·0.01/1e7`, treating null gamma as 0.

- [ ] **Step 1: Write failing tests:**
  - V13 (lot 75, OI in lots, so unitsPerOi 75): maxPain 25000; painRs at 25000 = 45,000,000 and at 24800 = 123,750,000; overall `pcr(12500, 12000)` ≈ 1.041666667; per-strike PCR values 3.5, 2.666667, 1.0, 0.375, 0.2.
  - V11: `gexCr({ce: 0.001111939394, pe: 0.001111939394}, {ce: 3000*75, pe: 1000*75}, 24978.51950749323)` ≈ 104.065 (absolute 1e-3).
  - V15: straddle CE 160 / PE 140, prev 185 / 170 → price 300, decay −55, decayPct −15.49295775. Sense table: (+12, +50000) LONG_BUILD_UP; (−12, +50000) SHORT_BUILD_UP; (+12, −50000) SHORT_COVERING; (−12, −50000) LONG_UNWINDING; (0, 50000) NEUTRAL.
  - `pcr(5, 0) === null`; `oiChange(100, 0).pct === null`; `maxPain` with all OI 0 → null; straddle with CE bid 0 → bid null.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/libs/option-analytics/aggregates.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `aggregates.ts`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(analytics): max pain, PCR, OI sense, straddle, GEX`.

---

### Task 6: `analyzeChain` orchestrator

**Files:**
- Create: `src/libs/option-analytics/analyze.ts`, `config.ts`; export everything from `index.ts`
- Test: `src/libs/option-analytics/analyze.spec.ts`, `src/libs/option-analytics/testing/sample-chain.ts` (a 21-strike NIFTY fixture built from Black-76 prices with a smile, lot 65)

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `interface OptionChainConfig` with the Global Constraints defaults; `DEFAULT_CONFIG`.
  - `interface ChainInput { spot: number; futuresPrice: number | null; strikes: StrikeQuotes[]; expiryIso: string; nowMs: number; prevForward: number | null; prevIv: Record<string, number>; config: OptionChainConfig }`
  - `interface LegAnalytics { token: string; iv: number | null; ivStatus: IvStatus; ivSource: 'MID' | 'LTP' | null; lowConfidence: boolean; delta: number | null; gamma: number | null; theta: number | null; vega: number | null; itmProb: number | null; oiChg: number; oiChgPct: number | null; sense: OiSense }`
  - `interface StrikeAnalytics { strike: number; straddle: number | null; straddleBid: number | null; straddleAsk: number | null; strDecay: number | null; strDecayPct: number | null; cumOi: number; avgIv: number | null; pcrOi: number | null; pcrVol: number | null; painCr: number | null; gexOiCr: number; gexVolCr: number }`
  - `interface ChainAnalytics { forward: number; forwardSource: ForwardSource; T: number; atmStrike: number; atmIv: number | null; maxPain: number | null; pcrOi: number | null; pcrVol: number | null; cumOi: number; legs: Record<string, LegAnalytics>; strikes: StrikeAnalytics[] }`
  - `analyzeChain(input: ChainInput): ChainAnalytics`. Greeks for a leg with null IV use the strike's smile IV (§2.5). OI units = `oiUnit === 'lots' ? oi·lotSize : oi`. ATM is the strike nearest F, with ties going lower. ATM IV is the mean of valid CE and PE IV at ATM.

- [ ] **Step 1: Write failing tests:**
  - `sample-chain` at the fixture's σ: every leg's IV is within 1e-6 of the generating σ; forwardSource `'PARITY_MID'`; maxPain equals `maxPain()` run directly on the fixture OI.
  - `illiquid leg excluded from IV but counted in aggregates`: set one PE to bid 0 / ask 0 / volume 0 → its `ivStatus === 'NO_PRICE'`, `iv === null`; `cumOi` and `pcrOi` are unchanged from the liquid run.
  - `expired chain yields EXPIRED status, no NaN`: `nowMs` = 15:29:30 IST on expiry day → every leg status `'EXPIRED'`, all Greeks null, and no numeric field anywhere in the result is `NaN` or `±Infinity` (walk the object).
  - Performance: 150 strikes × 2 legs, cold start, runs in < 50 ms (`performance.now()`), and warm-started from the previous result's IVs in < 10 ms.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/libs/option-analytics/analyze.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `analyze.ts` and `config.ts`.
- [ ] **Step 4:** Run the whole library suite `npx ng test --watch=false --include=src/libs/option-analytics/**`, plus coverage with `--coverage`. Expected: PASS, line coverage ≥ 95 % for `src/libs/option-analytics`.
- [ ] **Step 5:** Commit: `feat(analytics): analyzeChain orchestrator`.

---

### Task 7: Kambala client types, feed transport, tick buffer

**Files:**
- Create: `src/app/features/option-chain/data-access/kambala/kambala.types.ts`, `kambala-rest.client.ts`, `src/app/features/option-chain/data-access/feed/transport.ts`, `mock-feed.transport.ts`, `noren-socket.service.ts`, `tick-buffer.ts`
- Test: `tick-buffer.spec.ts`, `noren-socket.service.spec.ts`, `kambala-rest.client.spec.ts` (same folders)

**Interfaces:**
- Produces:
  - Kambala wire types from `kambala-api-reference.md`: `TouchlineAck` (`t:'tk'`), `TouchlineFeed` (`t:'tf'`) with optional `lp, pc, v, o, h, l, c, oi, poi, bp1, sp1, bq1, sq1, ls, ti, ft`; `OptionChainRow { exch; tsym; token; optt; strprc; pp; ti; ls }`; `LinkedScripsResponse { opt_exp: { exd: string; exch: string; tsym: string }[] }`.
  - `KambalaRestClient` (injectable, `HttpClient`): `getLinkedScrips(exch: string, token: string): Promise<LinkedScripsResponse>`, `getOptionChain(exch: string, tsym: string, strprc: number, cnt: number): Promise<OptionChainRow[]>`, `searchScrip(text: string): Promise<{ exch: string; tsym: string; token: string; name: string }[]>`. Each POSTs form `jData=<json>&jKey=<token>` to `/NorenWClientTP/<Endpoint>` and throws `SessionExpiredError` when `emsg` contains "Session Expired". `// INTEGRATION:` session token and base URL come from the app's auth service.
  - `interface FeedTransport { connect(): Promise<void>; send(msg: object): void; messages: Observable<object>; status: Signal<'connecting' | 'open' | 'reconnecting' | 'closed' | 'session-expired'> }`, plus the `FEED_TRANSPORT` injection token.
  - `NorenSocketService implements FeedTransport`: sends `{t:'c', uid, actid, source:'WEB', susertoken}` on open. Reconnects with backoff 1, 2, 4… capped at 30 s, plus jitter ≤ 20 %. Resubscribes the current key set after reconnect. Sets `'session-expired'` (no retry) on `{t:'ck', s:'Not_Ok'}`. Ref-counted `subscribe(keys: string[])` / `unsubscribe(keys: string[])`, where keys look like `'NFO|12345'` and the `k` joins them with `'#'`.
  - `MockFeedTransport implements FeedTransport`: replays a generated session at a configurable tick rate (default 20 ticks/s), with partial `tf` messages.
  - `TickBuffer`: `push(msg: TouchlineAck | TouchlineFeed): void`, `drain(): Map<string, Partial<LegQuote> & { token: string }>` (merged per token since the last drain). `flushOnAnimationFrame(cb)` uses `requestAnimationFrame`.

- [ ] **Step 1: Write failing tests:**
  - `merges partial tf without clearing missing fields`: push `tk` with `lp 100, oi 5000, bp1 99.9`, then `tf {lp: 101}` → drained entry has `ltp 101, oi 5000, bid 99.9`.
  - Two `tf` for the same token before a drain collapse to one entry with the latest values.
  - Socket (fake WebSocket): on open it sends the connect message; `subscribe(['NFO|1','NFO|2'])` sends `{t:'t', k:'NFO|1#NFO|2'}`; subscribing `NFO|1` again sends nothing (ref-count); after a forced close the reconnect delays are 1000, 2000, 4000 ms (±20 %), then it re-sends `t` for both keys; `{t:'ck', s:'Not_Ok'}` → status `'session-expired'` and no reconnect.
  - REST (HttpTestingController): body is form-encoded `jData` and `jKey`; an `emsg: 'Session Expired : Invalid Session Key'` response rejects with `SessionExpiredError`.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/app/features/option-chain/data-access/**`. Expected: FAIL.
- [ ] **Step 3:** Implement the files.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(data-access): Kambala REST client, Noren socket, tick buffer, mock feed`.

---

### Task 8: Instruments service, store and feed facade

**Files:**
- Create: `data-access/models.ts`, `instruments.service.ts`, `option-chain.store.ts`, `chain-feed.facade.ts`
- Test: `instruments.service.spec.ts`, `chain-feed.facade.spec.ts`

**Interfaces:**
- Consumes: `KambalaRestClient`, `FeedTransport`, `TickBuffer` (Task 7); `LegQuote`, `StrikeQuotes`, `ChainAnalytics` (Tasks 3–6).
- Produces:
  - `interface Underlying { sym: string; exch: 'NSE' | 'BSE'; foExch: 'NFO' | 'BFO'; token: string; name: string; isIndex: boolean }`; `QUICK_UNDERLYINGS: Underlying[]` = NIFTY (`NSE|26000`) and SENSEX (BSE token per the existing TradeSmart mapping, `// INTEGRATION:`).
  - `interface Expiry { iso: string; exd: string; sampleTsym: string; foExch: string }`
  - `interface ChainMeta { underlying: Underlying; expiry: Expiry; strikes: { strike: number; ce: ContractRef | null; pe: ContractRef | null }[]; strikeStep: number }` with `ContractRef { token: string; tsym: string; lotSize: number; tickSize: number; pricePrecision: number }`
  - `InstrumentsService`: `loadExpiries(u: Underlying, nowMs: number): Promise<Expiry[]>` (sorted ascending, expired dropped using `isExpired`), `loadChain(u: Underlying, e: Expiry, spot: number, cnt: number): Promise<ChainMeta>`. `strikeStep` is the minimum positive difference between adjacent strikes.
  - `OptionChainStore` (signals): `underlying`, `expiries`, `selectedExpiry`, `meta`, `spot`, `spotOhlc: Signal<{ open; high; low; prevClose } | null>`, `quotes: Map<string, WritableSignal<LegQuote>>`, `analytics: Signal<ChainAnalytics | null>`, `feedStatus`, `loadState: Signal<'idle' | 'loading' | 'ready' | 'error'>`, `partialChain: Signal<boolean>`. Methods `applyTicks(map)`, `setAnalytics(a)`, `reset()`.
  - `ChainFeedFacade`: `select(u: Underlying, expiryIso?: string): Promise<void>` (loads expiries and chain, diffs subscriptions: unsubscribe old keys first, then subscribe new contracts plus the underlying), `selectExpiry(iso: string): Promise<void>`, `markStale(nowMs: number): string[]` (tokens with no tick for `staleAfterMs` during market hours). Every load carries an incrementing request id, and results with an older id are dropped.

- [ ] **Step 1: Write failing tests:**
  - `loadExpiries` with fixture `opt_exp` (unsorted, one already expired) returns ascending, unexpired expiries; `loadChain` pairs CE/PE by `strprc`, keeps `ls` per contract (SENSEX fixture: Nov expiry `ls 20`, Jan-2027 expiry `ls 25`), and computes `strikeStep` 50 for a NIFTY fixture.
  - `discards a stale chain load`: call `selectExpiry('2026-11-10')` then `selectExpiry('2026-11-17')` with the first REST response resolving last → `store.selectedExpiry().iso === '2026-11-17'` and `store.meta()` strikes are the 17-Nov fixture.
  - Switching expiry sends `u` for every old key before any `t` for new keys (assert on the mock transport's sent log).
  - `markStale` returns only tokens whose `lastTickMs` is older than 30000 ms.
  - Subscription limit (spec §3.3): when the mock transport rejects keys beyond 40 (`{t:'tk'}` acks stop and the transport reports `limitReached(40)`), the facade re-subscribes ±N strikes around ATM that fit (N = floor((40 − 1)/2/2)) and sets `store.partialChain()` to true.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/app/features/option-chain/data-access/**`. Expected: FAIL for the new specs.
- [ ] **Step 3:** Implement the files.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(data-access): instruments, signals store, feed facade`.

---

### Task 9: Analytics worker and bridge

**Files:**
- Create via `npx ng generate web-worker features/option-chain/analytics/analytics`: `analytics.worker.ts`; then `analytics/protocol.ts`, `analytics/analytics.bridge.ts`
- Test: `analytics/analytics.bridge.spec.ts`

**Interfaces:**
- Consumes: `analyzeChain`, `ChainInput`, `ChainAnalytics` (Task 6); `OptionChainStore` (Task 8).
- Produces:
  - `protocol.ts`: `type ToWorker = { v: 1; kind: 'analyze'; id: number; input: ChainInput }`; `type FromWorker = { v: 1; kind: 'result'; id: number; result: ChainAnalytics } | { v: 1; kind: 'error'; id: number; message: string }`.
  - `AnalyticsBridge`: `start(): void` / `stop(): void`. Every `recalcIntervalMs` it snapshots the store into a `ChainInput` (warm IVs from the last result) and posts it, but only if no request is in flight. On `result` it calls `store.setAnalytics`. On a worker `error` event it terminates and recreates the worker once; on a second failure it sets `analyticsUnavailable: Signal<boolean>` to true. Accepts a `WorkerFactory` injection token so tests can use an in-process fake.

- [ ] **Step 1: Write failing tests** (fake timers, fake worker):
  - Posts once per 1000 ms; with a request in flight for 2500 ms it posts no new message in between (skip, no queue).
  - A result updates `store.analytics()`.
  - The first crash recreates the worker and continues; the second crash sets `analyticsUnavailable()` to true and stops posting.
  - Market closed (store `feedStatus === 'closed'`): exactly one analysis runs.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/app/features/option-chain/analytics/**`. Expected: FAIL.
- [ ] **Step 3:** Implement. The worker body is `addEventListener('message', ({data}) => postMessage({v:1, kind:'result', id:data.id, result: analyzeChain(data.input)}))`, wrapped in try/catch to post `error`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(analytics): web worker and throttled bridge`.

---

### Task 10: Column registry, presets, view model, spot slot, CSV, preferences

**Files:**
- Create: `columns/column-registry.ts`, `columns/presets.ts`, `view/chain-view-model.ts`, `view/spot-slot.ts`, `export/csv-export.ts`, `data-access/prefs.store.ts`
- Test: `view/chain-view-model.spec.ts`, `view/spot-slot.spec.ts`, `export/csv-export.spec.ts`, `data-access/prefs.store.spec.ts`

**Interfaces:**
- Consumes: store signals (Task 8), `ChainAnalytics` (Task 6).
- Produces:
  - `interface ColumnDef { id: string; label: string; scope: 'side' | 'strike'; value(row: RowVM, side?: 'ce' | 'pe'): number | string | null; format(v: number | string | null): string; sum?: boolean; bar?: 'oi' | 'cumOi'; flash?: boolean; customisable: boolean }`. `COLUMNS: Record<string, ColumnDef>` covers every column in spec §5.2 (about 30 ids: `volume, oi, oiChg, oiChgPct, oiSense, bid, ask, ltp, chg, chgPct, open, high, low, iv, delta, gamma, theta, vega, itmProb, straddle, straddleBid, straddleAsk, strDecay, cumOi, avgIv, pcrOi, pcrVol, painCr, gexOiCr, gexVolCr`). Formatting follows the Global Constraints. Null renders as `'–'`.
  - `PRESETS: { id: 'default' | 'price' | 'greeks' | 'oi' | 'candle' | 'stats' | 'straddle' | 'custom'; label: string; mode: 'mirrored' | 'strike'; columns: string[] }[]`, with column lists exactly as spec §5.2.
  - `spotSlot(prevSlot: number | null, spot: number, strikes: number[], step: number, hysteresis: number): number`. Returns the strike the spot line sits directly below. It keeps `prevSlot` while `prevSlot − h ≤ spot ≤ next(prevSlot) + h` with `h = step·hysteresis`; otherwise it returns the largest strike ≤ spot (or the first strike if spot is below all).
  - `buildViewModel(args: { meta: ChainMeta; quotes: Map<string, LegQuote>; analytics: ChainAnalytics | null; spot: number; presetId: string; customColumns: string[]; strikeCount: number | 'all'; prevSlot: number | null; hysteresis: number }): ChainViewModel`, where `ChainViewModel { columns: ColumnDef[]; mode: 'mirrored' | 'strike'; rows: RowVM[]; spotSlot: number; sums: Record<string, number>; maxOi: { ce: number; pe: number; cum: number } }`. Visible rows are `strikeCount` strikes centred on ATM (fewer at the chain edge). `sums` and `maxOi` come from visible rows. Header aggregates come from `analytics`, not from this.
  - `toCsv(vm: ChainViewModel, header: { underlying: string; expiry: string; at: Date }): { filename: string; content: string }`. Filename `optionchain_<SYM>_<YYYYMMDD>_<HHMM>.csv`. First line `# <SYM> <expiry> <ISO time>`. Cells use the same `format` as the screen.
  - `PrefsStore`: `load(userId: string): Prefs`, `save(userId: string, p: Prefs): void`, where `Prefs { version: 1; preset: string; strikeCount: number | 'all'; customPresets: { id: string; name: string; mode: 'mirrored' | 'strike'; columns: string[] }[]; numberFormat: 'lakh' | 'intl' }`. Defaults: preset `'default'`, strikeCount 16, no custom presets, `'lakh'`. At most 5 custom presets. Key `ts.optionChain.prefs.v1:<userId>`.

- [ ] **Step 1: Write failing tests:**
  - `spotSlot holds within hysteresis band` (strikes 50 apart, h 0.1): prev 22850, spot 22847 → 22850; spot 22906 → 22900; spot 22844 → 22800; prev null, spot 22873.4 → 22850; spot below all strikes → first strike.
  - View model: strikeCount 4 on a 21-strike fixture returns 4 rows centred on ATM; `'all'` returns 21; the Greeks preset gives columns `[iv, theta, vega, gamma, delta]` in mirrored mode; the Statistics preset is strike mode; `sums.oi.ce` equals the hand-summed visible CE OI.
  - CSV: header line and filename for NIFTY, 2026-11-03, `new Date('2026-10-29T14:05:00+05:30')` → `optionchain_NIFTY_20261103_1405.csv`; a null IV cell is `–`.
  - Prefs: missing key → defaults; corrupt JSON → defaults; `version: 0` → defaults; `localStorage.getItem` throwing → defaults and `save` does not throw; a 6th custom preset is rejected.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/app/features/option-chain/{view,export,columns}/** --include=src/app/features/option-chain/data-access/prefs.store.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the files.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(view): column registry, presets, view model, spot slot, CSV, prefs`.

---

### Task 11: Chain table component

**Files:**
- Create: `ui/chain-table/chain-table.component.ts|html|scss`, `ui/chain-table/flash.directive.ts`, `src/styles/_tradesmart-tokens.scss` (light `:root` and `body[color-theme="dark"]` values from spec §5.3)
- Test: `ui/chain-table/chain-table.component.spec.ts`

**Interfaces:**
- Consumes: `ChainViewModel`, `ColumnDef` (Task 10).
- Produces: `<oc-chain-table>`, standalone, OnPush. Inputs: `vm: ChainViewModel`, `spot: number`, `checked: Set<string>`, `stale: Set<string>`, `loading: boolean`. Outputs: `trade: { token: string; tsym: string; side: 'BUY' | 'SELL'; ltp: number; lotSize: number }`, `toggleCheck: string`.
  - Mirrored mode: checkbox | CE columns (outer → inner) | Strike | PE columns (inner → outer) | checkbox. Strike mode: Strike | columns.
  - Spot line: `<tr class="spot">` inserted after the row whose strike equals `vm.spotSlot`. It contains a green price label centred on the strike cell. All cells are `position: sticky; top: var(--head-h); bottom: var(--foot-h)`, and the host sets those from `thead`/`tfoot` heights on each render.
  - ITM shading: CE when strike < spot, PE when strike > spot. OI bars: CE red, PE green, Cum OI blue, width = value / `vm.maxOi`.
  - Hover B/S on the outermost cell of each side. B uses `--ts-blue`, S uses `--ts-red`.
  - Σ row in `tfoot` for columns with `sum`.
  - `flash.directive` toggles `flash-up` / `flash-dn` classes on value change outside change detection, and does nothing under `prefers-reduced-motion`.
  - `@for (row of vm.rows; track row.strike)`.

- [ ] **Step 1: Write failing tests** (TestBed, fixture VM):
  - The Default preset renders headers `Volume OI Bid Ask LTP | Strike | LTP Ask Bid OI Volume`.
  - The spot row appears directly after the 22850 row when `spotSlot` is 22850, and its label text is the formatted spot.
  - The CE OI cell has class `bar ce`, and its background-size width equals `oi / maxOi.ce` as a percentage.
  - Clicking the CE `B` on 22900 emits `{side: 'BUY', token: <22900 CE token>, lotSize: 65}`.
  - A null IV renders `–`, with a `title` naming the reason from `ivStatus` (e.g. `NO_PRICE` → "No two-sided quote and no trades today"). A leg with `lowConfidence` renders its IV in italics with class `low-conf`. A token in `stale` gets class `stale`. `loading` renders placeholder rows with no numbers.
  - The Σ cell for CE OI equals `vm.sums` formatted.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/app/features/option-chain/ui/chain-table/**`. Expected: FAIL.
- [ ] **Step 3:** Implement. Copy the visual treatment from the prototype page (spec §5.1 and §5.3): `.tbl-wrap { overflow: auto }` owns scrolling, and `ion-content` has `scrollY=false`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ui): chain table with spot line, OI bars, hover trade`.

---

### Task 12: Page chrome components

**Files:**
- Create: `ui/underlying-bar/` (quick switch, search, OHLC), `ui/view-toolbar/` (preset chips, Edit columns, strike count, CSV), `ui/expiry-strip/` (expiry chips + header stats + feed dot + partial badge), `ui/column-chooser/` (CDK drag-drop), `ui/status-banner/`, `ui/footer-actions/`. Each folder has a component and a spec.

**Interfaces:**
- Consumes: `Underlying`, `Expiry` (Task 8); `PRESETS`, `COLUMNS` (Task 10); `dteLabel` (Task 4).
- Produces (all standalone, OnPush, inputs and outputs only):
  - `<oc-underlying-bar>`. In: `quick: Underlying[]`, `selected: Underlying`, `quickPrices: Record<string, { ltp: number; chgPct: number }>`, `ohlc`, `lotSize: number | null`, `searchResults: Underlying[]`. Out: `select: Underlying`, `search: string` (debounced 250 ms). Search listbox works with ArrowUp/ArrowDown/Enter/Escape and shows "No index or stock with options matches "<q>"".
  - `<oc-view-toolbar>`. In: `presetId`, `customEditorOpen: boolean`, `strikeCount`. Out: `presetChange`, `editColumns`, `strikeCountChange`, `exportCsv`. **Edit columns renders only when presetId is `'custom'` and the editor is closed.**
  - `<oc-expiry-strip>`. In: `expiries`, `selected`, `nowMs`, `stats: { atmIv; cumOi; maxPain; pcrOi; pcrVol; forward; forwardSource }`, `feedStatus`, `partial: boolean`. Out: `expiryChange`. Chip text is `dteLabel`, and the title is the date. The ATM IV stat's tooltip reads "Forward <F> (<source>)", where source is `PARITY_MID` → "from call/put prices", `FUTURES` → "from futures", `PARITY_LTP` → "from last traded prices", or `SPOT_CARRY` → "from spot".
  - `<oc-column-chooser>`. In: `columns: string[]`, `presets` (custom only). Out: `columnsChange`, `savePreset`, `renamePreset`, `deletePreset`, `done`.
  - `<oc-status-banner>`. In: `kind: 'reconnecting' | 'closed' | 'error' | 'analytics-unavailable' | null`. Out: `retry`. Copy: "Reconnecting to live prices… Showing the last values received." / "Market closed · Showing prices as of 15:30." / "Could not load the option chain for <SYM>. Check your connection and try again." / "Analytics unavailable. Prices are still live."
  - `<oc-footer-actions>`. In: `checkedCount`, `fwd`, `atm`, `expiryLabel`. Out: `addToWatchlist`, `addToBasket`.

- [ ] **Step 1: Write failing tests:**
  - The underlying bar renders exactly two quick buttons, NIFTY and SENSEX. Typing "rel" emits `search('rel')` once after 250 ms. Enter selects the first result. The OHLC line shows `Lot 20 (this expiry)` when lotSize is 20.
  - The toolbar has no Edit columns button for the `'greeks'` preset; it has one for `'custom'` with the editor closed, and none with the editor open.
  - Expiry strip chips for now = 2026-10-29T10:00 IST read `5d` for 2026-11-03; the partial badge is shown only when `partial` is true.
  - The column chooser rejects saving a 6th custom preset with "You can save up to 5 custom views."
  - Each banner kind renders its exact copy, and `error` shows a Retry button that emits `retry`.
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/app/features/option-chain/ui/**`. Expected: FAIL for the new specs.
- [ ] **Step 3:** Implement the components.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(ui): underlying bar, toolbar, expiry strip, column chooser, banners`.

---

### Task 13: Feature shell, route, new-tab launch, e2e and performance

**Files:**
- Create: `feature-shell/option-chain-page.component.ts|html|scss`, `feature-shell/option-chain.routes.ts`, `feature-shell/open-option-chain.ts`, `src/app/features/option-chain/index.ts`
- Modify: `src/app/app.routes.ts` (lazy `/option-chain`), `src/app/app.config.ts` (`provideZonelessChangeDetection()`, `provideHttpClient()`, `FEED_TRANSPORT` → `MockFeedTransport` when `?feed=mock`, else `NorenSocketService`)
- Test: `feature-shell/option-chain-page.component.spec.ts`, `e2e/option-chain.spec.ts`, `e2e/perf.spec.ts`, `playwright.config.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - Route `/option-chain?underlying=<EXCH>:<SYM>[&expiry=<iso>]`. An invalid or missing value falls back to `NSE:NIFTY`. Changing underlying or expiry updates the URL with `history.replaceState`.
  - `openOptionChain(u: { exch: string; sym: string }, expiryIso?: string): void` → `window.open('/option-chain?underlying=…', '_blank', 'noopener')`. `// INTEGRATION:` call this from the chart page Option Chain button, the watchlist and the scrip menu.
  - The page wires the store, facade, bridge and prefs. `trade` → `// INTEGRATION: OrderWindowService.open({token, tsym, side, price: ltp, lotSize})`; footer actions → `// INTEGRATION: BasketService / WatchlistService`. `feedStatus 'session-expired'` → `// INTEGRATION: AuthService.relogin()`. On load or switch it scrolls `.tbl-wrap` so the spot line sits mid-box.

- [ ] **Step 1: Write failing tests:**
  - Component (mock transport): `?underlying=BSE:SENSEX` loads SENSEX; `?underlying=XYZ` loads NIFTY; selecting the Jan-2027 SENSEX expiry shows `Lot 25`.
  - e2e (`npx playwright test`, dev server with `?feed=mock`): page loads with 16 rows and a spot line; click Greeks → header `IV`; choose Custom → editor visible; choose Price → editor gone; untick `OI` in Custom, reload → still unticked; switch expiry → URL has `expiry=`; type "SBI" in search, press Enter → underlying bar shows SBIN; simulate a socket drop (mock control `window.__mockFeed.drop()`) → reconnect banner, then it clears.
  - Spot line: with strikes `'all'`, scroll `.tbl-wrap` to the top → the spot label stays visible within the table box's bottom 60 px. For 10 s of mock ticks around a fixed spot 22873 ± 3, the spot row's preceding strike stays 22850.
  - Perf (`e2e/perf.spec.ts`): strikes `'all'` with 200 contracts at 20 ticks/s for 10 s → Chrome trace main-thread frames ≥ 50 fps (no frame > 20 ms more than 5 % of the time), and the bridge's measured worker round-trip < 50 ms (exposed on `window.__ocMetrics`).
- [ ] **Step 2:** Run `npx ng test --watch=false --include=src/app/features/option-chain/feature-shell/**` and `npx playwright test`. Expected: FAIL.
- [ ] **Step 3:** Implement the shell, route, config and `openOptionChain`.
- [ ] **Step 4:** Run `npx ng test --watch=false` (full suite), `npx playwright test` and `npx ng build`. Expected: all PASS, and the build succeeds with no warnings about CommonJS or budgets.
- [ ] **Step 5:** Commit: `feat(option-chain): page shell, route, new-tab launcher, e2e and perf tests`.

---

### Task 14: Standalone prototype and hand-off README

**Files:**
- Create: `Option chain MVP/prototype/option-chain-prototype.html` (the mockup section of `docs/design/option-chain-core-design.html` as a full-screen standalone page with its scripts and TradeSmart tokens, without the spec sections)
- Create: `Option chain MVP/reference-code/README.md`

**Interfaces:**
- Consumes: the design page (visual source of truth) and Tasks 1–13.
- Produces: a hand-off package for the TradeSmart tech team.

- [ ] **Step 1:** Build the prototype file. The demo-state switch is kept in a small floating "Demo" menu, and the browser-window frame is removed (the prototype *is* the new tab).
- [ ] **Step 2:** Verify by opening it in Chrome through a local static server (`npx -y http-server prototype -p 8766`). Check that all 8 views, the expiry and strike controls, Custom-only editor, search, NIFTY/SENSEX quick switch, spot line behaviour and hover B/S work, and that the console shows no errors.
- [ ] **Step 3:** Write the README with these sections: *What this is* (reference, not production); *Run it* (`npm ci`, `npx ng serve` → `/option-chain?underlying=NSE:NIFTY&feed=mock`, `npx ng test`, `npx playwright test`); *Folder map* (from `angular-architecture.md` §7); *Integration points* (a table of every `// INTEGRATION:` comment with file and line, from `grep -rn "INTEGRATION:" src`); *Open questions* (copied from spec §9); *Config* (`OptionChainConfig` defaults).
- [ ] **Step 4:** Run `grep -rn "INTEGRATION:" reference-code/src | wc -l` and confirm the README table has the same number of rows.
- [ ] **Step 5:** Commit: `docs: standalone prototype and tech-team README`.
