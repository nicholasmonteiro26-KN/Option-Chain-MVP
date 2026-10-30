import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'option-chain' },
  {
    path: 'option-chain',
    loadChildren: () => import('./features/option-chain').then((m) => m.OPTION_CHAIN_ROUTES),
  },
];
