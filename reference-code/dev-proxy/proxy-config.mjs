// The dev-server proxy table, built from the parsed .env.local (see proxy.conf.mjs). A function of `env`, so the
// tests can build it with fake values.
//
//   GET  /auth/start        302 to TradeSmart's OAuth authorize page with client_id=<App Key>   (dev-proxy/oauth.mjs)
//   POST /auth/exchange     {code} -> GenAcsTok with the checksum; answers {stat, access_token, uid?, actid?, emsg?}
//   /kambala-api/*          ${KAMBALA_REST_URL}/*  (changeOrigin). A plain pass-through: the browser's
//                           `Authorization: Bearer <access_token>` header is forwarded unchanged.
//   /kambala-ws             ${KAMBALA_WS_URL}      (WebSocket, changeOrigin, Origin rewritten to the server's own)
//
// /auth/callback is NOT proxied: it is the app's own route (the Redirect URL registered on TradeSmart's dashboard).
// Angular's @angular/build dev server runs on Vite, whose proxy entries accept an async `bypass(req, res)` hook: the
// /auth endpoints are answered inside it (the response is ended before the hook returns a string, so Vite stops there).
import { handleAuthExchange, handleAuthStart, sendNotConfigured } from './oauth.mjs';

/** Used only so the proxy can start when a URL is missing; requests are answered by `bypass` before reaching it. */
const UNCONFIGURED = 'http://127.0.0.1:9';

export function createProxyConfig(env, deps = {}) {
  const REST_URL = (env.KAMBALA_REST_URL ?? '').replace(/\/+$/, '');
  const WS_URL = env.KAMBALA_WS_URL ?? '';

  return {
    '/auth/start': {
      target: UNCONFIGURED,
      bypass(req, res) {
        if (!res) return false;
        handleAuthStart(req, res, env);
        return req.url; // the response is already ended: Vite stops here
      },
    },
    '/auth/exchange': {
      target: UNCONFIGURED,
      async bypass(req, res) {
        if (!res) return false;
        await handleAuthExchange(req, res, env, deps);
        return req.url;
      },
    },
    '/kambala-api/': {
      target: REST_URL || UNCONFIGURED,
      changeOrigin: true,
      secure: true,
      pathRewrite: { '^/kambala-api': '' },
      bypass(req, res) {
        if (!res) return undefined; // WebSocket upgrades never use this entry
        if (!REST_URL) {
          req.resume?.();
          sendNotConfigured(res, ['KAMBALA_REST_URL']);
          return req.url;
        }
        return undefined; // proxy it, headers (Authorization included) untouched
      },
    },
    '/kambala-ws': {
      target: WS_URL || UNCONFIGURED,
      ws: true,
      changeOrigin: true,
      rewriteWsOrigin: true,
      secure: true,
      pathRewrite: { '^/kambala-ws/?': '' },
      bypass(req, res) {
        if (WS_URL) return undefined;
        if (!res) return false; // WebSocket upgrade: answered 404
        sendNotConfigured(res, ['KAMBALA_WS_URL']);
        return req.url;
      },
    },
  };
}
