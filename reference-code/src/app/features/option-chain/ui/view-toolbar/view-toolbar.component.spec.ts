import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../../columns/presets';
import { ViewToolbarComponent } from './view-toolbar.component';

describe('ViewToolbarComponent', () => {
  let f: ComponentFixture<ViewToolbarComponent>;
  const el = (): HTMLElement => f.nativeElement as HTMLElement;
  const edit = (): HTMLElement | null =>
    Array.from(el().querySelectorAll('button')).find((b) => b.textContent!.includes('Edit columns')) ?? null;
  const setup = (presetId: string, open = false, strikeCount: number | 'all' = 16): void => {
    f.componentRef.setInput('presetId', presetId);
    f.componentRef.setInput('customEditorOpen', open);
    f.componentRef.setInput('strikeCount', strikeCount);
    f.detectChanges();
  };
  beforeEach(() => {
    f = TestBed.createComponent(ViewToolbarComponent);
  });

  it('renders one chip per preset, Custom without an arrow, with aria-pressed', () => {
    setup('greeks');
    const chips = el().querySelectorAll('.chip');
    expect(chips.length).toBe(PRESETS.length);
    expect(chips[chips.length - 1]!.textContent!.trim()).toBe('Custom');
    const pressed = Array.from(chips).filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(pressed.length).toBe(1);
    expect(pressed[0]!.textContent!.trim()).toBe('Greeks');
  });

  it('emits presetChange on chip click', () => {
    setup('default');
    const spy = vi.fn();
    f.componentInstance.presetChange.subscribe(spy);
    (el().querySelectorAll('.chip')[2] as HTMLElement).click();
    expect(spy).toHaveBeenCalledWith('greeks');
  });

  it('has no Edit columns button for greeks', () => {
    setup('greeks');
    expect(edit()).toBeNull();
  });

  it('has Edit columns for custom with the editor closed, and none when open', () => {
    setup('custom', false);
    expect(edit()).not.toBeNull();
    f.componentRef.setInput('customEditorOpen', true);
    f.detectChanges();
    expect(edit()).toBeNull();
  });

  it('emits editColumns', () => {
    setup('custom');
    const spy = vi.fn();
    f.componentInstance.editColumns.subscribe(spy);
    edit()!.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('offers 4/6/8/16/32/40/64/All strikes with a Strikes label and emits numbers or "all"', () => {
    setup('default', false, 16);
    const sel = el().querySelector('select')!;
    expect(Array.from(sel.options).map((o) => o.textContent!.trim())).toEqual(['4', '6', '8', '16', '32', '40', '64', 'All']);
    expect(el().querySelector('label')!.textContent).toContain('Strikes');
    expect(sel.value).toBe('16');
    const spy = vi.fn();
    f.componentInstance.strikeCountChange.subscribe(spy);
    sel.value = '32';
    sel.dispatchEvent(new Event('change'));
    sel.value = 'all';
    sel.dispatchEvent(new Event('change'));
    expect(spy.mock.calls).toEqual([[32], ['all']]);
  });

  it('selects All when strikeCount is all', () => {
    setup('default', false, 'all');
    expect(el().querySelector('select')!.value).toBe('all');
  });

  it('has a CSV button that emits exportCsv', () => {
    setup('default');
    const b = Array.from(el().querySelectorAll('button')).find((x) => x.textContent!.includes('CSV'))!;
    expect(b.textContent!.trim()).toBe('⬇ CSV');
    expect(b.getAttribute('title')).toBe('Export visible rows as CSV');
    const spy = vi.fn();
    f.componentInstance.exportCsv.subscribe(spy);
    b.click();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
