import { black76 } from '@option-analytics/black76';
import { DEFAULT_CONFIG } from '@option-analytics/config';
import { expiryInstantMs } from '@option-analytics/time';
import type { LinkedScripsResponse, OptionChainRow, ScripSearchResult } from '../kambala/kambala.types';

/**
 * Deterministic sample market for `?feed=mock`, demos and tests. Models the approved mockup's numbers
 * (docs/design/option-chain-core-design.html): NIFTY and SENSEX plus a few F&O stocks. Not market data.
 */

interface ExpiryDef { iso: string; lot?: number }
interface UnderlyingDef {
  sym: string;
  name: string;
  exch: 'NSE' | 'BSE';
  foExch: 'NFO' | 'BFO';
  token: string;
  spot: number;
  prevClose: number;
  step: number;
  lot: number;
  /** OI scale (contracts' OI peaks around 5-10x this, as in the mockup). */
  oi: number;
  expiries: ExpiryDef[];
}

const WEEKLY_NSE: ExpiryDef[] = [
  { iso: '2026-11-03' }, { iso: '2026-11-10' }, { iso: '2026-11-17' }, { iso: '2026-11-24' },
  { iso: '2026-12-29' }, { iso: '2027-03-30' }, { iso: '2027-06-29' },
];
// SENSEX lot is 20 for Nov/Dec 2026 and 25 from Jan 2027 (BSE notice 20260930-58, spec D21).
const WEEKLY_BSE: ExpiryDef[] = [
  { iso: '2026-11-05' }, { iso: '2026-11-12' }, { iso: '2026-11-19' }, { iso: '2026-11-26' },
  { iso: '2026-12-31' }, { iso: '2027-01-28', lot: 25 },
];
const MONTHLY: ExpiryDef[] = [{ iso: '2026-11-24' }, { iso: '2026-12-29' }, { iso: '2027-01-25' }];

const UNDERLYINGS: UnderlyingDef[] = [
  { sym: 'NIFTY', name: 'Nifty 50', exch: 'NSE', foExch: 'NFO', token: '26000', spot: 22873.4, prevClose: 22706.85, step: 50, lot: 65, oi: 1e6, expiries: WEEKLY_NSE },
  { sym: 'SENSEX', name: 'BSE Sensex', exch: 'BSE', foExch: 'BFO', token: '1', spot: 73830.29, prevClose: 73246.03, step: 100, lot: 20, oi: 3e5, expiries: WEEKLY_BSE },
  { sym: 'RELIANCE', name: 'Reliance Industries', exch: 'NSE', foExch: 'NFO', token: '2885', spot: 1420.35, prevClose: 1411.2, step: 10, lot: 500, oi: 1.2e6, expiries: MONTHLY },
  { sym: 'TCS', name: 'Tata Consultancy Services', exch: 'NSE', foExch: 'NFO', token: '11536', spot: 2474.1, prevClose: 2460, step: 20, lot: 225, oi: 3e5, expiries: MONTHLY },
  { sym: 'HDFCBANK', name: 'HDFC Bank', exch: 'NSE', foExch: 'NFO', token: '1333', spot: 980.45, prevClose: 975.6, step: 10, lot: 650, oi: 1.4e6, expiries: MONTHLY },
  { sym: 'ICICIBANK', name: 'ICICI Bank', exch: 'NSE', foExch: 'NFO', token: '4963', spot: 1381, prevClose: 1377.6, step: 10, lot: 700, oi: 9e5, expiries: MONTHLY },
  { sym: 'INFY', name: 'Infosys', exch: 'NSE', foExch: 'NFO', token: '1594', spot: 1531.8, prevClose: 1522.3, step: 20, lot: 400, oi: 6e5, expiries: MONTHLY },
  { sym: 'SBIN', name: 'State Bank of India', exch: 'NSE', foExch: 'NFO', token: '3045', spot: 815.4, prevClose: 811.25, step: 5, lot: 750, oi: 1.6e6, expiries: MONTHLY },
  { sym: 'AXISBANK', name: 'Axis Bank', exch: 'NSE', foExch: 'NFO', token: '5900', spot: 1221.4, prevClose: 1219.9, step: 10, lot: 625, oi: 7e5, expiries: MONTHLY },
];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Strikes each side of the opening ATM in the contract grid (a chain can serve up to 2·GRID+1 strikes). */
const GRID = 50;
const TOKEN_BASE = 100_000;
const TOKENS_PER_UNDERLYING = 20_000;
const TOKENS_PER_EXPIRY = 250;
const TICK = 0.05;
const YEAR_MS = 365 * 86_400_000;
/** Max underlying move per tick as a fraction of its anchor (about ±0.86 points for NIFTY at 20 ticks/s). */
const SPOT_STEP = 0.0000375;
/** Free-running spot stays within ±0.3% of its anchor; a pinned spot within ±3 points. */
const SPOT_BAND = 0.003;
const PIN_BAND = 3;

