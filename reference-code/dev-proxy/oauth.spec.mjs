// Unit tests for the dev-server proxy (TradeSmart v2 OAuth). Run with: npm run test:proxy  (node --test dev-proxy/*.spec.mjs)
// Every App Key, Secret Key, code, token and uid here is FAKE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnv, missingKeys, parseEnv, REQUIRED_KEYS } from './env.mjs';
import {
  buildAuthorizeUrl, buildGenAcsTokBody, computeChecksum, DEFAULT_AUTHORIZE_URL, EXCHANGE_TIMEOUT_MS, handleAuthExchange, handleAuthStart,
  kambalaFormBody, kambalaJson, normaliseTokenResponse,
} from './oauth.mjs';
import { createProxyConfig } from './proxy-config.mjs';

const FAKE_APP_KEY = 'FAKEAPPKEY1';
const FAKE_SECRET = 'fake-secret-XYZ-987';
const ENV = {
  KAMBALA_REST_URL: 'https://rest.example.test/NorenWClientAPIv2/',
  KAMBALA_WS_URL: 'wss://ws.example.test/NorenWSAPI/',
  TRADESMART_APP_KEY: FAKE_APP_KEY,
  TRADESMART_SECRET_KEY: FAKE_SECRET,
};
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('computeChecksum', () => {
  it('is sha256_hex(APP_KEY + SECRET_KEY + code), no separators: the docs example ABC + 123 + x1y2z3', () => {
    assert.equal(computeChecksum('ABC', '123', 'x1y2z3'), sha256('ABC123x1y2z3'));
    assert.match(computeChecksum('ABC', '123', 'x1y2z3'), /^[0-9a-f]{64}$/);
  });

  it('differs when any part changes', () => {
    assert.notEqual(computeChecksum('ABC', '123', 'x1y2z3'), computeChecksum('ABC', '123', 'x1y2z4'));
    assert.notEqual(computeChecksum('ABC', '123', 'x1y2z3'), computeChecksum('ABD', '123', 'x1y2z3'));
    assert.notEqual(computeChecksum('ABC', '123', 'x1y2z3'), computeChecksum('ABC', '124', 'x1y2z3'));
  });
});

describe('buildAuthorizeUrl', () => {
  it('defaults to TradeSmart v2 authorize with client_id=<APP_KEY>', () => {
    assert.equal(DEFAULT_AUTHORIZE_URL, 'https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth');
    assert.equal(buildAuthorizeUrl('ABC'), 'https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth?client_id=ABC');
  });

  it('honours a custom base and encodes the key', () => {
    assert.equal(buildAuthorizeUrl('A B&C', 'https://auth.example.test/oauth?x=1'), 'https://auth.example.test/oauth?x=1&client_id=A+B%26C');
  });

  it('rejects a missing key', () => {
    assert.throws(() => buildAuthorizeUrl(''), /TRADESMART_APP_KEY/);
  });
});

describe('buildGenAcsTokBody', () => {
  it('is jData={"code":..,"checksum":..} with no jKey', () => {
    const body = buildGenAcsTokBody('x1y2z3', 'abc123');
    assert.equal(body, 'jData={"code":"x1y2z3","checksum":"abc123"}');
    assert.ok(!body.includes('jKey'));
    assert.deepEqual(JSON.parse(body.slice('jData='.length)), { code: 'x1y2z3', checksum: 'abc123' });
  });

  it('a code with form-special characters stays inside valid JSON', () => {
    const body = buildGenAcsTokBody('a&b+c%', 'ff');
    assert.equal(body.split('&').length, 1);
    assert.deepEqual(JSON.parse(body.slice('jData='.length)), { code: 'a&b+c%', checksum: 'ff' });
  });
});

