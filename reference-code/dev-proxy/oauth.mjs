// TradeSmart v2 OAuth for the dev-server proxy (apidocs.tradesmartonline.in/v2).
//
//   GET  /auth/start     302 to TradeSmart's authorize page with client_id=<App Key>. TradeSmart then sends the
//                        browser to the Redirect URL registered on its dashboard (/auth/callback) with ?code=.
//   POST /auth/exchange  {code} from the app. The proxy computes checksum = sha256_hex(App Key + Secret Key + code),
//                        POSTs jData={"code","checksum"} to ${KAMBALA_REST_URL}/GenAcsTok and returns ONLY
//                        {stat, access_token, uid?, actid?, emsg?} to the browser.
//
// The Secret Key is read here and nowhere else: it never reaches the browser or the bundle. Nothing here logs codes,
// checksums, tokens, keys or request/response bodies.
import { createHash } from 'node:crypto';
// The same form encoder as the browser client (raw JSON, & % + as unicode escapes).
import { kambalaFormBody, kambalaJson } from '../src/app/features/option-chain/data-access/kambala/kambala-form.mjs';

export { kambalaFormBody, kambalaJson };

export const DEFAULT_AUTHORIZE_URL = 'https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth';
const MAX_BODY_BYTES = 8 * 1024;
const MAX_CODE_LENGTH = 2048;
/** How long GenAcsTok may take before the exchange gives up. */
export const EXCHANGE_TIMEOUT_MS = 15_000;
const CODE_NOT_ACCEPTED = 'The login code was not accepted (it may have expired or already been used). Please try again.';

/** `<base>?client_id=<appKey>` (an existing query on the base is kept). */
export function buildAuthorizeUrl(appKey, base = DEFAULT_AUTHORIZE_URL) {
  if (!appKey) throw new Error('TRADESMART_APP_KEY is missing');
  const url = new URL(base || DEFAULT_AUTHORIZE_URL);
  url.searchParams.set('client_id', appKey);
  return url.toString();
}

/** sha256_hex(appKey + secretKey + code), concatenated with no separators. */
export function computeChecksum(appKey, secretKey, code) {
  return createHash('sha256').update(`${appKey}${secretKey}${code}`, 'utf8').digest('hex');
}

/** The GenAcsTok body: `jData={"code":..,"checksum":..}`, no jKey. */
export function buildGenAcsTokBody(code, checksum) {
  return kambalaFormBody({ code, checksum });
}

