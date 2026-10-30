import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'option-chain' },
  {
    path: 'option-chain',
    loadChildren: () => import('./features/option-chain').then((m) => m.OPTION_CHAIN_ROUTES),
  },
  {
    // Standalone login for live data (TradeSmart v2 OAuth via the dev proxy). INTEGRATION: inside TradeSmart's app,
    // its existing login replaces this route and auth/callback below.
    path: 'login',
    title: 'Log in',
    loadComponent: () => import('./login/login-page.component').then((m) => m.LoginPageComponent),
  },
  {
    // The OAuth Redirect URL registered on TradeSmart's API dashboard (http://localhost:4200/auth/callback).
    path: 'auth/callback',
    title: 'Logging in',
    loadComponent: () => import('./login/auth-callback.component').then((m) => m.AuthCallbackComponent),
  },
];
