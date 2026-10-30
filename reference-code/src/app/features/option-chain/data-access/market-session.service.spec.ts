import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from './chain-feed.facade';
import { isNseFoSessionOpen, MarketSessionService, SESSION_CHECK_MS } from './market-session.service';

const ist = (s: string) => Date.parse(`${s}+05:30`);

describe('isNseFoSessionOpen (09:15-15:30 IST, Mon-Fri)', () => {
  afterEach(() => vi.unstubAllEnvs());

  for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati']) {
    it(`boundaries hold whatever the machine time zone (TZ=${tz})`, () => {
      vi.stubEnv('TZ', tz);
      expect(isNseFoSessionOpen(ist('2026-10-29T09:14:59'))).toBe(false); // Thursday
      expect(isNseFoSessionOpen(ist('2026-10-29T09:15:00'))).toBe(true);
      expect(isNseFoSessionOpen(ist('2026-10-29T15:29:59'))).toBe(true);
      expect(isNseFoSessionOpen(ist('2026-10-29T15:30:00'))).toBe(false);
      expect(isNseFoSessionOpen(ist('2026-10-31T11:00:00'))).toBe(false); // Saturday
      expect(isNseFoSessionOpen(ist('2026-11-01T11:00:00'))).toBe(false); // Sunday
      expect(isNseFoSessionOpen(ist('2026-11-02T09:15:00'))).toBe(true); // Monday
    });
  }
});

describe('MarketSessionService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('re-evaluates every 30 s on the injected scheduler and clock', () => {
    let now = ist('2026-10-29T15:29:45');
    const timers: { cb: () => void; ms: number; live: boolean }[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: CHAIN_FEED_CLOCK, useValue: () => now },
        {
          provide: CHAIN_FEED_SCHEDULER,
          useValue: (cb: () => void, ms: number) => {
            const t = { cb, ms, live: true };
            timers.push(t);
            return () => { t.live = false; };
          },
        },
        MarketSessionService,
      ],
    });
    const session = TestBed.inject(MarketSessionService);
    expect(session.isOpen()).toBe(true);
    now = ist('2026-10-29T15:30:15');
    expect(session.isOpen()).toBe(true); // not re-read until the next check
    const t = timers.find((x) => x.live)!;
    expect(t.ms).toBe(SESSION_CHECK_MS);
    t.live = false;
    t.cb();
    expect(session.isOpen()).toBe(false);
    expect(session.nowMs()).toBe(now);
    expect(timers.filter((x) => x.live)).toHaveLength(1); // re-armed
    TestBed.resetTestingModule(); // destroy cancels the pending check
    expect(timers.filter((x) => x.live)).toHaveLength(0);
  });
});