describe('normaliseTokenResponse', () => {
  it('Ok with access_token, uid and actid', () => {
    assert.deepEqual(normaliseTokenResponse({ stat: 'Ok', access_token: 'T1', uid: 'U1', actid: 'A1', extra: 'x' }), {
      stat: 'Ok', access_token: 'T1', uid: 'U1', actid: 'A1',
    });
  });

  it('accepts the alternate token names accesstoken, token and susertoken', () => {
    for (const k of ['accesstoken', 'token', 'susertoken']) {
      assert.deepEqual(normaliseTokenResponse({ stat: 'Ok', [k]: 'T2' }), { stat: 'Ok', access_token: 'T2' }, k);
    }
  });

  it('uid from uid / actid / uname; actid from actid / uid', () => {
    assert.deepEqual(normaliseTokenResponse({ stat: 'Ok', token: 'T', uname: 'N1' }), { stat: 'Ok', access_token: 'T', uid: 'N1' });
    assert.deepEqual(normaliseTokenResponse({ stat: 'Ok', token: 'T', actid: 'A9' }), { stat: 'Ok', access_token: 'T', uid: 'A9', actid: 'A9' });
    assert.deepEqual(normaliseTokenResponse({ stat: 'Ok', token: 'T', uid: 'U9' }), { stat: 'Ok', access_token: 'T', uid: 'U9', actid: 'U9' });
  });

  it('never takes client_id as the uid: in OAuth it is the App Key (the browser then falls back to the typed Client ID)', () => {
    const out = normaliseTokenResponse({ stat: 'Ok', access_token: 'T', client_id: FAKE_APP_KEY });
    assert.deepEqual(out, { stat: 'Ok', access_token: 'T' });
    assert.ok(!JSON.stringify(out).includes(FAKE_APP_KEY));
    assert.deepEqual(normaliseTokenResponse({ stat: 'Ok', access_token: 'T', client_id: FAKE_APP_KEY, uid: 'U1' }).uid, 'U1');
  });

  it('Not_Ok keeps only stat and emsg', () => {
    assert.deepEqual(normaliseTokenResponse({ stat: 'Not_Ok', emsg: 'Invalid Input : Invalid checksum', request_time: 'x' }), {
      stat: 'Not_Ok', emsg: 'Invalid Input : Invalid checksum',
    });
  });

  it('Ok without a token, or a non-object, is Not_Ok with a readable emsg', () => {
    const noTok = normaliseTokenResponse({ stat: 'Ok', uid: 'U' });
    assert.equal(noTok.stat, 'Not_Ok');
    assert.match(noTok.emsg, /no access token/);
    assert.equal(normaliseTokenResponse(null).stat, 'Not_Ok');
    assert.equal(normaliseTokenResponse('x').stat, 'Not_Ok');
    assert.equal(normaliseTokenResponse({ stat: 'Not_Ok' }).emsg, 'Login failed');
  });
});

describe('kambalaJson / kambalaFormBody (shared with the browser client)', () => {
  it('writes &, % and + as unicode escapes inside the JSON: no form-special characters, still valid JSON', () => {
    const json = kambalaJson({ a: 'M&M', b: '1+1', c: '5%', d: 'x=y' });
    assert.equal(json, '{"a":"M\\u0026M","b":"1\\u002b1","c":"5\\u0025","d":"x=y"}');
    assert.ok(!/[&%+]/.test(json));
    assert.deepEqual(JSON.parse(json), { a: 'M&M', b: '1+1', c: '5%', d: 'x=y' });
    assert.equal(decodeURIComponent(json), json);
  });

  it('builds jData=<json>[&jKey=<token>]', () => {
    assert.equal(kambalaFormBody({ uid: 'U' }), 'jData={"uid":"U"}');
    assert.equal(kambalaFormBody({ uid: 'U' }, 'a&b=c+'), 'jData={"uid":"U"}&jKey=a%26b%3Dc%2B');
  });
});

describe('env parsing', () => {
  it('parses KEY=VALUE, ignores blanks and # comments, handles CRLF and quotes', () => {
    const env = parseEnv('# comment\r\nA=1\r\n\r\n  B = two words \nC="quoted=yes"\nD=\nnot a pair\n');
    assert.deepEqual(env, { A: '1', B: 'two words', C: 'quoted=yes', D: '' });
  });

  it('requires the REST and WS URLs and the TradeSmart App and Secret keys (no vendor code any more)', () => {
    assert.deepEqual(REQUIRED_KEYS, ['KAMBALA_REST_URL', 'KAMBALA_WS_URL', 'TRADESMART_APP_KEY', 'TRADESMART_SECRET_KEY']);
    assert.deepEqual(missingKeys({ KAMBALA_REST_URL: 'x', KAMBALA_WS_URL: '', TRADESMART_APP_KEY: 'k' }), [
      'KAMBALA_WS_URL', 'TRADESMART_SECRET_KEY',
    ]);
  });

  it('loadEnv logs only the missing key names, never values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-env-'));
    const file = join(dir, '.env.local');
    writeFileSync(file, `KAMBALA_REST_URL=https://fake.test\nTRADESMART_APP_KEY=${FAKE_APP_KEY}\nTRADESMART_SECRET_KEY=\n`);
    const logs = [];
    const env = loadEnv(pathToFileURL(file), (m) => logs.push(m));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(env.TRADESMART_APP_KEY, FAKE_APP_KEY);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /KAMBALA_WS_URL, TRADESMART_SECRET_KEY/);
    assert.ok(!logs[0].includes(FAKE_APP_KEY) && !logs[0].includes('fake.test'));
  });
});

