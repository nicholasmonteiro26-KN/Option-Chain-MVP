# Option Chain Analytics — Calculation Reference

**Scope:** Formulas and algorithms for the enhanced TradeSmart Option Chain (NSE/BSE index and stock options). Everything below is computed in the browser by a TypeScript library running in a Web Worker, recalculated about once per second for up to ~150 contracts.
**Feed inputs per contract (Kambala/Noren):** LTP, % change, volume, OI, previous-day OI, OHLC / previous close, best bid/ask price and quantity, lot size, strike, option type, expiry. The feed does **not** provide IV, Greeks or an underlying forward.
**Target parity:** GoCharting options desk columns (IV, Greeks, ATM IV, cumulative OI, Max Pain, PCR, OI change, OI Sense, ITM probability, straddle, Str Decay, Avg IV, GEX-OI / GEX-Volume, DTE strip).
**Status:** Research draft, 2026-10-29. Every number in §15 was computed with a reference Python script (standard library only, `math.erf` for the normal CDF).

---

## 0. Summary of recommendations

| Topic | Recommendation |
|---|---|
| Pricing model | **Black-76 on the forward of the option's own expiry.** Report spot-equivalent delta and gamma (§5). This is mathematically identical to Black-Scholes-Merton with an implied carry, so no separate dividend or carry input is needed. |
| Underlying / forward | **Synthetic forward from put-call parity** at near-ATM strikes, using mid prices (§1.3). Fallback 1: same-expiry futures. Fallback 2: `S·e^{(r−q)T}`. |
| Price used for IV | **Mid price** when a sane two-sided quote exists. Otherwise fall back to LTP, but only if the contract traded today. Otherwise show no IV (§2.5). |
| Risk-free rate | Configurable. Default **5.75%**, close to the current 91-day T-bill (§4). With a parity forward, `r` only discounts, so IV changes very little with `r`. |
| Time | Calendar time, ACT/365, to the **second**, up to expiry at **15:30 IST**. Theta is per **calendar day**. DTE label = calendar-date difference (§3). |
| IV solver | Safeguarded Newton-Raphson with bisection fallback, σ ∈ [0.001, 5.0], warm start from the previous tick (§2). |
| ITM probability | **N(d2)** (risk-neutral probability of finishing ITM), not N(d1) (§9). |
| GEX | `Γ_spot · OI_units · S² · 0.01`, calls +, puts −, shown in ₹ crore per 1% move (§11). |

---

## 1. Pricing model: Black-Scholes vs Black-76

