import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { ThemeToggleComponent } from '../features/option-chain/ui/theme-toggle/theme-toggle.component';
import { AuthSessionService } from '../features/option-chain/data-access/auth-session.service';
import { safeReturnUrl } from './safe-return-url';

export { safeReturnUrl };

/** Shared by /login and /auth/callback. */
export const LOGIN_STYLES = `
  :host { display: block; min-height: 100dvh; background: var(--ts-bg2); color: var(--ts-fg); font-family: var(--ts-font); }
  .wrap { display: flex; justify-content: center; padding: 64px 16px; }
  .card {
    width: 100%; max-width: 380px; box-sizing: border-box; padding: 32px 24px; background: var(--ts-bg);
    border: 1px solid var(--ts-line); border-radius: 12px; display: flex; flex-direction: column; gap: 16px;
  }
  h1 { margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3; }
  .sub { margin: -8px 0 8px; font-size: 14px; color: var(--ts-muted); }
  .field { display: flex; flex-direction: column; gap: 4px; }
  label { font-size: 13px; font-weight: 500; }
  input {
    font: inherit; font-size: 15px; padding: 10px 12px; min-height: 44px; box-sizing: border-box;
    border: 1px solid var(--ts-input-border); border-radius: 4px; background: var(--ts-input-bg); color: var(--ts-input-fg);
  }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--ts-focus); outline-offset: 2px; }
  .corner { position: fixed; top: 12px; right: 12px; z-index: 5; }
  input[aria-invalid='true'] { border-color: var(--ts-red); }
  .hint { margin: 0; font-size: 12px; color: var(--ts-muted); }
  .ferr { margin: 0; font-size: 12px; color: var(--ts-red); }
  .err { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--ts-red-soft); color: var(--ts-fg); font-size: 14px; line-height: 1.5; }
  .primary {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; box-sizing: border-box;
    font: inherit; font-size: 15px; font-weight: 600; border: 0; border-radius: 8px; cursor: pointer; text-decoration: none;
    background: var(--ts-blue); color: var(--ts-on-accent);
  }
  .primary:disabled { opacity: 0.7; cursor: progress; }
  .spinner {
    width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
  .note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--ts-muted); }
`;

/**
 * Standalone login for live data: TradeSmart v2 OAuth. The user types only the Client ID; the password and OTP are
 * entered on TradeSmart's own page. TradeSmart's own app keeps its existing login; this page exists so the reference
 * app can run on real data.
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ThemeToggleComponent],
  // Back from TradeSmart's page (bfcache restore): the button must not stay disabled.
  host: { '(window:pageshow)': 'pending.set(false)' },
  template: `
    <oc-theme-toggle class="corner" />
    <main class="wrap">
      <form class="card" novalidate aria-labelledby="login-title" (submit)="submit($event)">
        <h1 id="login-title">Log in</h1>
        <p class="sub">Option chain with live TradeSmart market data</p>

        <div class="field">
          <label for="login-client-id">Client ID</label>
          <input id="login-client-id" name="clientId" autocomplete="username" autocapitalize="characters" spellcheck="false"
            [value]="clientId()" [attr.aria-invalid]="!!shownError()"
            [attr.aria-describedby]="shownError() ? 'login-client-id-hint login-client-id-err' : 'login-client-id-hint'"
            (input)="onInput($event)" (blur)="onBlur()" />
          <p class="hint" id="login-client-id-hint">Your TradeSmart login ID, e.g. YMUN606</p>
          @if (shownError(); as e) { <p class="ferr" id="login-client-id-err">{{ e }}</p> }
        </div>

        @if (error(); as e) { <p class="err" role="alert" data-testid="login-error">{{ e }}</p> }

        <button type="submit" class="primary" [disabled]="pending()" [attr.aria-busy]="pending()">
          @if (pending()) { <span class="spinner" aria-hidden="true"></span> Opening TradeSmart… } @else { Log in with TradeSmart }
        </button>

        <p class="note">
          You'll sign in on TradeSmart's own page. Your password and OTP are never entered here.
        </p>
        <p class="note">The session is kept in this browser tab and cleared when you close it.</p>
      </form>
    </main>
  `,
  styles: LOGIN_STYLES,
})
export class LoginPageComponent {
  private readonly auth = inject(AuthSessionService);
  private readonly route = inject(ActivatedRoute);

  protected readonly clientId = signal('');
  protected readonly pending = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The "required" message may show after blur or a submit attempt. */
  private readonly touched = signal(false);

  protected shownError(): string | null {
    return this.touched() && !this.clientId().trim() ? 'Enter your Client ID' : null;
  }

  protected onInput(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const upper = input.value.toUpperCase();
    if (input.value !== upper) {
      const pos = input.selectionStart;
      input.value = upper;
      if (pos !== null) input.setSelectionRange(pos, pos);
    }
    this.clientId.set(upper);
    if (upper.trim()) this.touched.set(false);
  }

  protected onBlur(): void {
    if (!this.clientId().trim()) this.touched.set(true);
  }

  protected submit(ev: Event): void {
    ev.preventDefault();
    if (this.pending()) return;
    const clientId = this.clientId().trim().toUpperCase();
    if (!clientId) {
      this.touched.set(true);
      return;
    }
    this.error.set(null);
    const returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
    if (this.auth.beginLogin(clientId, returnUrl)) {
      this.pending.set(true); // the browser is leaving for TradeSmart's login page
    } else {
      this.error.set(
        'This browser blocked session storage, which the login needs. Allow site data for this page and try again.',
      );
    }
  }
}
