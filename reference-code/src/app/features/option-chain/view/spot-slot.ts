/**
 * The strike the spot line sits directly below. Keeps `prevSlot` while the spot stays within
 * [prevSlot - h, next(prevSlot) + h], h = step * hysteresis; otherwise the largest strike <= spot
 * (the first strike when spot is below all). `strikes` is sorted ascending.
 */
export function spotSlot(
  prevSlot: number | null,
  spot: number,
  strikes: number[],
  step: number,
  hysteresis: number,
): number {
  if (strikes.length === 0) return prevSlot ?? 0;
  if (prevSlot !== null) {
    const i = strikes.indexOf(prevSlot);
    if (i >= 0) {
      const h = step * hysteresis;
      const next = strikes[i + 1] ?? prevSlot + step;
      if (spot >= prevSlot - h && spot <= next + h) return prevSlot;
    }
  }
  let slot = strikes[0] as number;
  for (const k of strikes) {
    if (k <= spot) slot = k;
    else break;
  }
  return slot;
}
