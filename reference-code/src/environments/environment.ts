/** Build-time settings. `perf` builds swap in `environment.perf.ts` (angular.json `fileReplacements`). */
export const environment = {
  /**
   * Honour `?feed=mock` outside dev mode. Only the `perf` build configuration (an optimised build used by the
   * Playwright perf test) sets this; the `production` build must never let a URL switch on simulated prices.
   */
  allowMockFeed: false,
};
