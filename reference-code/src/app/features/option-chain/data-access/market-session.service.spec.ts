import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAIN_FEED_CLOCK, CHAIN_FEED_SCHEDULER } from './chain-feed.facade';
import { OptionChainStore } from './option-chain.store';
import { isFoSessionOpen, isUsDst, MarketSessionService, SESSION_CHECK_MS } from './market-session.service';

const ist = (s: string) => Date.parse(`${s}+05:30`);

describe('isFoSessionOpen: NFO / BFO 09:15-15:40 IST, Mon-Fri', () => {
  afterEach(() => vi.unstubAllEnvs());

  for (const tz of ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati']) {
    it(`boundaries hold whatever the machine time zone (TZ=${tz})`, () => {
      vi.stubEnv('TZ', tz);
      for (const exch of ['NFO', 'BFO']) {
        expect(isFoSessionOpen(ist('2026-10-29T09:14:59'), exch)).toBe(false); // Thursday
        expect(isFoSessionOpen(ist('2026-10-29T09:15:00'), exch)).toBe(true);
        expect(isFoSessionOpen(ist('2026-10-29T15:35:00'), exch)).toBe(true); // closing auction session
        expect(isFoSessionOpen(ist('2026-10-29T15:39:59'), exch)).toBe(true);
        expect(isFoSessionOpen(ist('2026-10-29T15:40:00'), exch)).toBe(false);
        expect(isFoSessionOpen(ist('2026-10-31T11:00:00'), exch)).toBe(false); // Saturday
        expect(isFoSessionOpen(ist('2026-11-01T11:00:00'), exch)).toBe(false); // Sunday
        expect(isFoSessionOpen(ist('2026-11-02T09:15:00'), exch)).toBe(true); // Monday
      }
    });
  }
});

describe('isFoSessionOpen: MCX 09:00 to 23:30 IST (23:55 in US daylight saving time), Mon-Fri', () => {
  it('is open at 16:00 when NSE is shut (crude at 4 pm)', () => {
    expect(isFoSessionOpen(ist('2026-11-13T16:00:00'), 'MCX')).toBe(true);
    expect(isFoSessionOpen(ist('2026-11-13T16:00:00'), 'NFO')).toBe(false);
  });

  it('closes at 23:30 in US winter and 23:55 in US summer', () => {
    expect(isFoSessionOpen(ist('2026-11-13T08:59:59'), 'MCX')).toBe(false);
    expect(isFoSessionOpen(ist('2026-11-13T09:00:00'), 'MCX')).toBe(true);
    expect(isFoSessionOpen(ist('2026-11-13T23:29:59'), 'MCX')).toBe(true); // November: US standard time
    expect(isFoSessionOpen(ist('2026-11-13T23:30:00'), 'MCX')).toBe(false);
    expect(isFoSessionOpen(ist('2026-07-15T23:45:00'), 'MCX')).toBe(true); // July: US daylight time
    expect(isFoSessionOpen(ist('2026-07-15T23:55:00'), 'MCX')).toBe(false);
    expect(isFoSessionOpen(ist('2026-11-14T12:00:00'), 'MCX')).toBe(false); // Saturday
  });

  it('US daylight saving time runs from the 2nd Sunday of March to the 1st Sunday of November', () => {
    expect(isUsDst(Date.parse('2026-03-08T06:59:00Z'))).toBe(false);
    expect(isUsDst(Date.parse('2026-03-08T07:00:00Z'))).toBe(true);
    expect(isUsDst(Date.parse('2026-11-01T05:59:00Z'))).toBe(true);
    expect(isUsDst(Date.parse('2026-11-01T06:00:00Z'))).toBe(false);
  });
});

describe('MarketSessionService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('re-evaluates every 30 s on the injected scheduler and clock', () => {
    let now = ist('2026-10-29T15:39:45');
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
    now = ist('2026-10-29T15:40:15');
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

  it('uses the selected underlying\'s options exchange: at 16:00 an MCX underlying is open, NIFTY is not', () => {
    const underlying = signal<{ foExch: string } | null>({ foExch: 'NFO' });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: CHAIN_FEED_CLOCK, useValue: () => ist('2026-11-13T16:00:00') },
        { provide: CHAIN_FEED_SCHEDULER, useValue: () => () => undefined },
        { provide: OptionChainStore, useValue: { underlying } },
        MarketSessionService,
      ],
    });
    const session = TestBed.inject(MarketSessionService);
    expect(session.exchange()).toBe('NFO');
    expect(session.isOpen()).toBe(false);
    underlying.set({ foExch: 'MCX' });
    expect(session.exchange()).toBe('MCX');
    expect(session.isOpen()).toBe(true);
  });
});
