import { Routes } from '@angular/router';
import { OptionChainPageComponent } from './option-chain-page.component';

/**
 * `/option-chain?underlying=<EXCH>:<SYM>[&expiry=<YYYY-MM-DD>][&feed=mock]`, lazy-loaded by the app routes. The
 * feature's providers live on the page component (not the route), so they are destroyed with the page.
 */
export const OPTION_CHAIN_ROUTES: Routes = [
  { path: '', component: OptionChainPageComponent, title: 'Option Chain' },
];
