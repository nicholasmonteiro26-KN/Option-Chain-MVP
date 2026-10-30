import { black76, greeks } from '@option-analytics/black76';
import { normCdf, normPdf } from '@option-analytics/normal';
import * as api from '@option-analytics/index';

function close(a: number, b: number): void {
  const tol = Math.abs(b) < 1e-3 ? 1e-9 : Math.abs(b) * 1e-8;
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
}

describe('normal distribution', () => {
  it('normCdf anchors', () => {
    expect(normCdf(0)).toBe(0.5);
    close(normCdf(1.96), 0.9750021048517795);
    expect(Math.abs(normCdf(-8) / 6.22096057427178e-16 - 1)).toBeLessThan(1e-8);
    expect(Math.abs(normCdf(-5) / 2.866515718791939e-7 - 1)).toBeLessThan(1e-8);
    expect(api.normCdf).toBe(normCdf);
  });
  it('normPdf at 0', () => close(normPdf(0), 0.3989422804014327));
});

describe('V1', () => {
  const S = 42, K = 40, r = 0.1, s = 0.2, T = 0.5, F = 42 * Math.exp(0.05);
  it('prices and d1', () => {
    const c = black76('CE', F, K, T, r, s);
    close(c.price, 4.759422393);
    close(c.d1, 0.7692626281);
    close(black76('PE', F, K, T, r, s).price, 0.8085993729);
  });
  it('greeks', () => {
    const c = greeks('CE', F, S, K, T, r, s);
    const p = greeks('PE', F, S, K, T, r, s);
    close(c.delta, 0.7791312909);
    close(p.delta, -0.2208687091);
    close(c.gamma, 0.04996267041);
    close(c.vega, 0.0881341506);
    close(c.itmProb, 0.7349460368);
  });
});

describe('V2', () => {
  const S = 100, K = 100, r = 0.05, s = 0.2, T = 1, F = 100 * Math.exp(0.05);
  it('values', () => {
    close(black76('CE', F, K, T, r, s).price, 10.45058357);
    close(black76('PE', F, K, T, r, s).price, 5.573526022);
    const g = greeks('CE', F, S, K, T, r, s);
    close(g.delta, 0.6368306512);
    close(g.gamma, 0.01876201735);
    close(g.vega, 0.3752403469);
  });
});

describe('V3', () => {
  it('Black-76 put', () => close(black76('PE', 20, 20, 1 / 3, 0.09, 0.25).price, 1.116641457));
});

describe('V7 and V9', () => {
  const F = 25000, r = 0.06, T = 0.01432648401826484, S = F * Math.exp(-r * T);
  it('25000 CE', () => {
    close(black76('CE', F, 25000, T, r, 0.12).price, 143.1278285);
    const g = greeks('CE', F, S, 25000, T, r, 0.12);
    close(g.theta, -13.66176628);
    close(g.vega, 11.92711399);
    close(g.delta, 0.5028650183);
    close(g.gamma, 0.001111939394);
  });
  it('25000 PE spot delta', () => close(greeks('PE', F, S, 25000, T, r, 0.12).delta, -0.4971349817));
  it('25500 CE', () => {
    close(black76('CE', F, 25500, T, r, 0.13).price, 18.93560673);
    close(greeks('CE', F, S, 25500, T, r, 0.13).itmProb, 0.1001966182);
  });
  it('24500 PE', () => close(black76('PE', F, 24500, T, r, 0.14).price, 22.97919068));
});