// ---- handlers, with a fake request, response and fetch ----

function fakeReq(body, { method = 'POST', url = '/auth/exchange', headers = { 'content-type': 'application/json' } } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.resume = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '', writableEnded: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b = '') { this.body += b; this.writableEnded = true; },
  };
}

describe('handleAuthStart (GET /auth/start)', () => {
  it('302 to the authorize URL with client_id=<APP_KEY>, not cached', () => {
    const res = fakeRes();
    handleAuthStart(fakeReq(undefined, { method: 'GET', url: '/auth/start?x=1' }), res, ENV);
    assert.equal(res.statusCode, 302);
    const loc = new URL(res.headers.location);
    assert.equal(`${loc.origin}${loc.pathname}`, DEFAULT_AUTHORIZE_URL);
    assert.equal(loc.searchParams.get('client_id'), FAKE_APP_KEY);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!res.headers.location.includes(FAKE_SECRET));
    assert.ok(!res.body.includes(FAKE_SECRET));
  });

  it('uses TRADESMART_AUTHORIZE_URL when set', () => {
    const res = fakeRes();
    handleAuthStart(fakeReq(undefined, { method: 'GET', url: '/auth/start' }), res, { ...ENV, TRADESMART_AUTHORIZE_URL: 'https://auth.example.test/go' });
    assert.equal(res.headers.location, `https://auth.example.test/go?client_id=${FAKE_APP_KEY}`);
  });

  it('500 naming the missing key when TRADESMART_APP_KEY is absent', () => {
    const res = fakeRes();
    handleAuthStart(fakeReq(undefined, { method: 'GET', url: '/auth/start' }), res, { ...ENV, TRADESMART_APP_KEY: '' });
    assert.equal(res.statusCode, 500);
    const out = JSON.parse(res.body);
    assert.equal(out.stat, 'Not_Ok');
    assert.match(out.emsg, /TRADESMART_APP_KEY/);
    assert.ok(!out.emsg.includes(FAKE_SECRET));
  });
});

