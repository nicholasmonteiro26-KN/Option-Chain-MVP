import { describe, expect, it } from 'vitest';
import { spotSlot } from './spot-slot';

const STRIKES = [22700, 22750, 22800, 22850, 22900, 22950];

describe('spotSlot', () => {
  it('holds within hysteresis band', () => {
    expect(spotSlot(22850, 22847, STRIKES, 50, 0.1)).toBe(22850);
    expect(spotSlot(22850, 22906, STRIKES, 50, 0.1)).toBe(22900);
    expect(spotSlot(22850, 22844, STRIKES, 50, 0.1)).toBe(22800);
    expect(spotSlot(null, 22873.4, STRIKES, 50, 0.1)).toBe(22850);
    expect(spotSlot(null, 100, STRIKES, 50, 0.1)).toBe(22700);
  });

  it('holds at the upper edge of the band (inclusive)', () => {
    expect(spotSlot(22850, 22905, STRIKES, 50, 0.1)).toBe(22850);
  });

  it('recomputes when prevSlot is not a strike', () => {
    expect(spotSlot(12345, 22873.4, STRIKES, 50, 0.1)).toBe(22850);
  });

  it('handles the last strike as prevSlot', () => {
    expect(spotSlot(22950, 22990, STRIKES, 50, 0.1)).toBe(22950);
  });
});
