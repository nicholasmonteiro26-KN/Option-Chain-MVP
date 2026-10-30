import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthSessionService } from '../data-access/auth-session.service';
import { KAMBALA_REST_BASE, KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { NOREN_SESSION_CONFIG } from '../data-access/kambala/kambala.types';
import { QuickUnderlyingsService } from '../data-access/quick-underlyings.service';
import { MockKambalaRestClient } from '../data-access/testing/mock-kambala-rest.client';
import { environment } from '../../../../environments/environment';
import {
  isMockFeed, OPTION_CHAIN_ALLOW_MOCK_FEED, OPTION_CHAIN_DEV_MODE, OPTION_CHAIN_MOCK_MODE, OPTION_CHAIN_USER_ID,
  provideOptionChain,
} from './option-chain.providers';

function withSearch(search: string): void {
  window.history.replaceState(null, '', `/option-chain${search}`);
}

/** `allowMockFeed` undefined: the flag comes from `environment.ts`, as the production build ships it. */
function mockMode(devMode: boolean, allowMockFeed?: boolean): { mock: boolean; rest: unknown } {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      ...provideOptionChain(),
      { provide: OPTION_CHAIN_DEV_MODE, useValue: devMode },
      ...(allowMockFeed === undefined ? [] : [{ provide: OPTION_CHAIN_ALLOW_MOCK_FEED, useValue: allowMockFeed }]),
    ],
  });
  return { mock: TestBed.inject(OPTION_CHAIN_MOCK_MODE), rest: TestBed.inject(KambalaRestClient) };
}

describe('option chain providers: mock-mode gate', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    withSearch('');
  });

  it('isMockFeed reads feed=mock from the query string', () => {
    expect(isMockFeed('?underlying=NSE:NIFTY&feed=mock')).toBe(true);
    expect(isMockFeed('?feed=live')).toBe(false);
    expect(isMockFeed('')).toBe(false);
  });

  it('dev build + ?feed=mock uses the simulated market', () => {
    withSearch('?feed=mock');
    const { mock, rest } = mockMode(true);
    expect(mock).toBe(true);
    expect(rest).toBeInstanceOf(MockKambalaRestClient);
  });

  it('production build ignores ?feed=mock and uses the real REST client', () => {
    withSearch('?feed=mock');
    const { mock, rest } = mockMode(false);
    expect(mock).toBe(false);
    expect(rest).toBeInstanceOf(KambalaRestClient);
  });

  it('dev build without feed=mock uses the real REST client', () => {
    const { mock, rest } = mockMode(true);
    expect(mock).toBe(false);
    expect(rest).toBeInstanceOf(KambalaRestClient);
  });

  it('the default environment (shipped by the production build) does not allow the mock feed', () => {
    expect(environment.allowMockFeed).toBe(false);
  });

  it('production build: an explicit allowMockFeed=false still ignores ?feed=mock', () => {
    withSearch('?feed=mock');
    const { mock, rest } = mockMode(false, false);
    expect(mock).toBe(false);
    expect(rest).toBeInstanceOf(KambalaRestClient);
  });

  it('perf build (optimised, allowMockFeed) + ?feed=mock uses the simulated market', () => {
    withSearch('?feed=mock');
    const { mock, rest } = mockMode(false, true);
    expect(mock).toBe(true);
    expect(rest).toBeInstanceOf(MockKambalaRestClient);
  });

  it('perf build without feed=mock uses the real REST client', () => {
    const { mock, rest } = mockMode(false, true);
    expect(mock).toBe(false);
    expect(rest).toBeInstanceOf(KambalaRestClient);
  });
});

describe('option chain providers: live session wiring', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    withSearch('');
  });

  it('live data: REST goes through the dev proxy and the session getter reads AuthSessionService', () => {
    const norenConfig = () => ({ url: 'ws://h/kambala-ws', uid: 'U', actid: 'A', accessToken: 'T', source: 'API' });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(), ...provideOptionChain(),
        { provide: OPTION_CHAIN_DEV_MODE, useValue: true },
        { provide: AuthSessionService, useValue: { norenConfig } },
      ],
    });
    expect(TestBed.inject(KAMBALA_REST_BASE)).toBe('/kambala-api');
    expect(TestBed.inject(NOREN_SESSION_CONFIG)()).toEqual(norenConfig());
  });

  it('live data: prefs are stored under the signed-in uid ("demo" without a session); mock mode stays "demo"', () => {
    const user = (session: { uid: string } | null, search = '') => {
      TestBed.resetTestingModule();
      withSearch(search);
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(), provideHttpClient(), ...provideOptionChain(),
          { provide: OPTION_CHAIN_DEV_MODE, useValue: true },
          { provide: AuthSessionService, useValue: { session: () => session } },
        ],
      });
      return TestBed.inject(OPTION_CHAIN_USER_ID);
    };
    expect(user({ uid: 'TESTUID' })).toBe('TESTUID');
    expect(user(null)).toBe('demo');
    expect(user({ uid: 'TESTUID' }, '?feed=mock')).toBe('demo');
  });

  it('live data: the quick underlyings wait for GetIndexList; mock mode is ready at once', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), ...provideOptionChain(), { provide: OPTION_CHAIN_DEV_MODE, useValue: true }],
    });
    expect(TestBed.inject(QuickUnderlyingsService).ready()).toBe(false);
    TestBed.resetTestingModule();
    withSearch('?feed=mock');
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), ...provideOptionChain(), { provide: OPTION_CHAIN_DEV_MODE, useValue: true }],
    });
    expect(TestBed.inject(QuickUnderlyingsService).ready()).toBe(true);
  });

  it('mock mode keeps its fake session and needs no REST base', () => {
    withSearch('?feed=mock');
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), ...provideOptionChain(), { provide: OPTION_CHAIN_DEV_MODE, useValue: true }],
    });
    expect(TestBed.inject(KAMBALA_REST_BASE)).toBe('');
    expect(TestBed.inject(NOREN_SESSION_CONFIG)()).toMatchObject({ uid: 'demo', susertoken: '' });
  });
});
