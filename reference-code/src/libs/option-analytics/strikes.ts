/** Smallest positive gap between adjacent strikes of an ascending list (0 when fewer than two distinct strikes). */
export function minStrikeStep(sorted: readonly number[]): number {
  let step = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i] as number) - (sorted[i - 1] as number);
    if (gap > 0 && (step === 0 || gap < step)) step = gap;
  }
  return step;
}

/**
 * Index of the strike nearest `x` (-1 for an empty list). Strictly-less comparison over the list order, so on a tie
 * the earlier (for an ascending list, the lower) strike wins.
 */
export function nearestStrikeIndex(strikes: readonly number[], x: number): number {
  if (strikes.length === 0) return -1;
  let best = 0;
  let bestD = Math.abs((strikes[0] as number) - x);
  for (let i = 1; i < strikes.length; i++) {
    const d = Math.abs((strikes[i] as number) - x);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}
