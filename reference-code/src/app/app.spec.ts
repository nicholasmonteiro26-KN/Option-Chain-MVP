import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    }).compileComponents();
  });

  it('renders only a router outlet', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('router-outlet')).not.toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('redirects the root path to the lazy /option-chain route', () => {
    expect(routes.find((r) => r.path === '')).toMatchObject({ redirectTo: 'option-chain', pathMatch: 'full' });
    expect(typeof routes.find((r) => r.path === 'option-chain')?.loadChildren).toBe('function');
  });
});
