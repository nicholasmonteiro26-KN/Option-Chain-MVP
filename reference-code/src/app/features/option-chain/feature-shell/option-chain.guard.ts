import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthSessionService } from '../data-access/auth-session.service';
import { OPTION_CHAIN_ALLOW_MOCK_FEED, OPTION_CHAIN_DEV_MODE } from './option-chain.providers';

/**
 * Live data needs a login: without a session (and outside mock mode) `/option-chain` goes to
 * `/login?returnUrl=<this url>`. Mock mode (`?feed=mock`, dev or perf build only) needs none.
 * INTEGRATION: inside TradeSmart's app, use its own auth guard instead.
 */
export const optionChainAuthGuard: CanActivateFn = (route, state) => {
  const mockAllowed = inject(OPTION_CHAIN_DEV_MODE) || inject(OPTION_CHAIN_ALLOW_MOCK_FEED);
  if (mockAllowed && route.queryParamMap.get('feed') === 'mock') return true;
  if (inject(AuthSessionService).isLoggedIn()) return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
