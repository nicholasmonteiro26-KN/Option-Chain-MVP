const DEFAULT_RETURN = '/option-chain';
const ORIGIN = 'http://app.invalid';

/** Only same-app relative paths (starting with one `/`) are followed after login: no open redirects. */
export function safeReturnUrl(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f]/.test(raw)) return DEFAULT_RETURN;
  try {
    if (new URL(raw, ORIGIN).origin !== ORIGIN) return DEFAULT_RETURN;
  } catch {
    return DEFAULT_RETURN;
  }
  if (isAuthPage(raw, '/login') || isAuthPage(raw, '/auth')) return DEFAULT_RETURN;
  return raw;
}

function isAuthPage(raw: string, prefix: string): boolean {
  return raw === prefix || raw.startsWith(`${prefix}?`) || raw.startsWith(`${prefix}/`) || raw.startsWith(`${prefix}#`);
}
