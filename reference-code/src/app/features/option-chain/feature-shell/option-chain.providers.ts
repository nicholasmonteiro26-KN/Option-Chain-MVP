import { inject, InjectionToken, isDevMode, Provider } from '@angular/core';
import { AnalyticsBridge } from '../analytics/analytics.bridge';
import { CHAIN_FEED_CLOCK, ChainFeedFacade } from '../data-access/chain-feed.facade';
import { MockFeedTransport } from '../data-access/feed/mock-feed.transport';
import { NorenSocketService } from '../data-access/feed/noren-socket.service';
import { TickBuffer } from '../data-access/feed/tick-buffer';
import { FEED_TRANSPORT } from '../data-access/feed/transport';
import { InstrumentsService } from '../data-access/instruments.service';
import { isNseFoSessionOpen, MARKET_SESSION_RULE, MarketSessionService } from '../data-access/market-session.service';
import { KAMBALA_REST_BASE, KambalaRestApi, KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { NOREN_SESSION_CONFIG, NorenSessionConfig } from '../data-access/kambala/kambala.types';
import { OptionChainStore } from '../data-access/option-chain.store';
import { AuthSessionService, DEV_PROXY_REST_BASE } from '../data-access/auth-session.service';
import { QuickUnderlyingsService } from '../data-access/quick-underlyings.service';
import { PrefsStore } from '../data-access/prefs.store';
import { MockKambalaRestClient } from '../data-access/testing/mock-kambala-rest.client';
import { MockMarket } from '../data-access/testing/mock-market';
import { environment } from '../../../../environments/environment';

const currentSearch = (): string => (typeof window === 'undefined' ? '' : window.location.search);

/** True when the page URL asks for the simulated market (`?feed=mock`). */
export function isMockFeed(search: string = currentSearch()): boolean {
  return new URLSearchParams(search).get('feed') === 'mock';
}

/** Angular dev mode (false in production builds). A token so tests can exercise the production gate. */
export const OPTION_CHAIN_DEV_MODE = new InjectionToken<boolean>('OPTION_CHAIN_DEV_MODE', {
  providedIn: 'root',
  factory: () => isDevMode(),
});

/**
 * Build flag (`environment.allowMockFeed`): true only in the `perf` build configuration, an optimised build used by
 * the Playwright perf test. A token so tests can exercise it.
 */
export const OPTION_CHAIN_ALLOW_MOCK_FEED = new InjectionToken<boolean>('OPTION_CHAIN_ALLOW_MOCK_FEED', {
  providedIn: 'root',
  factory: () => environment.allowMockFeed,
});

/**
 * Simulated market on/off. `?feed=mock` is honoured only in dev builds (and the `perf` build): a production build
 * always uses the real transport and REST client, so a URL can never put a trader on fake prices. Read once, when
 * first injected.
 */
export const OPTION_CHAIN_MOCK_MODE = new InjectionToken<boolean>('OPTION_CHAIN_MOCK_MODE', {
  providedIn: 'root',
  factory: () => (inject(OPTION_CHAIN_DEV_MODE) || inject(OPTION_CHAIN_ALLOW_MOCK_FEED)) && isMockFeed(),
});

// INTEGRATION: provide the signed-in user's id from TradeSmart's auth service (prefs are stored per user).
export const OPTION_CHAIN_USER_ID = new InjectionToken<string>('OPTION_CHAIN_USER_ID', {
  providedIn: 'root',
  factory: () => 'demo',
});

/** Mock-mode tuning from the URL: `mockStrikes` (strikes per chain, default 35) and `mockHz` (ticks/s, default 20). */
function mockParam(name: string, fallback: number): number {
  const v = Number(new URLSearchParams(currentSearch()).get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Everything one option chain page needs. Provided by `OptionChainPageComponent` itself (component providers), so
 * each page instance gets its own store, feed facade, socket / mock feed and analytics worker, and all of them are
 * destroyed with the page.
 */
export function provideOptionChain(): Provider[] {
  return [
    OptionChainStore,
    ChainFeedFacade,
    AnalyticsBridge,
    PrefsStore,
    InstrumentsService,
    MarketSessionService,
    // The simulated market trades around the clock; the real one follows exchange hours.
    { provide: MARKET_SESSION_RULE, useFactory: () => (inject(OPTION_CHAIN_MOCK_MODE) ? () => true : isNseFoSessionOpen) },
    { provide: TickBuffer, useFactory: () => new TickBuffer(inject(CHAIN_FEED_CLOCK)) },
    {
      provide: MockMarket,
      useFactory: () => new MockMarket({ strikesPerChain: mockParam('mockStrikes', 35) }),
    },
    {
      provide: FEED_TRANSPORT,
      useFactory: () => {
        if (!inject(OPTION_CHAIN_MOCK_MODE)) return inject(NorenSocketService);
        const market = inject(MockMarket);
        return new MockFeedTransport({
          seed: (k) => market.seed(k),
          marketTick: (keys, random) => market.tick(keys, random),
          random: market.random,
          tickRateHz: mockParam('mockHz', 20),
        });
      },
    },
    NorenSocketService,
    {
      provide: KambalaRestClient,
      useFactory: (): KambalaRestApi =>
        inject(OPTION_CHAIN_MOCK_MODE)
          ? new MockKambalaRestClient(inject(MockMarket))
          : new KambalaRestClient(),
    },
    // Prefs are stored per user: the signed-in uid with live data (standalone login), 'demo' in mock mode. Read once
    // per page, so a re-login as another user in the same tab gets that user's prefs. See OPTION_CHAIN_USER_ID above:
    // inside TradeSmart's app, take the id from its auth service.
    {
      provide: OPTION_CHAIN_USER_ID,
      useFactory: () => (inject(OPTION_CHAIN_MOCK_MODE) ? 'demo' : inject(AuthSessionService).session()?.uid || 'demo'),
    },
    // Quick-switch underlyings for this page. Live data: tokens are resolved from GetIndexList after login, and the
    // quick keys are not subscribed before that.
    {
      provide: QuickUnderlyingsService,
      useFactory: () => {
        const svc = new QuickUnderlyingsService();
        if (!inject(OPTION_CHAIN_MOCK_MODE)) svc.expectResolution();
        return svc;
      },
    },
    // INTEGRATION: replace with TradeSmart's Kambala REST base URL (full path, e.g. https://host/NorenWClientAPIv2).
    // The standalone app goes through its dev-server proxy (proxy.conf.mjs) at /kambala-api.
    { provide: KAMBALA_REST_BASE, useFactory: () => (inject(OPTION_CHAIN_MOCK_MODE) ? '' : DEV_PROXY_REST_BASE) },
    // INTEGRATION: replace with a getter of the live session from TradeSmart's auth service (uid, actid, WS url and
    // accessToken for a v2 OAuth session, or susertoken for a legacy Noren web session; see NorenSessionConfig). It is
    // read on every connect and REST call: after re-login, refresh it and call facade.reconnect().
    // The standalone app reads AuthSessionService (v2 OAuth via the dev proxy, WS via /kambala-ws).
    {
      provide: NOREN_SESSION_CONFIG,
      useFactory: (): (() => NorenSessionConfig) => {
        if (inject(OPTION_CHAIN_MOCK_MODE)) return () => MOCK_SESSION;
        const auth = inject(AuthSessionService);
        return () => auth.norenConfig();
      },
    },
  ];
}

/** Mock mode's fake session (the simulated market needs none; nothing real is ever sent with it). */
const MOCK_SESSION: NorenSessionConfig = { url: '', uid: 'demo', actid: 'demo', susertoken: '' };
