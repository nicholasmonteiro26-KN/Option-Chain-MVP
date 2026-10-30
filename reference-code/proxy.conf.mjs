// Dev-server proxy for live TradeSmart data (`npx ng serve`; wired in angular.json for the development and perf serve
// configurations). Reads reference-code/.env.local, which is git-ignored, once at startup. Never logs values from it,
// request bodies, OAuth codes, checksums or access tokens.
//
// The routes (/auth/start, /auth/exchange, /kambala-api/*, /kambala-ws) are described in dev-proxy/proxy-config.mjs;
// the TradeSmart v2 OAuth logic is in dev-proxy/oauth.mjs. The Secret Key is read only by this Node process.
import { loadEnv } from './dev-proxy/env.mjs';
import { createProxyConfig } from './dev-proxy/proxy-config.mjs';

export default createProxyConfig(loadEnv(new URL('./.env.local', import.meta.url)));
