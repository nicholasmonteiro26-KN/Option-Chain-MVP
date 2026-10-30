// Tiny KEY=VALUE reader for reference-code/.env.local (dev server only; never bundled into the app).
// It never prints values: only key names appear in messages.
import { readFileSync } from 'node:fs';

/** TRADESMART_AUTHORIZE_URL is optional (default: TradeSmart's v2 authorize page, see oauth.mjs). */
export const REQUIRED_KEYS = ['KAMBALA_REST_URL', 'KAMBALA_WS_URL', 'TRADESMART_APP_KEY', 'TRADESMART_SECRET_KEY'];

/** Parses `KEY=VALUE` lines. Blank lines and `#` comments are ignored; surrounding quotes are removed. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Required keys that are absent or empty. */
export function missingKeys(env) {
  return REQUIRED_KEYS.filter((k) => !env[k]);
}

/**
 * Reads the env file. A missing file or key is reported by name (never by value); the returned object is then
 * incomplete, live calls answer with a readable error, and mock mode keeps working.
 */
export function loadEnv(fileUrl, log = (m) => console.warn(m)) {
  let env = {};
  try {
    env = parseEnv(readFileSync(fileUrl, 'utf8'));
  } catch {
    log('[dev-proxy] reference-code/.env.local not found. Live data is off (?feed=mock still works). '
      + 'Copy .env.local.example to .env.local and fill it in.');
    return env;
  }
  const missing = missingKeys(env);
  if (missing.length > 0) {
    log(`[dev-proxy] .env.local is missing or has an empty value for: ${missing.join(', ')}. `
      + 'Live calls that need them will fail with a readable error.');
  }
  return env;
}
