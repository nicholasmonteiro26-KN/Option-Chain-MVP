const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const DAY_MS = 86400 * 1000;

/** Epoch ms of 15:30:00 IST (= 10:00:00 UTC) on the ISO date 'YYYY-MM-DD'. IST is fixed UTC+05:30. */
export function expiryInstantMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y as number, (m as number) - 1, d as number, 10, 0, 0);
}

/** ACT/365 calendar time in years, floored at 0. */
export function yearsToExpiry(nowMs: number, expiryMs: number): number {
  return Math.max(0, (expiryMs - nowMs) / 1000) / (365 * 86400);
}

/** True when fewer than minSec seconds remain (including after expiry). */
export function isExpired(nowMs: number, expiryMs: number, minSec: number): boolean {
  return expiryMs - nowMs < minSec * 1000;
}

/** Whole IST calendar days between today and the expiry date, as "{n}d" (never negative). */
export function dteLabel(nowMs: number, isoDate: string): string {
  const istDay = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
  const dte = istDay(expiryInstantMs(isoDate)) - istDay(nowMs);
  return `${Math.max(0, dte)}d`;
}
