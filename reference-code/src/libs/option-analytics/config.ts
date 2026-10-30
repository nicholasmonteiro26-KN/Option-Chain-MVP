/** Runtime knobs for the option chain analytics (Global Constraints). */
export interface OptionChainConfig {
  riskFreeRate: number;
  /**
   * Unit of Kambala's OI and volume. Applied once, at ingestion: when 'lots' the store multiplies `oi`, `prevOi` and
   * `volume` by the contract's lot size, so everything downstream (table, header, `analyzeChain`) sees quantity.
   */
  oiUnit: 'lots' | 'qty';
  chainCnt: number;
  recalcIntervalMs: number;
  staleAfterMs: number;
  /** Under this many seconds to expiry a contract is EXPIRED (null IV and Greeks). */
  minTimeToExpirySec: number;
  /** Under this many seconds to expiry every solved IV is marked low-confidence (spec §6: under 1 h). */
  lowConfidenceBelowSec: number;
  forwardStrikesEachSide: number;
  spotSlotHysteresis: number;
}

export const DEFAULT_CONFIG: Readonly<OptionChainConfig> = Object.freeze({
  riskFreeRate: 0.0575,
  oiUnit: 'qty',
  chainCnt: 100,
  recalcIntervalMs: 1000,
  staleAfterMs: 30000,
  minTimeToExpirySec: 60,
  lowConfidenceBelowSec: 3600,
  forwardStrikesEachSide: 3,
  spotSlotHysteresis: 0.1,
});
