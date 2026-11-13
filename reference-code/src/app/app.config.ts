import { provideHttpClient } from '@angular/common/http';
import {
  ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { ThemeService } from './core/theme.service';
import { provideStandaloneKambalaSession } from './features/option-chain/data-access/auth-session.service';

// Ionic is not wired: the page chrome is plain HTML (ion-content would add a second scroll container around the
// table's own .tbl-wrap). INTEGRATION: inside TradeSmart's Ionic app, host the route under its existing shell.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(),
    // No theme switch on the page: the theme follows TradeSmart (host attribute or ?theme=), else the system.
    provideAppInitializer(() => { inject(ThemeService); }),
    // INTEGRATION: standalone-app login wiring (REST via the dev proxy at /kambala-api, session from AuthSessionService,
    // used by /auth/callback for UserDetails). Inside TradeSmart's app, provide KAMBALA_REST_BASE and
    // NOREN_SESSION_CONFIG from its own config and auth service instead.
    ...provideStandaloneKambalaSession(),
  ],
};
