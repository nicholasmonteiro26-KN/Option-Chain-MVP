import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOptionChain, optionChainUrl } from './open-option-chain';

describe('openOptionChain', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens /option-chain for the underlying in a new tab with noopener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openOptionChain({ exch: 'NSE', sym: 'NIFTY' });
    expect(open).toHaveBeenCalledWith('/option-chain?underlying=NSE:NIFTY', '_blank', 'noopener');
  });

  it('adds the expiry when given', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openOptionChain({ exch: 'BSE', sym: 'SENSEX' }, '2027-01-28');
    expect(open).toHaveBeenCalledWith('/option-chain?underlying=BSE:SENSEX&expiry=2027-01-28', '_blank', 'noopener');
  });

  it('encodes symbols with URL-special characters', () => {
    expect(optionChainUrl({ exch: 'NSE', sym: 'M&M' })).toBe('/option-chain?underlying=NSE:M%26M');
  });
});
