import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COLUMNS } from '../../columns/column-registry';
import { CustomPreset, MAX_CUSTOM_PRESETS } from '../../data-access/prefs.store';
import { ColumnChooserComponent } from './column-chooser.component';

const preset = (i: number): CustomPreset => ({ id: `p${i}`, name: `View ${i}`, mode: 'mirrored', columns: ['ltp'] });
const SIDE = Object.values(COLUMNS).filter((c) => c.customisable && c.scope === 'side').map((c) => c.id);
const STRIKE = Object.values(COLUMNS).filter((c) => c.customisable && c.scope === 'strike').map((c) => c.id);

describe('ColumnChooserComponent', () => {
  let f: ComponentFixture<ColumnChooserComponent>;
  const el = (): HTMLElement => f.nativeElement as HTMLElement;
  const set = (n: string, v: unknown): void => f.componentRef.setInput(n, v);
  const boxes = (): HTMLInputElement[] => Array.from(el().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  const btn = (t: string): HTMLButtonElement =>
    Array.from(el().querySelectorAll('button')).find((b) => b.textContent!.trim() === t)!;
  const nameInput = (): HTMLInputElement => el().querySelector<HTMLInputElement>('.new input[type="text"]')!;
  beforeEach(() => {
    f = TestBed.createComponent(ColumnChooserComponent);
    set('columns', ['ltp', 'oi']);
    set('presets', []);
    f.detectChanges();
  });

  it('shows heading and help', () => {
    expect(el().textContent).toContain('Choose columns for your Custom view');
    expect(el().textContent).toContain('The put side mirrors the call side. Saved in this browser.');
  });

  it('mirrored mode offers only customisable side columns (no strike-scope)', () => {
    const ids = boxes().map((b) => b.value);
    expect(new Set(ids)).toEqual(new Set(SIDE));
    for (const s of STRIKE) expect(ids).not.toContain(s);
  });

  it('strike mode offers only customisable strike columns', () => {
    btn('Strike columns').click();
    f.detectChanges();
    const ids = boxes().map((b) => b.value);
    expect(new Set(ids)).toEqual(new Set(STRIKE));
    for (const s of SIDE) expect(ids).not.toContain(s);
  });

  it('checked boxes reflect columns and toggling emits columnsChange', () => {
    const spy = vi.fn();
    f.componentInstance.columnsChange.subscribe(spy);
    expect(boxes().filter((b) => b.checked).map((b) => b.value).sort()).toEqual(['ltp', 'oi']);
    boxes().find((b) => b.value === 'ltp')!.click();
    expect(spy).toHaveBeenLastCalledWith(['oi']);
    boxes().find((b) => b.value === 'iv')!.click();
    expect(spy).toHaveBeenLastCalledWith(['ltp', 'oi', 'iv']);
  });

  it('move up/down buttons reorder selected columns', () => {
    const spy = vi.fn();
    f.componentInstance.columnsChange.subscribe(spy);
    (el().querySelector('[aria-label="Move OI up"]') as HTMLElement).click();
    expect(spy).toHaveBeenLastCalledWith(['oi', 'ltp']);
    expect(el().querySelector<HTMLButtonElement>('[aria-label="Move LTP up"]')!.disabled).toBe(true);
    expect(el().querySelector<HTMLButtonElement>('[aria-label="Move OI down"]')!.disabled).toBe(true);
  });

  it('drag-drop reorders via the drop handler', () => {
    const spy = vi.fn();
    f.componentInstance.columnsChange.subscribe(spy);
    (f.componentInstance as unknown as { drop(e: unknown): void }).drop({ previousIndex: 0, currentIndex: 1 });
    expect(spy).toHaveBeenLastCalledWith(['oi', 'ltp']);
  });

  it('Done emits done', () => {
    const spy = vi.fn();
    f.componentInstance.done.subscribe(spy);
    btn('Done').click();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('saves a new preset with name, mode and columns', () => {
    const spy = vi.fn();
    f.componentInstance.savePreset.subscribe(spy);
    nameInput().value = 'Mine';
    nameInput().dispatchEvent(new Event('input'));
    btn('New').click();
    expect(spy).toHaveBeenCalledWith({ name: 'Mine', mode: 'mirrored', columns: ['ltp', 'oi'] });
  });

  it('rejects the 6th custom preset with the limit message', () => {
    set('presets', Array.from({ length: MAX_CUSTOM_PRESETS }, (_, i) => preset(i)));
    f.detectChanges();
    const spy = vi.fn();
    f.componentInstance.savePreset.subscribe(spy);
    nameInput().value = 'Sixth';
    nameInput().dispatchEvent(new Event('input'));
    btn('New').click();
    f.detectChanges();
    expect(spy).not.toHaveBeenCalled();
    expect(el().textContent).toContain('You can save up to 5 custom views.');
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
  });

  it('clears the limit error on the next edit', () => {
    set('presets', Array.from({ length: MAX_CUSTOM_PRESETS }, (_, i) => preset(i)));
    f.detectChanges();
    nameInput().value = 'Sixth';
    nameInput().dispatchEvent(new Event('input'));
    btn('New').click();
    f.detectChanges();
    expect(el().querySelector('[role="alert"]')).not.toBeNull();
    (el().querySelector('[aria-label="Delete View 1"]') as HTMLElement).click();
    f.detectChanges();
    expect(el().querySelector('[role="alert"]')).toBeNull();
  });

  it('lists saved presets with Rename and Delete', () => {
    set('presets', [preset(1), preset(2)]);
    f.detectChanges();
    const ren = vi.fn();
    const del = vi.fn();
    f.componentInstance.renamePreset.subscribe(ren);
    f.componentInstance.deletePreset.subscribe(del);
    expect(el().querySelectorAll('.saved li').length).toBe(2);
    (el().querySelector('[aria-label="Delete View 1"]') as HTMLElement).click();
    expect(del).toHaveBeenCalledWith('p1');
    (el().querySelector('[aria-label="Rename View 2"]') as HTMLElement).click();
    f.detectChanges();
    const rn = el().querySelector<HTMLInputElement>('.saved input[type="text"]')!;
    rn.value = 'Renamed';
    rn.dispatchEvent(new Event('input'));
    btn('Save').click();
    expect(ren).toHaveBeenCalledWith({ id: 'p2', name: 'Renamed' });
  });

  it('applies a saved view from its name button ("Apply <name>") and switches to its mode', () => {
    set('presets', [preset(1), { id: 'p2', name: 'Straddles', mode: 'strike', columns: ['straddle'] }]);
    f.detectChanges();
    const apply = vi.fn();
    f.componentInstance.applyPreset.subscribe(apply);
    const b = el().querySelector<HTMLButtonElement>('[aria-label="Apply Straddles"]')!;
    expect(b.textContent!.trim()).toBe('Straddles');
    b.click();
    f.detectChanges();
    expect(apply).toHaveBeenCalledWith('p2');
    expect(btn('Strike columns').getAttribute('aria-pressed')).toBe('true');
  });
});
