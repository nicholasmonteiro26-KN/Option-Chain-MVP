import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AuthSessionService, LoginIdentityMismatchError,
} from '../features/option-chain/data-access/auth-session.service';
import { KambalaError } from '../features/option-chain/data-access/kambala/kambala.types';
import { ThemeToggleComponent } from '../features/option-chain/ui/theme-toggle/theme-toggle.component';
import { LOGIN_STYLES } from './login-page.component';
import { safeReturnUrl } from './safe-return-url';

export const CALLBACK_PATH = '/auth/callback';
const DASHBOARD_HINT = 'Check that your static IP and the Redirect URL are registered on the TradeSmart API dashboard.';

/** "Login failed: <emsg>", plus the dashboard hint when Kambala's message is about the IP or the Redirect URL. */
export function loginErrorText(emsg: string): string {
  const base = `Login failed: ${emsg}`;
  return /\bip\b|redirect/i.test(emsg) ? `${base} ${DASHBOARD_HINT}` : base;
}

type State =
  | { kind: 'working' }
  | { kind: 'error'; message: string }
  | { kind: 'no-pending' };

/**
 * /auth/callback: the Redirect URL registered on TradeSmart's API dashboard. TradeSmart sends the browser here with
 * `?code=` after the user signs in. This page drops the code from the address bar at once, exchanges it through the
 * dev proxy (POST /auth/exchange), confirms the token with UserDetails and goes on to the saved returnUrl.
 */
@Component({
  selector: 'app-auth-callback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ThemeToggleComponent],
  template: `
    <oc-theme-toggle class="corner" />
    <main class="wrap">
      <section class="card" aria-labelledby="cb-title">
        @switch (state().kind) {
          @case ('working') {
            <h1 id="cb-title">Logging in…</h1>
            <p class="sub" role="status"><span class="spinner" aria-hidden="true"></span> Finishing your TradeSmart login</p>
          }
          @case ('error') {
            <h1 id="cb-title">Login didn't finish</h1>
            <p class="err" role="alert" data-testid="callback-error">{{ message() }}</p>
            <a class="primary" routerLink="/login" [queryParams]="retryParams()">Try again</a>
          }
          @case ('no-pending') {
            <h1 id="cb-title">No login in progress</h1>
            <p class="err" role="alert" data-testid="callback-error">
              There is no login in progress in this browser tab, so there is nothing to finish here. Start from the
              login page.
            </p>
            <a class="primary" routerLink="/login">Try again</a>
          }
        }
      </section>
    </main>
  `,
  styles: LOGIN_STYLES + `
    .sub { margin: 0; display: inline-flex; align-items: center; gap: 8px; }
  `,
})
export class AuthCallbackComponent implements OnInit {
  private readonly auth = inject(AuthSessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  protected readonly state = signal<State>({ kind: 'working' });
  private returnUrl: string | null = null;

  protected message(): string {
    const s = this.state();
    return s.kind === 'error' ? s.message : '';
  }

  protected retryParams(): Record<string, string> {
    return this.returnUrl ? { returnUrl: this.returnUrl } : {};
  }

  ngOnInit(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    const q = this.route.snapshot.queryParamMap;
    const code = q.get('code')?.trim() ?? '';
    const oauthError = q.get('error_description') || q.get('error') || q.get('emsg');
    // The code is single-use and must not linger in the address bar or history (history.replaceState).
    this.location.replaceState(CALLBACK_PATH);

    const take = this.auth.takePendingLogin();
    const pending = take.status === 'ok' ? take.pending : null;
    if (pending) this.returnUrl = safeReturnUrl(pending.returnUrl);

    if (oauthError) {
      this.state.set({ kind: 'error', message: loginErrorText(oauthError) });
      return;
    }
    if (take.status === 'expired') {
      this.state.set({
        kind: 'error',
        message: 'Login failed: it took more than 10 minutes to come back from TradeSmart, so this login was cancelled. Please try again.',
      });
      return;
    }
    if (!pending) {
      this.state.set({ kind: 'no-pending' });
      return;
    }
    if (!code) {
      this.state.set({ kind: 'error', message: 'Login failed: TradeSmart did not send a login code. Try again.' });
      return;
    }

    try {
      await this.auth.completeLogin(code, pending.clientId);
    } catch (e) {
      this.state.set({
        kind: 'error',
        message: e instanceof LoginIdentityMismatchError
          ? e.message
          : e instanceof KambalaError
          ? loginErrorText(e.message)
          : 'Login failed: could not reach the server. Check your connection and try again.',
      });
      return;
    }
    await this.router.navigateByUrl(this.returnUrl ?? safeReturnUrl(null), { replaceUrl: true });
  }
}
