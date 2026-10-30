import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REDIRECT, AUTH_SESSION_STORAGE, PENDING_LOGIN_KEY,
} from '../features/option-chain/data-access/auth-session.service';
import { LoginPageComponent, safeReturnUrl } from './login-page.component';

// Every Client ID here is FAKE.
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

interface Ctx {
  fixture: ComponentFixture<LoginPageComponent>;
  el: HTMLElement;
  storage: ReturnType<typeof memoryStorage>;
  redirect: ReturnType<typeof vi.fn>;
}

async function setup(query: Record<string, string> = {}, storage: StorageLike | null = memoryStorage()): Promise<Ctx> {
  const redirect = vi.fn(); // stands in for window.location.href = url
  TestBed.configureTestingModule({
    imports: [LoginPageComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
      { provide: AUTH_SESSION_STORAGE, useValue: storage },
      { provide: AUTH_REDIRECT, useValue: redirect },
    ],
  });
  const fixture = TestBed.createComponent(LoginPageComponent);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement, storage: storage as Ctx['storage'], redirect };
}

function inputByLabel(ctx: Ctx, label: string): HTMLInputElement {
  const l = [...ctx.el.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  expect(l, `label "${label}"`).toBeTruthy();
  return ctx.el.querySelector<HTMLInputElement>(`#${l!.htmlFor}`)!;
}

async function type(ctx: Ctx, value: string): Promise<void> {
  const input = inputByLabel(ctx, 'Client ID');
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await ctx.fixture.whenStable();
}

async function submit(ctx: Ctx): Promise<void> {
  ctx.el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await ctx.fixture.whenStable();
}

const pending = (ctx: Ctx) => JSON.parse(ctx.storage.data.get(PENDING_LOGIN_KEY) ?? 'null');

describe('LoginPageComponent (TradeSmart v2 OAuth)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('has a labelled Client ID field with its hint, no password or OTP field, and the TradeSmart note', async () => {
    const ctx = await setup();
    const input = inputByLabel(ctx, 'Client ID');
    expect(input.autocomplete).toBe('username');
    const hint = ctx.el.querySelector(`#${input.getAttribute('aria-describedby')!.split(' ')[0]}`);
    expect(hint?.textContent?.trim()).toBe('Your TradeSmart login ID, e.g. YMUN606');
    expect(ctx.el.querySelector('input[type="password"]')).toBeNull();
    expect(ctx.el.querySelectorAll('input')).toHaveLength(1);
    expect(ctx.el.textContent).not.toMatch(/Password|OTP \/ TOTP/);
    expect(ctx.el.textContent).toContain('You\'ll sign in on TradeSmart\'s own page. Your password and OTP are never entered here.');
    expect(ctx.el.querySelector('button[type="submit"]')!.textContent?.trim()).toBe('Log in with TradeSmart');
  });

  it('upper-cases the Client ID as it is typed', async () => {
    const ctx = await setup();
    await type(ctx, 'ymun606');
    expect(inputByLabel(ctx, 'Client ID').value).toBe('YMUN606');
  });

  it('Log in with TradeSmart stores the pending login {clientId, returnUrl} and goes to /auth/start', async () => {
    const ctx = await setup({ returnUrl: '/option-chain?underlying=BSE:SENSEX' });
    await type(ctx, ' testuid ');
    await submit(ctx);
    expect(pending(ctx)).toEqual({ clientId: 'TESTUID', returnUrl: '/option-chain?underlying=BSE:SENSEX', createdAt: expect.any(Number) });
    expect(ctx.redirect).toHaveBeenCalledWith('/auth/start');
    const btn = ctx.el.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(btn.disabled).toBe(true); // leaving for TradeSmart
  });

  it('asks for the Client ID instead of leaving when it is empty', async () => {
    const ctx = await setup();
    await submit(ctx);
    expect(ctx.redirect).not.toHaveBeenCalled();
    expect(ctx.el.textContent).toContain('Enter your Client ID');
    expect(inputByLabel(ctx, 'Client ID').getAttribute('aria-invalid')).toBe('true');
  });

  it('saves only a safe returnUrl (external ones become /option-chain)', async () => {
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)']) {
      TestBed.resetTestingModule();
      const ctx = await setup({ returnUrl: bad });
      await type(ctx, 'TESTUID');
      await submit(ctx);
      expect(pending(ctx).returnUrl, bad).toBe('/option-chain');
    }
  });

  it('blocked storage: says so plainly and stays on the page', async () => {
    const blocked: StorageLike = {
      getItem: () => null, setItem: () => { throw new Error('SecurityError'); }, removeItem: () => undefined,
    };
    const ctx = await setup({}, blocked);
    await type(ctx, 'TESTUID');
    await submit(ctx);
    expect(ctx.redirect).not.toHaveBeenCalled();
    expect(ctx.el.querySelector('[role="alert"]')?.textContent).toContain('blocked session storage');
  });
});

describe('safeReturnUrl', () => {
  it('accepts same-app paths only', () => {
    expect(safeReturnUrl('/option-chain?underlying=NSE:NIFTY')).toBe('/option-chain?underlying=NSE:NIFTY');
    expect(safeReturnUrl(null)).toBe('/option-chain');
    expect(safeReturnUrl('')).toBe('/option-chain');
    expect(safeReturnUrl('https://evil.com')).toBe('/option-chain');
    expect(safeReturnUrl('//evil.com')).toBe('/option-chain');
    expect(safeReturnUrl('/\\evil.com')).toBe('/option-chain');
    expect(safeReturnUrl('option-chain')).toBe('/option-chain');
    expect(safeReturnUrl('/login?returnUrl=/x')).toBe('/option-chain');
    expect(safeReturnUrl('/auth/callback?code=x')).toBe('/option-chain');
    expect(safeReturnUrl('/auth/start')).toBe('/option-chain');
  });
});
