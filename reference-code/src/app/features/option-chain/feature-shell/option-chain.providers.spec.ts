import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { KambalaRestClient } from '../data-access/kambala/kambala-rest.client';
import { MockKambalaRestClient } from '../data-access/testing/mock-kambala-rest.client';
import { environment } from '../../../../environments/environment';
import {
  isMockFeed, OPTION_CHAIN_ALLOW_MOCK_FEED, OPTION_CHAIN_DEV_MODE, OPTION_CHAIN_MOCK_MODE, provideOptionChain,
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
