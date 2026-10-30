import { minStrikeStep, nearestStrikeIndex } from './strikes';

describe('strike helpers', () => {
  it('minStrikeStep: smallest positive gap, 0 for fewer than two distinct strikes', () => {
    expect(minStrikeStep([100, 150, 175, 275])).toBe(25);
    expect(minStrikeStep([100, 100, 200])).toBe(100);
    expect(minStrikeStep([100])).toBe(0);
    expect(minStrikeStep([])).toBe(0);
  });

  it('nearestStrikeIndex: nearest strike, lower one on a tie, -1 when empty', () => {
    expect(nearestStrikeIndex([100, 150, 200], 160)).toBe(1);
    expect(nearestStrikeIndex([100, 150, 200], 125)).toBe(0); // tie: lower
    expect(nearestStrikeIndex([100, 150, 200], 1000)).toBe(2);
    expect(nearestStrikeIndex([], 5)).toBe(-1);
  });
});
