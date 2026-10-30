export type OptType = 'CE' | 'PE';

export type IvStatus =
  | 'OK' | 'NO_PRICE' | 'BELOW_INTRINSIC' | 'ABOVE_MAX'
  | 'BELOW_MIN_VOL' | 'ABOVE_MAX_VOL' | 'EXPIRED' | 'NO_CONVERGENCE';

export interface LegQuote {
  token: string; type: OptType; strike: number; lotSize: number; tickSize: number;
  ltp: number | null; bid: number | null; ask: number | null; bidQty: number; askQty: number;
  volume: number; oi: number; prevOi: number; prevClose: number | null;
  open: number | null; high: number | null; low: number | null; lastTickMs: number;
}

export interface StrikeQuotes { strike: number; ce: LegQuote | null; pe: LegQuote | null }

export type ForwardSource = 'PARITY_MID' | 'FUTURES' | 'PARITY_LTP' | 'SPOT_CARRY';

export type OiSense = 'LONG_BUILD_UP' | 'SHORT_BUILD_UP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';
