import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Expiry } from '../../data-access/models';
import { ExpiryStripComponent } from './expiry-strip.component';

const NOW = Date.parse('2026-10-29T10:00:00+05:30');
const exp = (iso: string): Expiry => ({ iso, exd: iso, sampleTsym: 'X', foExch: 'NFO' });
const EXPIRIES = [exp('2026-11-03'), exp('2026-11-10')];
const STATS = {
  atmIv: 0.1234, cumOi: 12_345_678, maxPain: 24900, pcrOi: 1.1, pcrVol: 0.87654,
  forward: 24987.65, forwardSource: 'PARITY_MID' as const,
};

describe('ExpiryStripComponent', () => {
  let f: ComponentFixture<ExpiryStripComponent>;
  const el = (): HTMLElement => f.nativeElement as HTMLElement;
  const set = (n: string, v: unknown): void => f.componentRef.setInput(n, v);
  const stat = (k: string): Element =>
    Array.from(el().querySelectorAll('.stat')).find((s) => s.querySelector('.k')!.textContent!.trim() === k)!;
  const val = (k: string): string => stat(k).querySelector('.v')!.textContent!.trim();
  beforeEach(() => {
    f = TestBed.createComponent(ExpiryStripComponent);
    set('expiries', EXPIRIES);
    set('selected', EXPIRIES[0]);
    set('nowMs', NOW);
    set('stats', STATS);
    set('feedStatus', 'open');
    set('partial', false);
    f.detectChanges();
  });

  it('chips read dteLabel with date title and aria-pressed', () => {
    const chips = el().querySelectorAll('.exp button');
    expect(chips.length).toBe(2);
    expect(chips[0]!.textContent!.trim()).toBe('5d');
    expect(chips[0]!.getAttribute('title')).toBe('03 Nov 2026');
    expect(chips[1]!.getAttribute('title')).toBe('10 Nov 2026');
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(chips[1]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('emits expiryChange on click', () => {
    const spy = vi.fn();
    f.componentInstance.expiryChange.subscribe(spy);
    (el().querySelectorAll('.exp button')[1] as HTMLElement).click();
    expect(spy).toHaveBeenCalledWith(EXPIRIES[1]);
  });

  it('formats the stats', () => {
    expect(val('ATM IV')).toBe('12.34');
    expect(val('Cum OI')).toBe('123 L');
    expect(val('Max Pain')).toBe('24,900');
    expect(val('PCR')).toBe('1.10');
    expect(val('PCR (Vol)')).toBe('0.88');
  });

  it('shows an em dash for null stats', () => {
    set('stats', { ...STATS, atmIv: null, cumOi: null, maxPain: null, pcrOi: null, pcrVol: null });
    f.detectChanges();
    for (const k of ['ATM IV', 'Cum OI', 'Max Pain', 'PCR', 'PCR (Vol)']) expect(val(k)).toBe('—');
  });

  it.each([
    ['PARITY_MID', 'from call/put prices'],
    ['FUTURES', 'from futures'],
    ['PARITY_LTP', 'from last traded prices'],
    ['SPOT_CARRY', 'from spot'],
  ])('ATM IV tooltip for %s', (src, text) => {
    set('stats', { ...STATS, forwardSource: src });
    f.detectChanges();
    expect(stat('ATM IV').getAttribute('title')).toBe(`Forward 24987.7 (${text})`);
  });

  it.each([
    ['open', '', 'Live'],
    ['reconnecting', 'stale', 'Reconnecting'],
    ['closed', 'off', 'Closed'],
    ['connecting', 'off', 'Connecting'],
    ['session-expired', 'err', 'Session expired'],
  ])('feed dot for %s', (status, cls, label) => {
    set('feedStatus', status);
    f.detectChanges();
    const dot = el().querySelector('.dot')!;
    expect(Array.from(dot.classList).filter((c) => c !== 'dot').join(' ')).toBe(cls);
    expect(dot.getAttribute('aria-label')).toContain(label);
  });

  it('shows the Partial chain badge only when partial', () => {
    expect(el().querySelector('.badge')).toBeNull();
    set('partial', true);
    f.detectChanges();
    const b = el().querySelector('.badge')!;
    expect(b.textContent!.trim()).toBe('Partial chain');
    expect(b.getAttribute('title')).toBe('Kambala subscription limit reached. Totals cover subscribed strikes only.');
  });

  it('on a partial chain, Cum OI, Max Pain, PCR and PCR (Vol) say "(subscribed strikes)"; not otherwise', () => {
    const aggs = ['Cum OI', 'Max Pain', 'PCR', 'PCR (Vol)'];
    for (const k of aggs) expect(stat(k).getAttribute('title')).toBeNull();
    set('partial', true);
    f.detectChanges();
    for (const k of aggs) expect(stat(k).getAttribute('title')).toBe(`${k} (subscribed strikes)`);
    expect(stat('ATM IV').getAttribute('title')).not.toContain('subscribed');
  });
});