export interface MockMarketOptions {
  /** PRNG seed (default 7). */
  seed?: number;
  /** Pricing clock (default Date.now). */
  now?: () => number;
  /** Strikes per GetOptionChain response (default 35, max 101). */
  strikesPerChain?: number;
}

interface Contract { u: UnderlyingDef; ui: number; ei: number; si: number; strike: number; type: 'CE' | 'PE'; lot: number }
interface LegState { lp: number; c: number; o: number; h: number; l: number; v: number; oi: number; poi: number; bq: number; sq: number }
interface SpotState { spot: number; anchor: number; band: number; o: number; h: number; l: number }

/** mulberry32: small, fast, seedable. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const roundTick = (x: number): number => Math.max(TICK, Math.round(x / TICK) * TICK);
const fix2 = (x: number): string => x.toFixed(2);
const atm0 = (u: UnderlyingDef): number => Math.round(u.spot / u.step) * u.step;

/** 'YYYY-MM-DD' -> 'DD-MMM-YYYY' (Kambala's exd). */
function exdOf(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}
/** 'YYYY-MM-DD' -> 'DDMMMYY' as in NFO trading symbols. */
function tsymDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}${MONTHS[Number(m) - 1]}${y!.slice(2)}`;
}

/** Implied volatility smile of the mockup: σ(K) = 0.118 + 0.002·√days − 0.18·m + 3.2·m², m = ln(K/F). */
export function mockSmile(K: number, F: number, days: number): number {
  const m = Math.log(K / F);
  return 0.118 + 0.002 * Math.sqrt(days) - 0.18 * m + 3.2 * m * m;
}

export class MockMarket {
  /** Seeded PRNG for the feed's tick stream (pass it to MockFeedTransport as `random`). */
  readonly random: () => number;
  private readonly seedValue: number;
  private readonly now: () => number;
  private readonly strikesPerChain: number;
  private readonly spots = new Map<string, SpotState>();
  private readonly legs = new Map<string, LegState>();

  constructor(opts: MockMarketOptions = {}) {
    this.seedValue = opts.seed ?? 7;
    this.random = prng(this.seedValue);
    this.now = opts.now ?? Date.now;
    this.strikesPerChain = Math.max(1, Math.min(2 * GRID + 1, opts.strikesPerChain ?? 35));
  }

  /** GetLinkedScrips: every option expiry with an anchor trading symbol. */
  linkedScrips(exch: string, token: string): LinkedScripsResponse {
    const u = UNDERLYINGS.find((x) => x.exch === exch && x.token === token);
    if (!u) return { stat: 'Ok', opt_exp: [] };
    return {
      stat: 'Ok',
      opt_exp: u.expiries.map((e) => ({ exd: exdOf(e.iso), exch: u.foExch, tsym: `${u.sym}${tsymDate(e.iso)}C${atm0(u)}` })),
    };
  }

  /** GetOptionChain: `strikesPerChain` strikes centred on the grid strike nearest `strprc`, CE and PE rows. */
  optionChain(exch: string, tsym: string, strprc: number, _cnt: number): OptionChainRow[] {
    const m = /^(.+?)(\d{2}[A-Z]{3}\d{2})[CP][\d.]+$/.exec(tsym);
    if (!m) return [];
    const ui = UNDERLYINGS.findIndex((x) => x.sym === m[1] && x.foExch === exch);
    const u = UNDERLYINGS[ui];
    if (!u) return [];
    const ei = u.expiries.findIndex((e) => tsymDate(e.iso) === m[2]);
    if (ei < 0) return [];
    const n = this.strikesPerChain;
    const centre = Math.round((strprc - atm0(u)) / u.step) + GRID;
    const lo = Math.max(0, Math.min(2 * GRID + 1 - n, centre - Math.floor(n / 2)));
    const rows: OptionChainRow[] = [];
    for (let si = lo; si < lo + n; si++) {
      for (const type of ['CE', 'PE'] as const) {
        const c = this.contract(ui, ei, si, type)!;
        rows.push({
          exch: u.foExch, tsym: `${u.sym}${m[2]}${type === 'CE' ? 'C' : 'P'}${c.strike}`, token: tokenOf(ui, ei, si, type),
          optt: type, strprc: c.strike.toFixed(2), pp: '2', ti: fix2(TICK), ls: String(c.lot),
        });
      }
    }
    return rows;
  }

  /** SearchScrip: indices and equities whose symbol or name contains `text` (case-insensitive). */
  search(text: string): ScripSearchResult[] {
    const t = text.trim().toUpperCase();
    if (!t) return [];
    return UNDERLYINGS.filter((u) => u.sym.includes(t) || u.name.toUpperCase().includes(t)).map((u) => ({
      exch: u.exch, tsym: isIndex(u) ? u.sym : `${u.sym}-EQ`, token: u.token, name: u.name,
    }));
  }

  /** Touchline snapshot (wire strings) of a feed key's current state, or null for an unknown key. */
  seed(key: string): Record<string, string> | null {
    const spot = this.spotState(key);
    if (spot) return { lp: fix2(spot.spot), c: fix2(this.underlyingOf(key)!.prevClose), o: fix2(spot.o), h: fix2(spot.h), l: fix2(spot.l), pp: '2', ti: fix2(TICK) };
    const c = this.contractOf(key);
    if (!c) return null;
    const s = this.legState(key, c);
    return {
      lp: fix2(s.lp), c: fix2(s.c), o: fix2(s.o), h: fix2(s.h), l: fix2(s.l), v: String(s.v), oi: String(s.oi),
      poi: String(s.poi), bp1: fix2(Math.max(0, s.lp - TICK)), sp1: fix2(s.lp + TICK), bq1: String(s.bq),
      sq1: String(s.sq), ls: String(c.lot), ti: fix2(TICK), pp: '2',
    };
  }

  /**
   * One feed tick for the subscribed keys: every subscribed underlying moves a little, then a sample of the
   * subscribed option legs is repriced from their underlying's current spot (with occasional volume/OI bumps).
   */
  tick(subscribed: readonly string[], random: () => number): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    const legs: string[] = [];
    for (const key of subscribed) {
      const s = this.spotState(key);
      if (!s) {
        if (this.contractOf(key)) legs.push(key);
        continue;
      }
      const delta = (random() - 0.5) * 2 * s.anchor * SPOT_STEP;
      const pull = (s.anchor - s.spot) * 0.02; // gentle mean reversion keeps the walk near its anchor
      s.spot = Math.round(Math.min(s.anchor + s.band, Math.max(s.anchor - s.band, s.spot + delta + pull)) * 100) / 100;
      const [e, tk] = splitKey(key);
      const msg: Record<string, string> = { t: 'tf', e, tk, lp: fix2(s.spot) };
      if (s.spot > s.h) { s.h = s.spot; msg['h'] = fix2(s.h); }
      if (s.spot < s.l) { s.l = s.spot; msg['l'] = fix2(s.l); }
      out.push(msg);
    }
    const n = Math.min(legs.length, Math.max(4, Math.ceil(legs.length / 8)));
    for (let i = 0; i < n; i++) {
      const key = legs[Math.min(legs.length - 1, Math.floor(random() * legs.length))]!;
      const c = this.contractOf(key)!;
      const s = this.legState(key, c);
      s.lp = this.price(c, this.currentSpot(c.u), 0);
      const [e, tk] = splitKey(key);
      const msg: Record<string, string> = { t: 'tf', e, tk, lp: fix2(s.lp), bp1: fix2(Math.max(0, s.lp - TICK)), sp1: fix2(s.lp + TICK) };
      if (s.lp > s.h) { s.h = s.lp; msg['h'] = fix2(s.h); }
      if (s.lp < s.l) { s.l = s.lp; msg['l'] = fix2(s.l); }
      if (random() < 0.15) {
        const lots = 1 + Math.floor(random() * 20);
        s.v += lots * c.lot * 3;
        s.oi = Math.max(0, s.oi + (random() < 0.6 ? 1 : -1) * lots * c.lot);
        msg['v'] = String(s.v);
        msg['oi'] = String(s.oi);
      }
      out.push(msg);
    }
    return out;
  }

  /** Pins an underlying near `value`: ticks keep it within ±3 points of it (e2e hook). */
  pinSpot(sym: string, value: number): void {
    const u = UNDERLYINGS.find((x) => x.sym === sym);
    if (!u) return;
    const s = this.spotState(`${u.exch}|${u.token}`)!;
    s.anchor = value;
    s.band = PIN_BAND;
    s.spot = value;
  }

  private currentSpot(u: UnderlyingDef): number {
    return this.spotState(`${u.exch}|${u.token}`)!.spot;
  }

  private underlyingOf(key: string): UnderlyingDef | undefined {
    const [e, tk] = splitKey(key);
    return UNDERLYINGS.find((u) => u.exch === e && u.token === tk);
  }

  private spotState(key: string): SpotState | null {
    const u = this.underlyingOf(key);
    if (!u) return null;
    let s = this.spots.get(key);
    if (!s) {
      const r = prng(hash(key, this.seedValue));
      const between = (a: number, b: number) => a + (b - a) * r();
      const o = u.prevClose * (1 + between(-0.002, 0.004));
      s = {
        spot: u.spot, anchor: u.spot, band: u.spot * SPOT_BAND, o,
        h: Math.max(o, u.spot) * (1 + between(0.0005, 0.002)),
        l: Math.min(o, u.spot) * (1 - between(0.0005, 0.002)),
      };
      this.spots.set(key, s);
    }
    return s;
  }

  private contractOf(key: string): Contract | null {
    const [exch, tk] = splitKey(key);
    if (!/^\d+$/.test(tk)) return null;
    const n = Number(tk) - TOKEN_BASE;
    if (n < 0) return null;
    const ui = Math.floor(n / TOKENS_PER_UNDERLYING);
    const rest = n % TOKENS_PER_UNDERLYING;
    const ei = Math.floor(rest / TOKENS_PER_EXPIRY);
    const k = rest % TOKENS_PER_EXPIRY;
    const si = Math.floor(k / 2);
    const c = this.contract(ui, ei, si, k % 2 === 0 ? 'CE' : 'PE');
    return c && c.u.foExch === exch ? c : null;
  }

  private contract(ui: number, ei: number, si: number, type: 'CE' | 'PE'): Contract | null {
    const u = UNDERLYINGS[ui];
    const e = u?.expiries[ei];
    if (!u || !e || si < 0 || si > 2 * GRID) return null;
    return { u, ui, ei, si, strike: atm0(u) + (si - GRID) * u.step, type, lot: e.lot ?? u.lot };
  }

  /** Black-76 price on the smile at underlying `S`, `extraDays` before now (1 = yesterday's close). */
  private price(c: Contract, S: number, extraDays: number): number {
    const r = DEFAULT_CONFIG.riskFreeRate;
    const expiry = expiryInstantMs(c.u.expiries[c.ei]!.iso);
    const T = Math.max(1 / 365 / 24, (expiry - this.now()) / YEAR_MS) + extraDays / 365;
    const F = S * Math.exp(r * T);
    return roundTick(black76(c.type, F, c.strike, T, r, mockSmile(c.strike, F, T * 365)).price);
  }

  private legState(key: string, c: Contract): LegState {
    let s = this.legs.get(key);
    if (s) return s;
    const r = prng(hash(key, this.seedValue));
    const between = (a: number, b: number) => a + (b - a) * r();
    const { u, strike: K, lot } = c;
    const a0 = atm0(u);
    // OI as in the mockup: calls build above spot, puts below, round strikes heavier, far expiries lighter.
    const scale = c.ei === 0 ? 1 : Math.max(0.25, 1 / (1 + c.ei * 0.5));
    const centre = c.type === 'CE' ? a0 + 4 * u.step : a0 - 6 * u.step;
    const peak = c.type === 'CE' ? 5.5 : 5.0;
    const wid = 5.2 * u.step;
    const w = K % (u.step * 10) === 0 ? 1.7 : K % (u.step * 2) === 0 ? 1.2 : 0.85;
    const roundLots = (x: number) => Math.max(0, Math.round(x / lot) * lot);
    const oi = roundLots(scale * w * u.oi * (0.35 + peak * Math.exp(-(((K - centre) / wid) ** 2))) * between(0.8, 1.2));
    const prevClose = this.price(c, u.prevClose, 1);
    const lp = this.price(c, this.currentSpot(u), 0);
    const o = roundTick(prevClose * between(0.9, 1.1));
    s = {
      lp, c: prevClose, o,
      h: roundTick(Math.max(o, lp) * between(1.0, 1.04)),
      l: roundTick(Math.min(o, lp) * between(0.96, 1.0)),
      oi, poi: roundLots(oi * between(0.55, 1.35)), v: roundLots(oi * between(8, 30)),
      bq: lot * (1 + Math.floor(between(0, 40))), sq: lot * (1 + Math.floor(between(0, 40))),
    };
    this.legs.set(key, s);
    return s;
  }
}

function isIndex(u: UnderlyingDef): boolean {
  return u.sym === 'NIFTY' || u.sym === 'SENSEX';
}

function tokenOf(ui: number, ei: number, si: number, type: 'CE' | 'PE'): string {
  return String(TOKEN_BASE + ui * TOKENS_PER_UNDERLYING + ei * TOKENS_PER_EXPIRY + si * 2 + (type === 'CE' ? 0 : 1));
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)];
}
