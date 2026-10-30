# Option Chain Core — decisions made during the build

Every ruling the build controller made on your behalf while executing the plan (in order), each with what it costs if wrong. Source: the build ledger. Code is uncommitted by request.

- Ruling: no commits by implementers or controller; every plan "Commit" step becomes "leave changes uncommitted in the working tree". Per-task diffs use tree snapshots (`snap.sh tree` → `git write-tree`) and `snap.sh package BASE HEAD N` — user's instruction — cost if wrong: none; history is created by the user later.
- Ruling: plan Task 1 Step 1 `git init` already done by controller; implementer skips it — avoids re-init — cost if wrong: none.
- Pre-flight (T4 → T6,T8,T12 ): InstrumentsService parses `exd` "DD-MMM-YYYY" (e.g. "03-NOV-2026") to ISO; fixtures use that form — cost if wrong: one parser change when real format seen 
- Pre-flight (T7 → T8 ): T8 adds `limitReached: Signal<number \| null>` to `FeedTransport` and `subscriptionLimit?: number` option to `MockFeedTransport` (NorenSocket sets it from ack failures) — cost if wrong: small interface change 
- Pre-flight (T8 → T9,T10,T13 ): callers pass a plain snapshot map read from the signals; store keeps signals — cost if wrong: none (adapter in shell) 
- Pre-flight (T10 → T11 ): `RowVM { strike: number; ce: LegVM \| null; pe: LegVM \| null; s: StrikeAnalytics \| null }`, `LegVM { ref: ContractRef; quote: LegQuote \| null; a: LegAnalytics \| null }` — cost if wrong: rename in T11 
- Pre-flight (T12 ↔ T7 ): shell (T13) maps searchScrip rows to `Underlying` — cost if wrong: none 
- Pre-flight (T1 ): if the flag is absent, zoneless is the v22 default; verify no `zone.js` in polyfills — cost if wrong: none 
- Pre-flight (T6 ): T6 installs it as devDependency — cost if wrong: none 
- Task 4: Ruling: PARITY_LTP assertion switched from abs 1e-6 to relative 1e-8 at controller's request — matches plan's global tolerance; looser than before by ~250x — cost if wrong: an LTP-parity error between 4e-11 and 1e-8 relative would go unnoticed (immaterial for ₹ prices)
- Task 6: Ruling: integration decisions given to implementer (expired path keeps OI aggregates, greeks via own IV else smile IV, units rule, volume uses same unit rule as OI, cumOi in raw OI units, painCr uses unitsPerOi = lotSize if oiUnit 'lots' else 1) — from spec §4 + formulas §2.5/§6/§11 — cost if wrong: unit scaling of pain/GEX off by lot size (visible in QA vs GoCharting)
- Task 6: Ruling: library test include form is --include='src/libs/option-analytics/**/*.spec.ts' (plan's ** form picks up non-spec files) — cost if wrong: none
- Task 6: Ruling: empty strikes → atmStrike 0 means "none"; T10 view model must treat an empty chain as no rows/no spot slot rather than type-changing atmStrike — cost if wrong: one guard in T10
- Task 7: Ruling: LegQuote.token / store keys / subscription keys are the feed key "EXCH|token" (e.g. "NFO|43651") — Kambala tokens are only unique per exchange — cost if wrong: key format change in T7/T8
- Task 7: Ruling: FeedTransport interface also carries subscribe(keys)/unsubscribe(keys) (facade needs them on any transport) — cost if wrong: none
- Task 7: Ruling: Kambala feed values arrive as strings; TickBuffer parses to numbers and maps lp→ltp, bp1→bid, sp1→ask, bq1→bidQty, sq1→askQty, v→volume, oi, poi→prevOi, c→prevClose, o/h/l, ls→lotSize, ti→tickSize, lastTickMs from injected clock — cost if wrong: field mapping fix
- Task 7: Ruling: MockFeedTransport is generic (seed fn per key + tick rate + rng); the NIFTY market generator is built in T13 — cost if wrong: none
- Task 7: Ruling: searchScrip "No Data" → [] (overrides decision 5 for that case) so the search box shows "no match" instead of an error — cost if wrong: none
- Task 7: Ruling: fold minors close()-rejects-pending and mock re-ack-from-state into fix round 1 (cheap, used by T8/T13 demo) — cost if wrong: none
- Task 8: Ruling: store.quotes is Signal<ReadonlyMap<string, WritableSignal<LegQuote>>> replaced per chain load (brief's plain Map can't change per expiry) — cost if wrong: small type change in T9/T13
- Task 8: Ruling: getOptionChain strprc = Math.round(spot); facade subscribes the underlying first and waits for the first spot tick (timeout 5000 ms → loadState 'error') — Kambala needs a mid price — cost if wrong: slower first load
- Task 8: Ruling: SENSEX quick underlying uses BSE token '1' with // INTEGRATION (undocumented in vendor doc) — cost if wrong: team swaps token
- Task 8: Ruling: subscription-limit fallback via FeedTransport.limitReached: Signal<number|null>; N = max(0, floor(((limit−1)/2 − 1)/2)) strikes each side of ATM (40 → 9 → 39 keys); NorenSocket leaves it null (INTEGRATION) — cost if wrong: formula tweak
- Task 8: Ruling: REST loads retried 2× (not SessionExpiredError) then loadState 'error'; REST SessionExpiredError sets store.sessionExpired — spec §6 — cost if wrong: none
- Task 8: Ruling: markStale(nowMs) ignores market hours (shell decides when to call) — cost if wrong: none
- Task 8: Ruling: concern 4 (unsubscribe after winning load, before subscribe) accepted — keeps current chain live if new load fails/superseded; meets "unsubscribe before subscribe" — cost if wrong: brief extra ticks for old chain, dropped as unknown keys
- Task 8: Ruling: perf test asserts on MIN of 7 runs with original 50/10 ms budgets — removes scheduler/GC noise without loosening the budget — cost if wrong: none
- Task 8: Ruling: WS-side session-expired also sets store.sessionExpired (single signal for shell) — cost if wrong: none
- Task 9: Ruling: futuresPrice = null in v1 (no futures subscription; forward falls back parity→LTP→spot) — spec §3.2 lists futures as optional — cost if wrong: weaker forward when parity fails (rare intraday)
- Task 9: Ruling: bridge exposes lastRoundTripMs signal (needed by T13 perf metric) — cost if wrong: none
- Task 9: Ruling: chain/expiry change while feed 'closed' must re-run one analysis — T13 shell resets the bridge's closed-analysed flag on chain change (add bridge.requestAnalysis() there) — cost if wrong: stale Greeks after switching expiry when market is closed
- Task 10: Ruling: sums: Record<colId, {ce:number; pe:number; total:number}> (plan's sums.oi.ce implies per-side) — cost if wrong: rename in T11
- Task 10: Ruling: ChainViewModel.spotSlot: number | null (null for empty chain, per T6 atmStrike-0 ruling) — cost if wrong: none
- Task 10: Ruling: Default preset uses column id 'ltpChg' (LTP value with chgPct sub-line via ColumnDef.sub), not customisable; 'ltp' is plain — cost if wrong: none
- Task 10: Ruling: formats — IV ×100 2dp; itmProb ×100 1dp + '%'; OI/vol/oiChg ÷1e5 2dp (oiChg signed); prices ref.pricePrecision (default 2); chg/chgPct/strDecay signed 2dp; pcr 2dp; painCr 0dp; GEX Cr signed 1dp; delta/gamma 4dp; theta/vega 2dp; oiSense labels 'Long Build Up'… '—' for NEUTRAL; null → '–' — spec §5.3 — cost if wrong: display tweak
- Task 10: Ruling: mirrored custom chooser (T12) offers only side-scope columns — avoids strike values duplicated on both sides — cost if wrong: none
- Task 11: Ruling: B/S hover buttons hidden when the leg's ltp is null (trade payload needs a price) — cost if wrong: none
- Task 11: Ruling: IV "–" tooltip copy per ivStatus: NO_PRICE "No two-sided quote and no trades today"; BELOW_INTRINSIC "Price is below intrinsic value"; ABOVE_MAX "Price is above the theoretical maximum"; BELOW_MIN_VOL "Price is too low to imply a volatility"; ABOVE_MAX_VOL "Price is too high to imply a volatility"; EXPIRED "Contract has expired"; NO_CONVERGENCE "Could not solve implied volatility" — cost if wrong: copy tweak
- Task 11: Ruling: light --ts-muted should be #777777 (TradeSmart's own --777ccc light value) not #949494, for text contrast on white; --ts-strike keeps TradeSmart --strikebg #dddddd — cost if wrong: one token change; carry into T12 dispatch if not fixed in T11 loop
- Task 11: Ruling: light --ts-fg stays #000000 (TradeSmart --text-color) though mockup used #1a1a1a — cost if wrong: one token
- Task 12: Ruling: warn styling uses new tokens --ts-warn-soft = TradeSmart --alert-bg (light #fff6e6, dark #6d3d02) and --ts-warn (#a15c00 light / #f2b45a dark, as mockup) — TradeSmart already has an alert background — cost if wrong: token values
- Task 12: Ruling: <oc-underlying-bar> gets input resultsFor: string|null (query the results belong to); options + no-match shown only when resultsFor === current text — T13 shell must set it — cost if wrong: none
- Task 13: Ruling: split into 13a (mock market + REST mock + shell page + route + config + openOptionChain + component spec) and 13b (Playwright e2e + perf) — task too large for one review surface — cost if wrong: one extra review
- Task 13: Ruling: search rows → Underlying with foExch NSE→NFO, BSE→BFO, isIndex true only for known index tokens; F&O filtering is // INTEGRATION (Kambala Q8) — cost if wrong: non-F&O stocks may appear in search until integrated
- Task 13: Ruling: banner kind: loadState 'error' or sessionExpired → 'error'; feedStatus 'reconnecting' → 'reconnecting'; feedStatus 'closed' → 'closed'; bridge.analyticsUnavailable → 'analytics-unavailable'; else null — cost if wrong: copy priority tweak
- Task 13: Ruling: prefs userId from // INTEGRATION token, default 'demo' — cost if wrong: none
- Task 13a: Ruling: ?feed=mock honoured only when isDevMode() — a trading page must not show fabricated prices via a shareable URL — cost if wrong: demo needs a dev build (ng serve), which the README documents
- Task 13a: Ruling: visible strike window centres on the hysteresis spot slot, not forward ATM (amends spec §3.2 step 7) — user's explicit requirement that the spot line sits mid-chain; ATM shown only in header/footer — cost if wrong: on far expiries ATM row may be off-window (ATM is a header stat anyway)
- Task 13a: Ruling: facade keeps both QUICK underlying keys subscribed for page lifetime; store.quickPrices — D18 requires live prices on both buttons — cost if wrong: 2 extra subscriptions
- Task 13a: Ruling: Prefs.custom (working custom view) accepted; spec §5.4 amended; expiry URL param is ISO YYYY-MM-DD (D17 text amended) — cost if wrong: none
- Task 13b: Ruling: e2e targets dev server (ng serve) since mock is dev-only; chromium only; perf asserted via in-page rAF frame sampling + __ocMetrics — cost if wrong: none
- Task 13: Ruling: perf fix as fix round 1 for Task 13, fresh opus implementer (app code outside 13b test scope): (1) TickBuffer flush throttled to ~250 ms (spec §3 "flush on rAF ≈ 4/s" — current code flushes every rAF); (2) add a 'perf' build configuration = production optimisation + allow-mock flag via fileReplacements, used only by the Playwright perf project (mock stays off in the normal production build); (3) profile and fix remaining hot spots — perf budget is a spec success criterion — cost if wrong: perf test measures a build config that differs from prod only by the mock flag
- Task 13: Ruling: accept solid flash tint (fade broke the 50 fps budget — measured), hold shortened 700→400 ms so continuously ticking cells don't stay tinted — deviates from approved mockup's fade — cost if wrong: visual tweak the user may want reverted
- Task 13: Ruling: accept tint "held ≥400 ms, cleared on next tick flush" (~500 ms) instead of an independent 400 ms timer — per-cell timers caused extra whole-table repaints that broke the budget (measured) — cost if wrong: tint lasts ~100 ms longer than ruled
- FINAL: Ruling: market session = IST F&O hours 09:15–15:30 Mon–Fri via injectable MARKET_SESSION service with // INTEGRATION exchange-holiday calendar; drives banner, one-pass analytics, stale gating — cost if wrong: holidays show as open until calendar integrated
- FINAL: Ruling: OI/volume normalised to quantity at ingestion (store) when oiUnit 'lots'; analyze drops units() — single source of units — cost if wrong: none
- FINAL: Ruling: lowConfidence also when T < 3600 s (keep 60 s EXPIRED floor); spec §4 config amended to minTimeToExpirySec 60 + lowConfidenceBelowSec 3600 — cost if wrong: none
- FINAL: Ruling: implement pp decimals, OI/volume exact tooltip, GEX sign tooltip, "(subscribed strikes)" suffix; K/M/B 'intl' number format NOT implemented → README Known limitation (numberFormat pref kept for forward compat) — cost if wrong: one formatter feature later
- FINAL: Ruling: TradeEvent gains exch + raw token (feed key kept as key) — cost if wrong: none
- FINAL: Ruling: perf wall-clock tests opt-in via PERF=1 (Playwright perf project + analyze timing test); default runs are deterministic — cost if wrong: perf regressions caught only when PERF=1 is run
- FINAL: Ruling: mock mode treats market as always open (demo/e2e usable after hours); real hours tested via overrides — cost if wrong: none (dev/perf builds only)
- FINAL: Ruling: accept expired-expiry removal at 15:29 (60 s floor) and partial-chain suffix as tooltips — cost if wrong: copy/visibility tweak

## Open residual items after final review

- re-review: all 17 ADDRESSED; 1 new Important residual: after hours the single analysis can run on default (empty) quotes before acks arrive and isn't re-run while closed (real feed only; mock is always-open) — surfaced to user (no second fix wave)
- residual minors: watchdog can count spurious crash after >5 s main-thread stall/suspend and failures never reset; pruneExpired→selectExpiry can be skipped during in-progress select; signClass colours -0.001 red while text reads 0.00; InstrumentsService/hysteresis read DEFAULT_CONFIG not injected config; pending rAF flush stalls in hidden tab while stale timer can dim chain

## Resolved after hand-off

- After-hours analytics on empty quotes: FIXED 29 Oct 2026. Ruling: closed-market analysis is gated on a store data version (re-analyse only when the chain's data changed) instead of a one-shot — cost if wrong: an extra analysis per late ack burst after hours. Tests reproduce the bug on the old code.
