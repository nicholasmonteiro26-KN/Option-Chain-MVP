import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THEME_MATCH_MEDIA, THEME_STORAGE } from '../../../../core/theme.service';
import { ThemeToggleComponent } from './theme-toggle.component';

describe('ThemeToggleComponent', () => {
  beforeEach(() => {
    document.body.removeAttribute('color-theme');
    document.documentElement.removeAttribute('data-ts-theme-boot');
    TestBed.configureTestingModule({
      providers: [
        { provide: THEME_MATCH_MEDIA, useValue: null },
        { provide: THEME_STORAGE, useValue: null },
      ],
    });
  });
  afterEach(() => document.body.removeAttribute('color-theme'));

  const btn = (el: HTMLElement): HTMLButtonElement => el.querySelector('button')!;

  it('switches its label and title with the theme', () => {
    const f = TestBed.createComponent(ThemeToggleComponent);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(btn(el).getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(btn(el).getAttribute('title')).toBe('Switch to dark theme');
    btn(el).click();
    f.detectChanges();
    expect(document.body.getAttribute('color-theme')).toBe('dark');
    expect(btn(el).getAttribute('aria-label')).toBe('Switch to light theme');
    expect(btn(el).getAttribute('title')).toBe('Switch to light theme');
    btn(el).click();
    f.detectChanges();
    expect(btn(el).getAttribute('aria-label')).toBe('Switch to dark theme');
  });

  it('is hidden when the host controls the theme', () => {
    document.body.setAttribute('color-theme', 'dark');
    const f = TestBed.createComponent(ThemeToggleComponent);
    f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('button')).toBeNull();
  });
});
