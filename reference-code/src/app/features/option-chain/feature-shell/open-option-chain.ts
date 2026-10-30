/** URL of the option chain page for an underlying (and optionally an expiry, 'YYYY-MM-DD'). */
export function optionChainUrl(u: { exch: string; sym: string }, expiryIso?: string): string {
  const underlying = `${encodeURIComponent(u.exch)}:${encodeURIComponent(u.sym)}`;
  return `/option-chain?underlying=${underlying}` + (expiryIso ? `&expiry=${encodeURIComponent(expiryIso)}` : '');
}

/**
 * Opens the option chain for `u` in its own browser tab (spec D17). Each tab is independent and bookmarkable.
 *
 * INTEGRATION: call this from TradeSmart's existing entry points:
 *   - the chart page's "Option Chain" button (pass the charted underlying, e.g. { exch: 'NSE', sym: 'NIFTY' });
 *   - the watchlist row action for an index or F&O stock;
 *   - the scrip context menu ("Option chain").
 *   If the app is served under a base href other than '/', prefix the URL with it.
 */
export function openOptionChain(u: { exch: string; sym: string }, expiryIso?: string): void {
  window.open(optionChainUrl(u, expiryIso), '_blank', 'noopener');
}
