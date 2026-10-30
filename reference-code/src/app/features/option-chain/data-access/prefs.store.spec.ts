import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MAX_CUSTOM_PRESETS, PrefsStore, PREFS_STORAGE, Prefs } from './prefs.store';

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}
function make(storage: unknown): PrefsStore {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: PREFS_STORAGE, useValue: storage }],
  });
  return TestBed.inject(PrefsStore);
}
const KEY = 'ts.optionChain.prefs.v1:u1';
const DEFAULTS: Prefs = { version: 1, preset: 'default', strikeCount: 16, customPresets: [], numberFormat: 'lakh' };
const cp = (n: number) => ({ id: `c${n}`, name: `V${n}`, mode: 'mirrored' as const, columns: ['ltp'] });

describe('PrefsStore', () => {
  it('missing key gives defaults', () => {
    expect(make(mem()).load('u1')).toEqual(DEFAULTS);
  });
  it('corrupt JSON gives defaults', () => {
    expect(make(mem({ [KEY]: '{nope' })).load('u1')).toEqual(DEFAULTS);
  });
  it('version 0 gives defaults', () => {
    expect(make(mem({ [KEY]: JSON.stringify({ ...DEFAULTS, version: 0, preset: 'greeks' }) })).load('u1')).toEqual(DEFAULTS);
  });
  it('throwing storage gives defaults and save does not throw', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('y'); } };
    const s = make(bad);
    expect(s.load('u1')).toEqual(DEFAULTS);
    expect(() => s.save('u1', DEFAULTS)).not.toThrow();
  });
  it('null storage gives defaults', () => {
    const s = make(null);
    expect(s.load('u1')).toEqual(DEFAULTS);
    expect(() => s.save('u1', DEFAULTS)).not.toThrow();
  });
  it('round-trips per user', () => {
    const st = mem();
    const s = make(st);
    s.save('u1', { ...DEFAULTS, preset: 'greeks', strikeCount: 'all' });
    expect(s.load('u1').preset).toBe('greeks');
    expect(s.load('u1').strikeCount).toBe('all');
    expect(s.load('u2')).toEqual(DEFAULTS);
    expect(st.m.has(KEY)).toBe(true);
  });
  it('round-trips the working Custom view (mode + columns) and drops a malformed one', () => {
    const st = mem();
    const s = make(st);
    s.save('u1', { ...DEFAULTS, preset: 'custom', custom: { mode: 'strike', columns: ['straddle', 'pcrOi'] } });
    expect(s.load('u1').custom).toEqual({ mode: 'strike', columns: ['straddle', 'pcrOi'] });
    st.m.set(KEY, JSON.stringify({ ...DEFAULTS, custom: { mode: 'x', columns: 'oi' } }));
    expect(s.load('u1').custom).toBeUndefined();
    st.m.set(KEY, JSON.stringify({ ...DEFAULTS, custom: { mode: 'mirrored', columns: ['oi', 7, 'iv'] } }));
    expect(s.load('u1').custom).toEqual({ mode: 'mirrored', columns: ['oi', 'iv'] });
  });
  it('rejects a 6th custom preset', () => {
    const s = make(mem());
    for (let i = 0; i < MAX_CUSTOM_PRESETS; i++) expect(s.addCustomPreset('u1', cp(i))).toEqual({ ok: true });
    expect(s.addCustomPreset('u1', cp(9))).toEqual({ ok: false, reason: 'You can save up to 5 custom views.' });
    expect(s.load('u1').customPresets.length).toBe(5);
  });
});
