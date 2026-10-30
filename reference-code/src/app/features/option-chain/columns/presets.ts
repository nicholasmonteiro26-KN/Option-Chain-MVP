export type PresetId = 'default' | 'price' | 'greeks' | 'oi' | 'candle' | 'stats' | 'straddle' | 'custom';

export interface Preset {
  id: PresetId;
  label: string;
  mode: 'mirrored' | 'strike';
  columns: string[];
}

/** Call-side columns are listed outer -> inner; the UI mirrors them for puts. */
export const PRESETS: Preset[] = [
  { id: 'default', label: 'Default', mode: 'mirrored', columns: ['volume', 'oi', 'bid', 'ask', 'ltpChg'] },
  { id: 'price', label: 'Price', mode: 'mirrored', columns: ['chgPct', 'chg', 'bid', 'ask', 'ltp'] },
  { id: 'greeks', label: 'Greeks', mode: 'mirrored', columns: ['iv', 'theta', 'vega', 'gamma', 'delta'] },
  { id: 'oi', label: 'Open Interest', mode: 'mirrored', columns: ['oiSense', 'oiChgPct', 'oiChg', 'oi', 'itmProb'] },
  { id: 'candle', label: 'Candle', mode: 'mirrored', columns: ['volume', 'low', 'high', 'open', 'ltp'] },
  {
    id: 'stats', label: 'Statistics', mode: 'strike',
    columns: ['straddle', 'cumOi', 'avgIv', 'pcrOi', 'pcrVol', 'gexOiCr', 'gexVolCr'],
  },
  {
    id: 'straddle', label: 'Straddle', mode: 'strike',
    columns: ['straddle', 'straddleBid', 'straddleAsk', 'strDecay', 'cumOi', 'avgIv', 'pcrOi', 'pcrVol', 'painCr'],
  },
  { id: 'custom', label: 'Custom', mode: 'mirrored', columns: [] },
];
