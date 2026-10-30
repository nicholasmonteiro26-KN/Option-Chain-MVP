import { describe, expect, it } from 'vitest';
import { parseExd } from '../instruments.service';
import { MockMarket } from './mock-market';
import { MockKambalaRestClient } from './mock-kambala-rest.client';

/** 2026-10-29 11:30 IST. */
const NOW = Date.UTC(2026, 9, 29, 6, 0, 0);
const market = (seed = 7) => new MockMarket({ seed, now: () => NOW });

function chainFor(m: MockMarket, exch: string, token: string, exd: string) {
  const e = m.linkedScrips(exch, token).opt_exp.find((x) => x.exd === exd)!;
  return m.optionChain(e.exch, e.tsym, +m.seed(`${exch}|${token}`)!['lp']!, 100);
}

describe('MockMarket', () => {
  it('seeds NIFTY and SENSEX spot and previous close as in the mockup', () => {
    const m = market();
    expect(m.seed('NSE|26000')).toMatchObject({ lp: '22873.40', c: '22706.85' });
    expect(m.seed('BSE|1')).toMatchObject({ lp: '73830.29', c: '73246.03' });
    const u = m.seed('NSE|26000')!;
    expect(+u['h']!).toBeGreaterThanOrEqual(22873.4);
    expect(+u['l']!).toBeLessThanOrEqual(+u['o']!);
  });

  it('lists NIFTY weekly expiries from 03-NOV-2026 in DD-MMM-YYYY form', () => {
    const exds = market().linkedScrips('NSE', '26000').opt_exp.map((e) => e.exd);
    expect(exds[0]).toBe('03-NOV-2026');
    expect(exds).toEqual(['03-NOV-2026', '10-NOV-2026', '17-NOV-2026', '24-NOV-2026', '29-DEC-2026', '30-MAR-2027', '29-JUN-2027']);
    for (const d of exds) expect(parseExd(d)).not.toBeNull();
  });

  it('SENSEX lot size is 20 for Nov/Dec 2026 and 25 for the 28-JAN-2027 expiry', () => {
    const m = market();
    const exds = m.linkedScrips('BSE', '1').opt_exp.map((e) => e.exd);
    expect(exds).toContain('28-JAN-2027');
    for (const exd of exds) {
      const rows = chainFor(m, 'BSE', '1', exd);
      expect(new Set(rows.map((r) => r.ls))).toEqual(new Set([exd === '28-JAN-2027' ? '25' : '20']));
      expect(rows.every((r) => r.exch === 'BFO')).toBe(true);
    }
  });

  it('getOptionChain returns 35 strikes (CE + PE) centred on strprc with unique tokens', () => {
    const m = market();
    const e = m.linkedScrips('NSE', '26000').opt_exp[0]!;
    const rows = m.optionChain(e.exch, e.tsym, 22873, 100);
    const strikes = [...new Set(rows.map((r) => +r.strprc))].sort((a, b) => a - b);
    expect(strikes).toHaveLength(35);
    expect(strikes[17]).toBe(22850);
    expect(strikes[1]! - strikes[0]!).toBe(50);
    expect(rows).toHaveLength(70);
    expect(new Set(rows.map((r) => r.token)).size).toBe(70);
    expect(rows[0]).toMatchObject({ exch: 'NFO', pp: '2', ti: '0.05', ls: '65' });
    expect(['CE', 'PE']).toContain(rows[0]!.optt);
  });

  it('serves a configurable strike count (for large-chain performance runs)', () => {
    const m = new MockMarket({ seed: 7, now: () => NOW, strikesPerChain: 100 });
    const e = m.linkedScrips('NSE', '26000').opt_exp[0]!;
    expect(m.optionChain(e.exch, e.tsym, 22873, 100)).toHaveLength(200);
  });

  it('is deterministic: same seed gives the same contract seeds and tick stream', () => {
    const a = market(11);
    const b = market(11);
    const rows = chainFor(a, 'NSE', '26000', '03-NOV-2026');
    const keys = ['NSE|26000', ...rows.map((r) => `${r.exch}|${r.token}`)];
    expect(keys.map((k) => a.seed(k))).toEqual(keys.map((k) => b.seed(k)));
    const ra = a.random;
    const rb = b.random;
    for (let i = 0; i < 50; i++) expect(a.tick(keys, ra)).toEqual(b.tick(keys, rb));
  });

  it('prices legs with Black-76 on a smile: CE falls and PE rises with strike, bid/ask ±0.05 around lp', () => {
    const m = market();
    const rows = chainFor(m, 'NSE', '26000', '03-NOV-2026');
    const legs = rows.map((r) => ({ r, s: m.seed(`${r.exch}|${r.token}`)! }));
    const ce = legs.filter((x) => x.r.optt === 'CE').sort((x, y) => +x.r.strprc - +y.r.strprc).map((x) => +x.s['lp']!);
    const pe = legs.filter((x) => x.r.optt === 'PE').sort((x, y) => +x.r.strprc - +y.r.strprc).map((x) => +x.s['lp']!);
    for (let i = 1; i < ce.length; i++) {
      expect(ce[i]!).toBeLessThanOrEqual(ce[i - 1]!);
      expect(pe[i]!).toBeGreaterThanOrEqual(pe[i - 1]!);
    }
    const atmCe = legs.find((x) => x.r.optt === 'CE' && +x.r.strprc === 22900)!.s;
    expect(+atmCe['lp']!).toBeGreaterThan(60);
    expect(+atmCe['lp']!).toBeLessThan(250);
    expect(+atmCe['bp1']!).toBeCloseTo(+atmCe['lp']! - 0.05, 5);
    expect(+atmCe['sp1']!).toBeCloseTo(+atmCe['lp']! + 0.05, 5);
    for (const f of ['lp', 'c', 'o', 'h', 'l', 'v', 'oi', 'poi', 'bp1', 'sp1', 'bq1', 'sq1', 'ls', 'ti']) {
      expect(typeof atmCe[f]).toBe('string');
    }
  });

  it('call OI peaks above spot and put OI peaks below spot', () => {
    for (const [exch, token, exd, spot] of [
      ['NSE', '26000', '03-NOV-2026', 22873.4], ['BSE', '1', '05-NOV-2026', 73830.29],
    ] as const) {
      const m = market();
      const rows = chainFor(m, exch, token, exd);
      const peak = (optt: string) => rows
        .filter((r) => r.optt === optt)
        .map((r) => ({ k: +r.strprc, oi: +m.seed(`${r.exch}|${r.token}`)!['oi']! }))
        .reduce((a, b) => (b.oi > a.oi ? b : a)).k;
      expect(peak('CE')).toBeGreaterThan(spot);
      expect(peak('PE')).toBeLessThan(spot);
    }
  });

  it('ticks move the underlying a few points and reprice legs with it', () => {
    const m = market();
    const rows = chainFor(m, 'NSE', '26000', '03-NOV-2026');
    const keys = ['NSE|26000', ...rows.map((r) => `${r.exch}|${r.token}`)];
    let maxStep = 0;
    let last = 22873.4;
    for (let i = 0; i < 200; i++) {
      const msgs = m.tick(keys, m.random);
      const u = msgs.find((x) => x['tk'] === '26000');
      expect(u).toBeDefined();
      const lp = +u!['lp']!;
      maxStep = Math.max(maxStep, Math.abs(lp - last));
      last = lp;
      expect(msgs.length).toBeGreaterThan(1);
    }
    expect(maxStep).toBeLessThan(2);
    expect(Math.abs(last - 22873.4)).toBeLessThan(22873.4 * 0.003 + 1);
  });

  it('pinSpot keeps the underlying within ±3 of the pinned value', () => {
    const m = market();
    m.pinSpot('NIFTY', 22873);
    for (let i = 0; i < 400; i++) {
      const lp = +m.tick(['NSE|26000'], m.random)[0]!['lp']!;
      expect(Math.abs(lp - 22873)).toBeLessThanOrEqual(3);
    }
  });

  it('search matches symbol or name, case-insensitively, as equity/index rows', () => {
    const m = market();
    expect(m.search('sbi').map((r) => r.tsym)).toContain('SBIN-EQ');
    expect(m.search('nifty')[0]).toEqual({ exch: 'NSE', tsym: 'NIFTY', token: '26000', name: 'Nifty 50' });
    expect(m.search('reliance')[0]).toMatchObject({ exch: 'NSE', token: '2885' });
    expect(m.search('zzz')).toEqual([]);
  });

  it('unknown keys and unknown underlyings give nothing', () => {
    const m = market();
    expect(m.seed('NSE|999999')).toBeNull();
    expect(m.seed('NFO|1')).toBeNull();
    expect(m.linkedScrips('NSE', '424242').opt_exp).toEqual([]);
    expect(m.optionChain('NFO', 'FOO03NOV26C100', 100, 10)).toEqual([]);
  });
});

describe('MockKambalaRestClient', () => {
  it('serves the market through the KambalaRestClient API', async () => {
    const m = market();
    const rest = new MockKambalaRestClient(m);
    const linked = await rest.getLinkedScrips('NSE', '26000');
    expect(linked.opt_exp).toHaveLength(7);
    const rows = await rest.getOptionChain('NFO', linked.opt_exp[0]!.tsym, 22873, 100);
    expect(rows).toHaveLength(70);
    expect((await rest.searchScrip('INFY'))[0]).toMatchObject({ exch: 'NSE', tsym: 'INFY-EQ', token: '1594' });
  });
});