describe('handleAuthExchange (POST /auth/exchange)', () => {
  it('POSTs GenAcsTok with the checksum (text/plain, no jKey) and returns only {stat, access_token, uid, actid}', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({
        stat: 'Ok', access_token: 'FAKE_TOKEN', uid: 'TESTUID', actid: 'TESTUID', checksum: 'echoed?', secret: FAKE_SECRET,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const res = fakeRes();
    await handleAuthExchange(fakeReq(JSON.stringify({ code: 'x1y2z3' })), res, ENV, { fetchImpl, log: () => {} });

    assert.equal(seen.url, 'https://rest.example.test/NorenWClientAPIv2/GenAcsTok');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.headers['Content-Type'], 'text/plain');
    assert.ok(!('Authorization' in seen.init.headers));
    const checksum = sha256(`${FAKE_APP_KEY}${FAKE_SECRET}x1y2z3`);
    assert.equal(seen.init.body, `jData={"code":"x1y2z3","checksum":"${checksum}"}`);
    assert.ok(!seen.init.body.includes('jKey'));

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const out = JSON.parse(res.body);
    assert.deepEqual(out, { stat: 'Ok', access_token: 'FAKE_TOKEN', uid: 'TESTUID', actid: 'TESTUID' });
    assert.ok(!res.body.includes(checksum), 'the checksum never goes back to the browser');
    assert.ok(!res.body.includes(FAKE_SECRET), 'the secret never goes back to the browser');
    assert.ok(!res.body.includes(FAKE_APP_KEY));
  });

  it('passes Kambala\'s Not_Ok emsg (and status) through, never the checksum or the secret', async () => {
    const checksum = sha256(`${FAKE_APP_KEY}${FAKE_SECRET}bad`);
    const fetchImpl = async () => new Response(JSON.stringify({ stat: 'Not_Ok', emsg: `Invalid Input : bad checksum ${checksum}`, secret: FAKE_SECRET }), { status: 400 });
    const res = fakeRes();
    await handleAuthExchange(fakeReq(JSON.stringify({ code: 'bad' })), res, ENV, { fetchImpl, log: () => {} });
    assert.equal(res.statusCode, 400);
    const out = JSON.parse(res.body);
    assert.equal(out.stat, 'Not_Ok');
    assert.match(out.emsg, /Invalid Input/);
    assert.deepEqual(Object.keys(out).sort(), ['emsg', 'stat']);
    assert.ok(!res.body.includes(checksum));
    assert.ok(!res.body.includes(FAKE_SECRET));
  });

  it('500 naming every missing key, without calling the server', async () => {
    let called = false;
    const res = fakeRes();
    await handleAuthExchange(fakeReq('{"code":"c"}'), res, { KAMBALA_REST_URL: 'https://r' }, {
      fetchImpl: async () => { called = true; return new Response('{}'); }, log: () => {},
    });
    assert.equal(called, false);
    assert.equal(res.statusCode, 500);
    const out = JSON.parse(res.body);
    assert.equal(out.stat, 'Not_Ok');
    assert.match(out.emsg, /TRADESMART_APP_KEY/);
    assert.match(out.emsg, /TRADESMART_SECRET_KEY/);
    assert.match(out.emsg, /\.env\.local/);
  });

  it('400 on a missing code or a bad body', async () => {
    for (const body of ['{}', '{"code":""}', 'not json', '{"code":5}']) {
      const res = fakeRes();
      await handleAuthExchange(fakeReq(body), res, ENV, { fetchImpl: async () => new Response('{}'), log: () => {} });
      assert.equal(res.statusCode, 400, body);
      assert.equal(JSON.parse(res.body).stat, 'Not_Ok');
    }
  });

  it('502 when the server cannot be reached or answers non-JSON; logs hold no code, checksum, secret or token', async () => {
    const logs = [];
    const log = (m) => logs.push(m);
    const down = fakeRes();
    await handleAuthExchange(fakeReq('{"code":"SECRETCODE123"}'), down, ENV, { fetchImpl: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }, log });
    assert.equal(down.statusCode, 502);
    assert.match(JSON.parse(down.body).emsg, /reach/);

    const html = fakeRes();
    await handleAuthExchange(fakeReq('{"code":"SECRETCODE123"}'), html, ENV, { fetchImpl: async () => new Response('<html>oops</html>', { status: 200 }), log });
    assert.equal(html.statusCode, 502);
    assert.equal(JSON.parse(html.body).stat, 'Not_Ok');

    const checksum = sha256(`${FAKE_APP_KEY}${FAKE_SECRET}SECRETCODE123`);
    for (const m of logs) {
      for (const s of ['SECRETCODE123', checksum, FAKE_SECRET, FAKE_APP_KEY]) assert.ok(!m.includes(s), 'no secrets in logs');
    }
  });

  it('415 unless the body is application/json (charset allowed), without calling the server', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return new Response('{}'); };
    for (const ct of [undefined, 'text/plain', 'application/x-www-form-urlencoded']) {
      const res = fakeRes();
      await handleAuthExchange(fakeReq('{"code":"c"}', { headers: ct ? { 'content-type': ct } : {} }), res, ENV, { fetchImpl, log: () => {} });
      assert.equal(res.statusCode, 415, String(ct));
      assert.equal(JSON.parse(res.body).stat, 'Not_Ok');
    }
    assert.equal(called, false);
    const ok = fakeRes();
    await handleAuthExchange(fakeReq('{"code":"c"}', { headers: { 'content-type': 'application/json; charset=utf-8' } }), ok, ENV, {
      fetchImpl: async () => new Response('{"stat":"Ok","access_token":"T"}'), log: () => {},
    });
    assert.equal(ok.statusCode, 200);
  });

  it('passes a 15 s timeout signal to the GenAcsTok fetch, and a timeout gets a clear 504 message', async () => {
    let signal;
    await handleAuthExchange(fakeReq('{"code":"c"}'), fakeRes(), ENV, {
      fetchImpl: async (_u, init) => { signal = init.signal; return new Response('{"stat":"Ok","access_token":"T"}'); }, log: () => {},
    });
    assert.ok(signal instanceof AbortSignal);
    assert.equal(EXCHANGE_TIMEOUT_MS, 15000);

    const res = fakeRes();
    const logs = [];
    await handleAuthExchange(fakeReq('{"code":"SECRETCODE123"}'), res, ENV, {
      fetchImpl: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }, log: (m) => logs.push(m),
    });
    assert.equal(res.statusCode, 504);
    assert.match(JSON.parse(res.body).emsg, /did not answer within 15 seconds/);
    assert.ok(logs.every((m) => !m.includes('SECRETCODE123')));
  });

  it('a "no data" answer to the code becomes a plain "code not accepted" message', async () => {
    const res = fakeRes();
    await handleAuthExchange(fakeReq('{"code":"old"}'), res, ENV, {
      fetchImpl: async () => new Response('{"stat":"Not_Ok","emsg":"Error Occurred : 5 \\"no data\\""}'), log: () => {},
    });
    assert.deepEqual(JSON.parse(res.body), {
      stat: 'Not_Ok',
      emsg: 'The login code was not accepted (it may have expired or already been used). Please try again.',
    });
  });

  it('rejects a non-POST', async () => {
    const res = fakeRes();
    await handleAuthExchange(fakeReq(undefined, { method: 'GET' }), res, ENV, { fetchImpl: async () => new Response('{}'), log: () => {} });
    assert.equal(res.statusCode, 405);
  });
});