### 1.1 Facts that drive the choice
- NSE/BSE **index options are European and cash-settled**, so a closed-form European model is correct.
- **Stock options are also European**. They have been physically settled since 2018–19, which does not change the pricing model, but early-exercise models are not needed.
- Black-Scholes on spot with dividend yield `q` equals Black-76 on the forward `F = S·e^{(r−q)T}`. The two models differ only in **where the forward comes from**.
- NSE's own option chain computes IV with **Black-Scholes on the underlying value with a fixed 10% interest rate**, based on LTP ([NSE option chain page note](https://www.nseindia.com/option-chain); confirmed by [TradingQnA](https://tradingqna.com/t/using-black-scholes-calculator/13775/4)). A 10% rate is far above Indian money-market rates, so NSE's forward is systematically too high. This shows up as call IV > put IV at the same strike. See the critique at [unofficed](https://unofficed.com/?p=14245) and the discussion of rate/parity mismatch at [moontowermeta](https://moontowermeta.com/implying-the-cost-of-carry-in-options/): "if you impose the rate and the call IV > put IV, the market's implied rate is lower than your assumption".
- Sensibull reportedly uses a **"modified Black-76" on the futures price** with 252 trading days, as reported by a user on the [Kite forum](https://kite.trade/forum/discussion/15581/iv-calculation-methodology-query). This is a second-hand report, not official documentation. The case for futures or forwards over spot is laid out at [Quantra](https://quantra.quantinsti.com/community/t/why-do-we-use-futures-price-to-determine-implied-volatility/24437): "futures price already considers the interest rate factor". Retail users notice that IV differs across platforms ([Upstox community](https://community.upstox.com/t/differences-in-implied-volatility-values-across-websites/7606)), so we must document our convention in the UI tooltip.

### 1.2 Recommendation: Black-76 on a synthetic forward
Use **Black-76** per expiry with forward `F`:

```
d1 = [ln(F/K) + σ²T/2] / (σ√T)        d2 = d1 − σ√T        D = e^{−rT}
Call  C = D·[F·N(d1) − K·N(d2)]
Put   P = D·[K·N(−d2) − F·N(−d1)]
```

Reasons:
1. **No dividend input needed.** Index dividend yields and stock dividends are already in the market forward.
2. **Weekly expiries have no futures.** Only monthly index futures exist. NIFTY weeklies expire on **Tuesday** and SENSEX weeklies on **Thursday** since 1 Sep 2025 ([Business Standard](https://www.business-standard.com/markets/news/nse-bids-adieu-to-thursday-expiry-as-dates-swap-come-into-effect-explained-125082800635_1.html)). The parity forward exists for **every** expiry.
3. **Consistent IVs.** With a parity forward, CE IV ≈ PE IV at the same strike. This removes the artificial call/put IV gap that spot + fixed rate produces. See vector V7/V8 in §15: with F = 25000, a 160/140 ATM pair gives 13.41% vs 11.74% IV. With the parity forward it gives 12.553% for both.
4. **`r` hardly matters.** With F taken from the market, `r` only enters through the discount factor. Moving `r` from 6% to 10% at 5 DTE changes `D` by 0.06%, a negligible IV change. With spot + `r`, the same change shifts F by `S·Δr·T` ≈ 14 points on NIFTY, which visibly skews IVs.

### 1.3 Forward estimation algorithm (per expiry, every recalculation)
Inputs: spot `S` (index LTP), `r`, `T`, chain quotes.

1. Let `K0` be the listed strike nearest to the previous tick's F. On the first tick, use the strike nearest to `S`.
2. Candidate strikes: `K0` and the **3 strikes on either side** (7 total, configurable).
3. For each candidate where **both** CE and PE have a valid mid (§2.5 quote filter), compute
   `F_K = K + e^{rT}·(C_mid − P_mid)`.
4. `F = median(F_K)`. Optionally weight by `1/(spread_CE + spread_PE)`. The median is simpler and robust to a single bad quote.
5. Sanity check: reject F if `|F/S − 1| > 3%`, or if fewer than one valid pair exists.
6. Fallbacks, in order:
   - same-expiry futures mid (or LTP);
   - parity using **LTPs** of traded pairs (for after-hours or when bid/ask are blank);
   - `S·e^{(r−q)T}`, with `q` configurable (default 0).
7. Expose `forwardSource ∈ {PARITY_MID, FUTURES, PARITY_LTP, SPOT_CARRY}` to the UI so users can see how the forward was obtained.

Stock options: the same algorithm applies. Every stock-option expiry also has a same-expiry stock future, which is a good fallback.

---

## 2. Implied volatility solver

### 2.1 Target
Solve `B76(σ; F, K, T, r, type) = P_mkt` for σ. Work in **undiscounted** terms: `P' = P_mkt·e^{rT}`, then price with `r = 0`.

### 2.2 Arbitrage bounds (check before solving)

| Type | Lower bound (intrinsic, undiscounted) | Upper bound |
|---|---|---|
| Call | `max(F − K, 0)` | `F` |
| Put | `max(K − F, 0)` | `K` |

- If `P' ≤ intrinsic + ε` (ε = 1e-9): status `BELOW_INTRINSIC`, IV = null. This is common for deep-ITM options trading at a discount, or for stale LTPs.
- If `P' ≥ upper`: status `ABOVE_MAX`, IV = null.
- If `P' < price(σ_min)`: status `BELOW_MIN_VOL`, IV = null. Without this check the solver silently returns σ_min (see §15, V12).
- If `P' > price(σ_max)`: status `ABOVE_MAX_VOL`, IV = null.

### 2.3 Algorithm (safeguarded Newton)
```
bounds:     σ_lo = 0.001 (0.1%), σ_hi = 5.0 (500%)
tolerance:  |price(σ) − P'| < 1e-8 · max(1, P')   OR   |Δσ| < 1e-10
max iter:   100 total. Newton typically converges in 2–8 steps; bisection only kicks in on bad steps.
initial σ0:
  if warm-start IV from previous tick exists and is in bounds → use it   (usually 1–2 iterations)
  elif |ln(F/K)| < 0.02 → Brenner–Subrahmanyam: σ0 = √(2π/T) · P'/F
  else                  → Manaster–Koehler:     σ0 = √(2·|ln(F/K)| / T)
  clamp σ0 to [0.05, 3.0]
loop:
  diff = price(σ) − P'
  if converged → return σ
  if diff > 0: hi = σ else lo = σ           (price is monotone increasing in σ)
  vega = F·n(d1)·√T                          (undiscounted)
  σ_new = σ − diff/vega
  if vega < 1e-12 or σ_new ∉ (lo, hi): σ_new = (lo + hi)/2   (bisection fallback)
```
Sources for the initial guesses:
- Brenner–Subrahmanyam ATM approximation `σ ≈ √(2π/T)·C/S`: [MetricGate](https://metricgate.com/docs/implied-volatility-newton/), [SpotGamma](https://support.spotgamma.com/hc/en-us/articles/15246449280787-Brenner-and-Subrahmanyam-Approximation). It is only accurate near ATM-forward ([Erasmus working paper](https://repub.eur.nl/pub/1472/ERS%202004%20054%20FA.pdf)), which is why it is used only when `|ln(F/K)| < 0.02`.
- Newton with bisection fallback: [QuantVault](https://quantvault.org/problem-2146-implied-volatility-via-newton-bisection.html).

### 2.4 Normal CDF in TypeScript
JS has no `Math.erf`. Implement a double-precision `Φ`, for example W. J. Cody's rational erfc approximation or Hart/West's double-precision algorithm, both accurate to ~1e-15.
**Do not** use Abramowitz & Stegun 26.2.17 (error ≈ 7.5e-8). It is too coarse for deep-OTM IV and for the golden-vector tolerances in §15.

### 2.5 Which price to feed the solver (recommendation)
For each contract, choose the price in this order:
1. **Mid** = (bid + ask)/2, if the quote is valid:
   - `bid > 0`, `ask > 0`, `ask ≥ bid`, both quantities > 0, and
   - spread ≤ `max(5 ticks, 10% of mid)`, i.e. ≤ max(₹0.25, 0.10·mid) at a ₹0.05 tick.
2. **LTP**, if `volume > 0` today. If LTP lies outside [bid, ask] and a valid quote exists, the mid is used instead (it has already won at step 1).
3. Otherwise **no IV**: status `NO_PRICE`. A contract with zero volume shows a previous-close-like LTP, which would give misleading IVs.

Why mid rather than LTP: the LTP of illiquid strikes can be minutes old while F has moved. That creates spurious smiles and breaks call/put IV consistency. NSE and probably GoCharting use LTP, so we also offer an **"IV source: Mid / LTP" setting** (see the product decisions in §16).

Additional rules:
- **Tick quantization.** Deep-OTM premiums at ₹0.05–0.10 make IV extremely sensitive to one tick: at 5 DTE a 26500 CE gives 14.60% IV at ₹0.05 and 15.38% at ₹0.10 (V12). Mark IV as low-confidence (greyed) when the price is < ₹0.50 or < 4 ticks.
- **Deep ITM.** The ITM leg has little time value, so its IV is noisy or fails `BELOW_INTRINSIC`. With a parity forward, IV(ITM call, K) ≈ IV(OTM put, K). Define a per-strike **"smile IV"**:
  - OTM leg's IV (call if K > F, put if K < F);
  - the average of both legs within ±0.5 strike-step of F.
  
  Use the smile IV for Greeks, GEX and ITM probability whenever a leg's own IV is null. Display each leg's own IV in the CE IV and PE IV columns.

### 2.6 Performance
- Measured: the reference CPython implementation solves 62 IVs (31 strikes × CE/PE, 5 DTE) in **0.9 ms**, average 5.6 iterations, no failures.
- Expected: V8/JIT JavaScript is typically several times faster. 300 solves (150 contracts, both legs counted generously) should take **well under 1–2 ms** per recalculation. With warm starts, most solves take 1–2 iterations.
- Practical cost is dominated by `postMessage` serialization. Pass results as a `Float64Array` (transferable) or a compact struct-of-arrays, not as objects per contract.

---

## 3. Time to expiry

### 3.1 Convention (recommended)
```
expiryInstant = expiryDate 15:30:00 IST (UTC+05:30)
T_years = max(0, expiryInstant − now) in seconds / (365 × 86400)
```
- **Calendar time, ACT/365, continuous to the second.** Premium therefore decays intraday every recalculation, and theta per calendar day is consistent with T.
- Holidays and weekends are counted as calendar time. As a result IV on a Friday afternoon reads slightly lower than the same price would imply on a trading-day clock, and weekend decay appears in Friday's theta.
- Alternative: a trading-day basis (252 days, with trading minutes only), reportedly used by Sensibull (forum report above). It requires an NSE/BSE holiday calendar and session minutes. This is listed as a product decision; calendar time is simpler and matches most international tooling.
- **Floor:** if `T < 60 s` (1 minute), or after 15:30 on expiry day, set IV and Greeks to null with status `EXPIRED`. On expiry day itself, keep computing until 15:30. Gamma and theta grow very large in the last hour, so the UI should format them adaptively.

### 3.2 DTE label ("5d")
`DTE = (expiry calendar date in IST) − (today's calendar date in IST)`, as an integer number of days.

| Situation | Label |
|---|---|
| Expiry later than today | `"{DTE}d"` |
| Expiry day | `"0d"`. Optionally show hours remaining, e.g. `"4h"`, from `ceil((expiryInstant − now)/3600 s)`. |

Example (V6): now = Thu 2026-10-29 10:00 IST, expiry = Tue 2026-11-03 15:30 IST.
- Elapsed: 451,800 s = 5.2292 days.
- T = 0.0143264840 years.
- Label = **"5d"** (date difference 5; also `floor(5.229)`).

GoCharting's exact rounding is not documented ([GoCharting option chain docs](https://gocharting.com/docs/options-desk/option-chain)). Verify against a live screenshot on an expiry day.

---

## 4. Risk-free rate and dividend yield

### 4.1 Risk-free rate
**Default: 5.75%, continuously compounded. Configurable per deployment, ideally updated weekly from the RBI 91-day T-bill auction.**

| Reference | Value | Source |
|---|---|---|
| 91-day T-bill implied yield, 7 Oct 2026 auction | 5.5747% | [Plutus IAS](https://plutusias.com/?p=279438), secondary source |
| 91-day T-bill cut-off YTM, 2 Sep 2026 | 5.2599% | RBI press releases on [rbi.org.in](https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx) |

The ~6.5–7% figure in the brief is above current T-bill yields. NSE's chain uses **10%** (see §1.1).

To convert the T-bill annual yield `y` to continuous: `r = ln(1 + y)` ≈ `y` for these magnitudes. Whichever value is used, its effect on IV is small when F comes from parity (§1.2).

### 4.2 Dividend yield
- **Not needed** when F comes from parity or futures, because it is embedded in F.
- `q` is only used in the last-resort `SPOT_CARRY` fallback. Default `q = 0`, configurable. Broad Indian equity indices yield roughly 1–1.5%; verify against NSE/BSE index factsheets before setting a non-zero default.
- For stock options, never use a constant `q`. Discrete dividends are handled implicitly by the parity or futures forward.

---

## 5. Greeks

Compute everything in Black-76 on F. **Then convert delta and gamma to spot terms**, because Indian traders read delta as "₹ per 1-point move in the index or stock". Spot conversion uses the implied carry `F = S·e^{bT}`, so `∂F/∂S = F/S`.

Let `D = e^{−rT}`, `n(x)` = standard normal pdf, `N(x)` = CDF, `V` = option price.

| Greek | Call | Put | Units shown in UI |
|---|---|---|---|
| Delta (spot) | `D·N(d1)·F/S` | `−D·N(−d1)·F/S` | per 1 point of underlying. Range 0..1 for calls, −1..0 for puts. 2 decimals. |
| Gamma (spot) | `D·n(d1)/(F·σ·√T) · (F/S)²` | same | delta change per 1 point. 4–6 decimals. |
| Theta | `[−D·F·n(d1)·σ/(2√T) + r·V] / 365` | same formula with put V | ₹ (premium points) per **calendar day**. Negative = decay. |
| Vega | `D·F·n(d1)·√T / 100` | same | ₹ per **1 vol point** (σ +1%). |
| Rho (optional) | `−T·V / 100` | same | ₹ per 1% change in r, holding F fixed. Tiny; hide by default. |

Notes:
- When `F/S = e^{rT}` (no dividends), spot delta reduces to `N(d1)`, which is the textbook BSM delta. See V9: 0.5028650183 = N(d1).
- **Theta is taken holding the forward constant** (Black-76 theta). With this definition, ATM call and put theta are equal (−13.66 in V7), which is what futures-based Indian platforms show.

  The alternative holds spot constant (generalized BSM theta, Haug):
  `Θ_call = −S·e^{(b−r)T}·n(d1)·σ/(2√T) − (b−r)·S·e^{(b−r)T}·N(d1) − r·K·e^{−rT}·N(d2)`.
  It gives asymmetric numbers (−15.73 call / −11.62 put in V9) because the forward drifts toward spot over time. That asymmetry confuses users, so we do not recommend it.
- Theta is the **instantaneous** rate ÷ 365. It is not the exact one-day premium change. Near expiry the two diverge: the actual 1-day change for V9's ATM call is −16.44 vs analytic −15.73, because decay accelerates with √T.
- **Position Greeks** (optional columns or tooltip): multiply per-unit Greeks by `lotSize × lots`. Example: delta 0.50 × lot 75 = 37.5 "index-unit delta" per lot.

---

## 6. Max Pain

**Definition:** the expiry price, chosen among listed strikes, at which the total intrinsic value payable to all option holders is **minimum** ([thetrading.tools](https://www.thetrading.tools/concepts/max-pain), [Deribit Insights](https://insights.deribit.com/education/maximum-pain-for-option-buyers-going-into-expiration/)). Some explainers say "highest" but their own worked examples use the minimum, and the minimum is correct.

For each candidate settlement strike `X` in the expiry's strike set:
```
CallPain(X) = Σ_i OI_CE(K_i) · max(0, X − K_i)
PutPain(X)  = Σ_i OI_PE(K_i) · max(0, K_i − X)
Pain(X)     = CallPain(X) + PutPain(X)
MaxPain     = argmin_X Pain(X)
```
- **Units.** If OI is in units (shares or index units), Pain is in ₹. If OI is in contracts, multiply by lot size to get ₹. Display per-strike pain in **₹ crore** (÷ 1e7). Show CallPain and PutPain separately in a tooltip.
- **Scope.** Use **all strikes of the selected expiry**, not only the visible window. OI only (volume is not used). Premiums are ignored.
- **Ties.** Choose the strike nearest to F.
- **Complexity.** The naive O(n²) loop is about 22.5k operations for 150 strikes, which is trivial. An O(n) prefix-sum version is possible but unnecessary.
- **Edge cases.** All OI = 0 → MaxPain = null.

Example: see V13 in §15.

---

## 7. PCR (Put-Call Ratio)

```
PCR_OI (overall)      = Σ OI_PE  / Σ OI_CE          over all strikes of the expiry
PCR_Vol (overall)     = Σ Vol_PE / Σ Vol_CE
PCR_OI(K) (per strike)  = OI_PE(K)  / OI_CE(K)
PCR_Vol(K)              = Vol_PE(K) / Vol_CE(K)
```
- Dimensionless. Display to 2 decimals. Lot size cancels because CE and PE of the same expiry share a lot size.
- If the denominator is 0, show "—" (null). Do not show ∞.
- Optional: PCR of the OI **change** (`ΣΔOI_PE / ΣΔOI_CE`) is popular in India but undefined when the denominator is ≤ 0. Keep it out of MVP.
- Scope (all strikes vs visible strikes) is a product decision, §16. Recommended: all strikes in the expiry. GoCharting describes PCR only as "based on volume and OI" ([docs](https://gocharting.com/docs/options-desk/option-chain)).

---

## 8. OI change, OI Change %, OI Sense

```
ΔOI   = OI − prevDayOI
ΔOI%  = ΔOI / prevDayOI × 100        (null if prevDayOI = 0; show "New")
ΔP    = LTP − prevClose              (of the option contract itself)
ΔP%   = ΔP / prevClose × 100         (or use the feed's % change field)
```

**OI Sense** (GoCharting rules, [GoCharting OI Sense](https://gocharting.com/docs/orderflow/open-interest-sense-oi-sense)): the option's own price change over the day × OI change over the day.

| ΔP | ΔOI | Label | Colour (GoCharting) |
|---|---|---|---|
| + | + | **Long Build Up** | Green |
| − | + | **Short Build Up** | Red |
| + | − | **Short Covering** | Orange |
| − | − | **Long Unwinding** | Cyan |

Edge cases:
- `ΔP = 0`, `ΔOI = 0`, or the contract has not traded today (volume = 0): label `"—"` (Neutral).
- Optional dead-band to avoid flicker: treat `|ΔP%| < 0.5%` or `|ΔOI%| < 1%` as 0. This is a product decision; the default is no dead-band, to match GoCharting.
- Basis: GoCharting states the comparison is "over the course of the day", so we compare against the previous close and previous-day OI. Verify against a live screen.
- Sentiment caveat: these labels describe option **writers and buyers of that contract**, not index direction. For example, "Short Build Up" on a CE is bearish for the underlying, while on a PE it is bullish. The UI should not colour-code CE and PE identically as "bullish/bearish for index".

---

## 9. ITM probability

**Recommendation: risk-neutral N(d2).**

```
P(ITM call) = N(d2)        P(ITM put) = N(−d2) = 1 − N(d2)
```
- N(d2) is the risk-neutral probability that `F_T > K` at expiry. N(d1) (≈ delta) is the probability under the share measure. It overstates call ITM probability: 10.30% vs 10.02% in V10, and the gap widens with σ√T.
- Use the strike's **smile IV** (§2.5) so the CE and PE probabilities at a strike sum to exactly 100%.
- Display as a percentage with 1 decimal. Null if IV is null.

---

## 10. Straddle and Str Decay

All at the same strike and expiry:

```
StraddlePrice = CE_LTP + PE_LTP
StraddleBid   = CE_bid + PE_bid      (proceeds of selling both at the bid)
StraddleAsk   = CE_ask + PE_ask      (cost of buying both at the ask)
StraddleMid   = (StraddleBid + StraddleAsk)/2    (optional; better for the ATM straddle chart)
StraddlePrev  = CE_prevClose + PE_prevClose
StrDecay      = StraddlePrice − StraddlePrev             (₹; negative = premium has decayed)
StrDecay%     = StrDecay / StraddlePrev × 100
```
- If either leg's bid or ask is missing (0), StraddleBid or StraddleAsk = null.
- If either LTP is missing, StraddlePrice = null.
- "Str Decay" is **not defined in GoCharting's public docs**. The definition above (vs previous close) follows the brief. An alternative reading is theoretical one-day decay = θ_CE + θ_PE. Confirm by comparing against a live GoCharting screen.

---

## 11. GEX (Gamma Exposure)

Standard definition: dollar (₹) change in dealer delta for a 1% move in the underlying ([FlashAlpha](https://flashalpha.com/tools/gamma-exposure)). The ×100 contract multiplier in US sources becomes the **lot size / units** in India. The original SqueezeMetrics framing uses calls +1 / puts −1 ([summary](https://slopeofhope.com/?p=187436)). GoCharting/ProCharting offer GEX-OI and GEX-Volume variants ([ProCharting OI Profile](https://procharting.in/docs/charting/technical-indicator/orderflow/Open-Interest-profile)).

```
GEX_OI(K)  = [ Γ_CE(K)·OIunits_CE(K) − Γ_PE(K)·OIunits_PE(K) ] · S² · 0.01
GEX_Vol(K) = [ Γ_CE(K)·Volunits_CE(K) − Γ_PE(K)·Volunits_PE(K) ] · S² · 0.01
Total GEX  = Σ_K GEX(K)
```
- **Γ** is the spot gamma from §5, computed with each leg's IV (smile IV fallback). Since `Γ_spot·S² = Γ_fwd·F²`, using F instead of S gives identical results (verified in V11).
- **OIunits.** OI in shares or index units. If the feed gives OI in contracts, use `OI × lotSize`.
- **Units.** ₹ of delta notional per 1% move. Display in **₹ crore** (÷ 1e7) with sign.
- **Sign convention** (state it in the tooltip): dealers are assumed long calls and short puts. Positive GEX means dealers dampen moves; negative means they amplify them. This is a convention, not an observed position. In India, retail is heavily short options too, so treat GEX as indicative.
- **GEX-Volume** uses day volume, which is turnover rather than outstanding positions. Label it as an activity indicator.
- Contracts with null IV contribute 0, and the strike is flagged.

---

## 12. ATM strike and ATM IV

- **ATM strike** = listed strike minimizing `|K − F|`, using the forward from §1.3. Ties go to the lower strike. Highlight this row in the chain.
  - Many Indian chains highlight relative to **spot**. The difference is usually 0–1 strikes for weeklies and can be more for monthlies. See product decision §16.
- **ATM IV** (header value):
  - Default: the **average of CE IV and PE IV at the ATM strike**. This matches GoCharting's likely definition.
  - Recommended enhancement: **interpolate** the smile IV linearly between the two strikes bracketing F, so ATM IV doesn't jump when F crosses a strike midpoint:
    `ATM_IV = IV(K1) + (F − K1)/(K2 − K1) · (IV(K2) − IV(K1))`.
- **Avg IV per strike** = mean of the valid CE IV and PE IV. If only one is valid, use it and flag it. If none, null.

---

## 13. Lot size and contract multiplier

- Lot size comes **per contract** from the feed (`ls`), never hard-coded. Exchanges revise index and stock lot sizes periodically, and different expiries can carry different lot sizes during a transition.
- Index option multiplier = lot size (index units per lot). Stock option multiplier = shares per lot.
- **OI and volume units: verify** whether the Noren/Kambala feed reports OI and volume in **quantity (units)** or **contracts (lots)**. Normalize once at ingestion:
  - `oiUnits` = `oi` if in units, else `oi × lotSize`;
  - `oiLots` = `oiUnits / lotSize`.
  
  Display OI in lots or units according to the product decision §16. Use units in Max Pain ₹ and GEX ₹.
- PCR and OI-change % are unaffected by units.

---

## 14. Cumulative OI and totals
- **Total CE OI** = Σ OI_CE and **Total PE OI** = Σ OI_PE over the expiry (header). The same applies to ΔOI and volume. GoCharting describes cumulative OI as the "total number of outstanding contracts" ([docs](https://gocharting.com/docs/options-desk/option-chain)).
- Optional running columns:
  - `CumCE(K) = Σ_{K_i ≤ K} OI_CE(K_i)`;
  - `CumPE(K) = Σ_{K_i ≥ K} OI_PE(K_i)`.
  
  Accumulating puts from the top is the common support/resistance view. This is a product choice.

---

## 15. Golden test vectors

Tolerances:
- prices and Greeks: relative 1e-8 (absolute 1e-9 when |x| < 1e-3);
- IV: absolute 1e-7.

Notation: `T` in years, `r` and `σ` decimal. "Spot delta/gamma" use S as given. Theta is per calendar day, vega per 1 vol point, rho per 1%.

### V1: textbook BSM check (Hull Ex. 15.6), b = r (no dividends)
S = 42, K = 40, r = 0.10, σ = 0.20, T = 0.5. This is Black-76 with F = S·e^{rT}.

| | Call | Put |
|---|---|---|
| price | 4.759422393 | 0.8085993729 |
| d1 / d2 | 0.7692626281 / 0.6278412719 | same |
| delta | 0.7791312909 | −0.2208687091 |
| gamma | 0.04996267041 | 0.04996267041 |
| vega / 1% | 0.0881341506 | 0.0881341506 |
| N(d2) / N(−d2) | 0.7349460368 | 0.2650539632 |

### V2: ATM BSM (S = 100, K = 100, r = 0.05, σ = 0.20, T = 1, q = 0)

| | Call | Put |
|---|---|---|
| price | 10.45058357 | 5.573526022 |
| d1 / d2 | 0.35 / 0.15 | |
| delta | 0.6368306512 | −0.3631693488 |
| gamma | 0.01876201735 | 0.01876201735 |
| vega / 1% | 0.3752403469 | 0.3752403469 |

### V3: Black-76 on futures (Hull, put on futures)
F = 20, K = 20, r = 0.09, σ = 0.25, T = 4/12. **Put = 1.116641457**, delta_F = −0.4573067304, gamma_F = 0.1337645027, vega/1% = 0.04458816755.

### V6: time to expiry
now = 2026-10-29T10:00:00+05:30, expiry = 2026-11-03T15:30:00+05:30 → seconds = 451800, **T = 0.01432648401826484**, DTE label **"5d"**.

### V7: index weekly, Black-76 (F = 25000, r = 0.06, T = 0.01432648401826484)

| Contract | σ | price | delta_F (D·N(d1)) | gamma_F | theta/day | vega/1% | N(d2) or N(−d2) | IV round-trip iterations (cold) |
|---|---|---|---|---|---|---|---|---|
| 25000 CE | 0.12 | 143.1278285 | 0.5024329467 | 0.001110029414 | −13.66176628 | 11.92711399 | 0.4971349817 | 2 |
| 25000 PE | 0.12 | 143.1278285 | −0.4967078336 | 0.001110029414 | −13.66176628 | 11.92711399 | 0.5028650183 | 2 |
| 25500 CE | 0.13 | 18.93560673 | 0.1028701621 | 0.0004604362516 | −6.659021417 | 5.359601487 | 0.1001966182 | 7 |
| 24500 PE | 0.14 | 22.97919068 | −0.1122769093 | 0.0004553727717 | −7.637751987 | 5.708404394 | 0.1156055315 | 6 |

- For 25000 CE: d1 = 0.007181597487 and rho/1% (F fixed) = −0.02050518548.
- IV round-trip of each price must return the input σ within 1e-7.

### V8: IV solve from market prices (F = 25000, r = 0.06, same T)

| Leg, price, K | Expected IV |
|---|---|
| CE 160.00 @ 25000 | 0.1341461084 |
| PE 140.00 @ 25000 | 0.1173775493 |
| CE 20.00 @ 25500 | 0.1319621404 |
| PE 3.00 @ 24000 | 0.1618032012 |
| CE 1005.00 @ 24000 (ITM) | 0.1797455660 |
| CE 900.00 @ 24000 | **null, BELOW_INTRINSIC** (P' = 900·e^{rT} < 1000) |

**Parity forward check:** with CE 160 and PE 140 at K = 25000, `F = 25000 + e^{rT}·20 = 25020.01719917187`. At this F both legs solve to **0.1255334321**, so CE IV equals PE IV. This is the core argument for §1.2.

### V9: spot-equivalent Greeks
S = 24978.51950749323 (= F·e^{−rT}), F = 25000, K = 25000, σ = 0.12, same r and T.
- Spot delta CE = 0.5028650183 (= N(d1)); spot delta PE = −0.4971349817.
- Spot gamma = 0.001111939394.
- Spot-fixed (GBSM) theta/day: CE −15.72655922, PE −11.62050121. Reference only, not the recommended theta.

### V10: ITM probability vs delta proxy
25500 CE from V7: N(d2) = 0.1001966182, N(d1) = 0.1029586262.

### V11: GEX at one strike
Strike 25000, S = 24978.51950749323, spot gamma 0.001111939394 for both legs (σ = 0.12), lot 75, OI_CE = 3000 lots, OI_PE = 1000 lots (×75 → units):

| | ₹ per 1% move | ₹ crore |
|---|---|---|
| Call part | +1,560,978,863.47 | |
| Put part | −520,326,287.82 | |
| **GEX_OI(25000)** | **+1,040,652,575.65** | **+104.065** |

Using F with gamma_F gives the identical value.

### V12: solver edge cases (F = 25000, r = 0.06, same T)

| Case | Expected |
|---|---|
| CE 0.05 @ 26500 | 0.1459646448 |
| CE 0.10 @ 26500 | 0.1538365464 (one tick = +0.79 vol points; low-confidence flag) |
| PE 0.05 @ 23000 | 0.2046296875 |
| CE 0.05 @ 25000 (ATM) | **null, BELOW_MIN_VOL**. A naive solver returns 0.001 after 100 iterations; the test must assert null. |
| 1 minute to expiry (T = 1/525600), ATM CE σ = 0.15 | price 2.063543389, round-trip IV 0.15 |

### V13: Max Pain, PCR (toy chain, OI in lots, lot 75)

| Strike | CE OI | PE OI | CallPain (lot·pts) | PutPain | Pain | Pain ₹ (×75) |
|---|---|---|---|---|---|---|
| 24800 | 1000 | 3500 | 0 | 1,650,000 | 1,650,000 | 123,750,000 |
| 24900 | 1500 | 4000 | 100,000 | 750,000 | 850,000 | 63,750,000 |
| 25000 | 3000 | 3000 | 350,000 | 250,000 | **600,000** | 45,000,000 |
| 25100 | 4000 | 1500 | 900,000 | 50,000 | 950,000 | 71,250,000 |
| 25200 | 2500 | 500 | 1,850,000 | 0 | 1,850,000 | 138,750,000 |

- **Max Pain = 25000.**
- PCR_OI overall = 12500/12000 = **1.041666667**.
- Per-strike PCR_OI: 3.5, 2.666667, 1.0, 0.375, 0.2.

### V14: synthetic forward (r = 0.06, same T)
Mids (CE, PE):
- 24900: (225.0, 120.0)
- 25000: (160.0, 155.5)
- 25100: (108.0, 203.0)

F_K by strike:
- 24900 → 25005.09029565
- 25000 → 25004.50386981
- 25100 → 25004.91830393

**F = median = 25004.91830393.**

### V15: straddle and OI Sense
- **Straddle.** CE LTP 160 and PE LTP 140, with previous closes 185 and 170: Straddle = 300, Prev = 355, **StrDecay = −55, StrDecay% = −15.49295775**.
- **OI Sense:**

| ΔP | ΔOI | Expected label |
|---|---|---|
| +12 | +50,000 | Long Build Up |
| −12 | +50,000 | Short Build Up |
| +12 | −50,000 | Short Covering |
| −12 | −50,000 | Long Unwinding |
| 0 | any | Neutral |

### Reference implementation (Python, used to generate the vectors)
```python
import math
N = lambda x: 0.5*(1+math.erf(x/math.sqrt(2)))
n = lambda x: math.exp(-0.5*x*x)/math.sqrt(2*math.pi)
def gbsm(cp, S, K, T, r, b, sig):          # b=0 & S=F -> Black-76; b=r -> BSM no div
    sT=sig*math.sqrt(T); d1=(math.log(S/K)+(b+0.5*sig*sig)*T)/sT; d2=d1-sT
    ebr=math.exp((b-r)*T); er=math.exp(-r*T)
    if cp=='C': price=S*ebr*N(d1)-K*er*N(d2); delta=ebr*N(d1)
    else:       price=K*er*N(-d2)-S*ebr*N(-d1); delta=-ebr*N(-d1)
    return price, delta, ebr*n(d1)/(S*sT), S*ebr*n(d1)*math.sqrt(T)/100
```

---

## 16. Product decisions for the business

1. **IV price source.** Mid (recommended: consistent and less noisy) or LTP (matches NSE and probably GoCharting numbers). Offer a toggle, but decide the default.
2. **Rate default and maintenance.** Use 5.75% (current T-bill area), match NSE's 10%, or follow the brief's 6.5–7%. Also decide who updates it and how often. With parity forwards the impact is small, but the value should be documented in the UI.
3. **Time basis.** Calendar ACT/365 (recommended) or trading-day/252, which needs a holiday calendar and changes weekend IV and theta behaviour.
4. **ATM reference.** Forward (recommended, consistent with analytics) or spot (familiar to Indian retail).
5. **OI display units.** Lots or quantity. Also confirm the feed's OI and volume units with Kambala.
6. **Scope of PCR, Max Pain and totals.** All strikes in the expiry (recommended) or only the visible window.
7. **Low-confidence suppression.** Thresholds for greying or hiding IV on sub-₹0.50 premiums, wide spreads and no-trade contracts.
8. **GEX sign convention** and its disclaimer text, given that Indian dealer positioning differs from the US assumption.
9. **"Str Decay" and DTE rounding semantics.** Confirm against live GoCharting screens before we claim parity.
10. **OI Sense dead-band.** Whether to suppress labels for tiny price or OI changes.
