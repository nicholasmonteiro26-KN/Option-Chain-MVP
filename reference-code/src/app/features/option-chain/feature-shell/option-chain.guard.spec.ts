import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, convertToParamMap, provideRouter, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthSessionService } from '../data-access/auth-session.service';
import { optionChainAuthGuard } from './option-chain.guard';
import { OPTION_CHAIN_ALLOW_MOCK_FEED, OPTION_CHAIN_DEV_MODE } from './option-chain.providers';

function run(opts: { url: string; feed?: string; loggedIn: boolean; dev?: boolean }): boolean | UrlTree {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: OPTION_CHAIN_DEV_MODE, useValue: opts.dev ?? true },
      { provide: OPTION_CHAIN_ALLOW_MOCK_FEED, useValue: false },
      { provide: AuthSessionService, useValue: { isLoggedIn: () => opts.loggedIn } },
    ],
  });
  const route = { queryParamMap: convertToParamMap(opts.feed ? { feed: opts.feed } : {}) } as ActivatedRouteSnapshot;
  const state = { url: opts.url } as RouterStateSnapshot;
  return TestBed.runInInjectionContext(() => optionChainAuthGuard(route, state)) as boolean | UrlTree;
}

describe('optionChainAuthGuard', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('no session and not mock: redirects to /login with the current url as returnUrl', () => {
    const res = run({ url: '/option-chain?underlying=NSE:NIFTY&expiry=2026-11-03', loggedIn: false });
    expect(res).toBeInstanceOf(UrlTree);
    const url = TestBed.inject(Router).serializeUrl(res as UrlTree);
    expect(url.startsWith('/login?returnUrl=')).toBe(true);
    expect((res as UrlTree).queryParams['returnUrl']).toBe('/option-chain?underlying=NSE:NIFTY&expiry=2026-11-03');
  });

  it('mock mode is allowed without a session', () => {
    expect(run({ url: '/option-chain?feed=mock', feed: 'mock', loggedIn: false })).toBe(true);
  });

  it('a production build ignores feed=mock: still needs a session', () => {
    expect(run({ url: '/option-chain?feed=mock', feed: 'mock', loggedIn: false, dev: false })).toBeInstanceOf(UrlTree);
  });

  it('a logged-in user is allowed', () => {
    expect(run({ url: '/option-chain', loggedIn: true })).toBe(true);
  });
});