function firstString(o, keys) {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * GenAcsTok's answer, reduced to what the browser needs: `{stat:'Ok', access_token, uid?, actid?}` or
 * `{stat:'Not_Ok', emsg}`. Tolerant of field names (as OpenAlgo is): the token from access_token / accesstoken /
 * token / susertoken; uid from uid / actid / uname; actid from actid / uid. Everything else is dropped. `client_id` is
 * never used as the uid: in OAuth it is the App Key, so the browser falls back to the typed Client ID instead.
 */
export function normaliseTokenResponse(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { stat: 'Not_Ok', emsg: 'Login failed: unexpected answer from the login server' };
  }
  const stat = typeof json.stat === 'string' ? json.stat : '';
  const token = firstString(json, ['access_token', 'accesstoken', 'token', 'susertoken']);
  if (stat.toLowerCase() === 'not_ok' || !token) {
    const emsg = firstString(json, ['emsg'])
      ?? (stat.toLowerCase() === 'ok' ? 'Login failed: no access token returned' : 'Login failed');
    return { stat: 'Not_Ok', emsg };
  }
  const out = { stat: 'Ok', access_token: token };
  const uid = firstString(json, ['uid', 'actid', 'uname']);
  const actid = firstString(json, ['actid', 'uid']);
  if (uid) out.uid = uid;
  if (actid) out.actid = actid;
  return out;
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/** 500 naming the missing keys (never values). */
export function sendNotConfigured(res, keys) {
  sendJson(res, 500, {
    stat: 'Not_Ok',
    emsg: `Dev proxy is not configured: ${keys.join(', ')} missing in reference-code/.env.local`,
  });
}

function missing(env, keys) {
  return keys.filter((k) => !env?.[k]);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Invalid Input : request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** GET /auth/start: 302 to TradeSmart's authorize page. */
export function handleAuthStart(req, res, env) {
  req.resume?.();
  const gone = missing(env, ['TRADESMART_APP_KEY']);
  if (gone.length > 0) {
    sendNotConfigured(res, gone);
    return;
  }
  let location;
  try {
    location = buildAuthorizeUrl(env.TRADESMART_APP_KEY, env.TRADESMART_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL);
  } catch {
    sendJson(res, 500, { stat: 'Not_Ok', emsg: 'Dev proxy is not configured: TRADESMART_AUTHORIZE_URL is not a valid URL' });
    return;
  }
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/** POST /auth/exchange: {code} to GenAcsTok; answers the normalised token response only. */
export async function handleAuthExchange(req, res, env, { fetchImpl = fetch, log = (m) => console.warn(m) } = {}) {
  if (req.method !== 'POST') {
    req.resume?.();
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { stat: 'Not_Ok', emsg: 'Use POST' });
    return;
  }
  const gone = missing(env, ['KAMBALA_REST_URL', 'TRADESMART_APP_KEY', 'TRADESMART_SECRET_KEY']);
  if (gone.length > 0) {
    req.resume?.(); // drain; the body is not read or logged
    sendNotConfigured(res, gone);
    return;
  }

  const contentType = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    req.resume?.();
    sendJson(res, 415, { stat: 'Not_Ok', emsg: 'Unsupported Media Type : send {"code": "..."} as application/json' });
    return;
  }

  let code;
  try {
    const parsed = JSON.parse(await readBody(req));
    code = parsed && typeof parsed === 'object' ? parsed.code : undefined;
  } catch {
    sendJson(res, 400, { stat: 'Not_Ok', emsg: 'Invalid Input : expected a JSON body {"code": "..."}' });
    return;
  }
  if (typeof code !== 'string' || !code.trim() || code.length > MAX_CODE_LENGTH) {
    sendJson(res, 400, { stat: 'Not_Ok', emsg: 'Invalid Input : code is missing' });
    return;
  }
  code = code.trim();

  const checksum = computeChecksum(env.TRADESMART_APP_KEY, env.TRADESMART_SECRET_KEY, code);
  const url = `${String(env.KAMBALA_REST_URL).replace(/\/+$/, '')}/GenAcsTok`;
  let upstream;
  try {
    upstream = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: buildGenAcsTokBody(code, checksum),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      log('[dev-proxy] GenAcsTok: no answer within ' + EXCHANGE_TIMEOUT_MS / 1000 + ' s');
      sendJson(res, 504, {
        stat: 'Not_Ok',
        emsg: `The login server did not answer within ${EXCHANGE_TIMEOUT_MS / 1000} seconds. Check your connection and try again.`,
      });
      return;
    }
    // Only the error's code/class, never the request.
    log(`[dev-proxy] GenAcsTok: could not reach the Kambala REST server (${e?.code ?? e?.cause?.code ?? e?.name ?? 'error'})`);
    sendJson(res, 502, { stat: 'Not_Ok', emsg: 'Could not reach the login server. Check your connection and try again.' });
    return;
  }

  let json;
  try {
    json = JSON.parse(await upstream.text());
  } catch {
    log(`[dev-proxy] GenAcsTok: the server answered HTTP ${upstream.status} with a non-JSON body`);
    sendJson(res, 502, { stat: 'Not_Ok', emsg: `Login failed: unexpected answer from the login server (HTTP ${upstream.status})` });
    return;
  }
  const out = normaliseTokenResponse(json);
  // A Not_Ok emsg is Kambala's own text; make sure it can never carry the checksum or the secret back.
  // GenAcsTok answers an unknown, expired or reused code with "no data": say that in plain words.
  if (out.emsg && /no data/i.test(out.emsg)) out.emsg = CODE_NOT_ACCEPTED;
  if (out.emsg) out.emsg = out.emsg.split(checksum).join('[redacted]').split(env.TRADESMART_SECRET_KEY).join('[redacted]');
  const status = out.stat === 'Ok' ? 200 : upstream.status >= 400 ? upstream.status : 200;
  sendJson(res, status, out);
}
