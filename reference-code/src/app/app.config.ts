import { provideHttpClient } from '@angular/common/http';
import {
  ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

// Ionic is not wired: the page chrome is plain HTML (ion-content would add a second scroll container around the
// table's own .tbl-wrap). INTEGRATION: inside TradeSmart's Ionic app, host the route under its existing shell.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(),
  ],
};