describe('createProxyConfig', () => {
  it('routes /auth/start and /auth/exchange only: /auth/callback stays an app route', () => {
    const cfg = createProxyConfig(ENV);
    assert.deepEqual(Object.keys(cfg).sort(), ['/auth/exchange', '/auth/start', '/kambala-api/', '/kambala-ws']);
    assert.ok(!'/auth/callback'.startsWith('/auth/start') && !'/auth/callback'.startsWith('/auth/exchange'));
  });

  it('/auth/start through the proxy entry answers 302 with client_id', async () => {
    const res = fakeRes();
    const req = fakeReq(undefined, { method: 'GET', url: '/auth/start' });
    const r = await createProxyConfig(ENV)['/auth/start'].bypass(req, res);
    assert.equal(r, '/auth/start');
    assert.equal(res.statusCode, 302);
    assert.equal(new URL(res.headers.location).searchParams.get('client_id'), FAKE_APP_KEY);
  });

  it('/kambala-api/ is a plain pass-through: no header rewriting, so the browser\'s Authorization header is forwarded', async () => {
    const entry = createProxyConfig(ENV)['/kambala-api/'];
    assert.equal(entry.target, 'https://rest.example.test/NorenWClientAPIv2');
    assert.equal(entry.headers, undefined);
    assert.equal(entry.configure, undefined);
    const req = fakeReq(undefined, { url: '/kambala-api/UserDetails', headers: { authorization: 'Bearer FAKE' } });
    assert.equal(await entry.bypass(req, fakeRes()), undefined, 'proxied');
    assert.equal(req.headers.authorization, 'Bearer FAKE', 'header left untouched');
  });

  it('/kambala-api/ answers 500 naming KAMBALA_REST_URL when it is missing', async () => {
    const res = fakeRes();
    await createProxyConfig({ ...ENV, KAMBALA_REST_URL: '' })['/kambala-api/'].bypass(fakeReq(undefined, { url: '/kambala-api/UserDetails' }), res);
    assert.equal(res.statusCode, 500);
    assert.match(JSON.parse(res.body).emsg, /KAMBALA_REST_URL/);
  });

  it('/kambala-ws is unchanged: WebSocket to KAMBALA_WS_URL with the Origin rewritten', () => {
    const entry = createProxyConfig(ENV)['/kambala-ws'];
    assert.equal(entry.target, ENV.KAMBALA_WS_URL);
    assert.equal(entry.ws, true);
    assert.equal(entry.rewriteWsOrigin, true);
  });
});
