import { describe, expect, it } from 'vitest';
import { dteLabel, expiryInstantMs, isExpired, yearsToExpiry } from './time';

const now = Date.parse('2026-10-29T10:00:00+05:30');
const exp = expiryInstantMs('2026-11-03');

describe('time', () => {
  it('expiryInstantMs is 15:30 IST', () => {
    expect(exp).toBe(Date.parse('2026-11-03T15:30:00+05:30'));
    expect(exp).toBe(Date.UTC(2026, 10, 3, 10, 0, 0));
  });
  it('V6 yearsToExpiry', () => {
    const t = yearsToExpiry(now, exp);
    expect(Math.abs(t - 0.01432648401826484) / 0.01432648401826484).toBeLessThan(1e-15);
  });
  it('yearsToExpiry floors at 0', () => expect(yearsToExpiry(exp + 5000, exp)).toBe(0));
  it('V6 dteLabel', () => {
    expect(dteLabel(now, '2026-11-03')).toBe('5d');
    expect(dteLabel(Date.parse('2026-11-03T11:00:00+05:30'), '2026-11-03')).toBe('0d');
  });
  it('dteLabel uses IST dates (late evening IST)', () => {
    expect(dteLabel(Date.parse('2026-10-29T23:30:00+05:30'), '2026-11-03')).toBe('5d');
    expect(dteLabel(Date.parse('2026-10-29T00:10:00+05:30'), '2026-11-03')).toBe('5d');
  });
  it('isExpired', () => {
    expect(isExpired(Date.parse('2026-11-03T15:30:30+05:30'), exp, 60)).toBe(true);
    expect(isExpired(Date.parse('2026-11-03T15:28:00+05:30'), exp, 60)).toBe(false);
    expect(isExpired(Date.parse('2026-11-03T15:29:30+05:30'), exp, 60)).toBe(true);
  });
});
