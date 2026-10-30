// Kambala form bodies, shared by the browser REST client (kambala-rest.client.ts) and the dev-server proxy
// (dev-proxy/quickauth.mjs) so both send exactly the same bytes. Plain JavaScript, no dependencies.
//
// The v2 server wants `jData=<raw JSON>`: a URL-encoded jData is rejected ("jData is not valid json object").
// The form-special characters `&`, `%` and `+` are written inside the JSON as unicode escapes (backslash-u
// 0026, 0025 and 002b), so the body holds none of them, and the JSON is valid and the same whether or not the server
// URL-decodes it.

const FORM_SPECIAL = /[&%+]/g;

/** JSON with `&`, `%` and `+` as unicode escapes (only inside strings: JSON has them nowhere else). */
export function kambalaJson(value) {
  return JSON.stringify(value).replace(FORM_SPECIAL, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * `jData=<json>` plus `&jKey=<token>` when a token is given. The token goes through encodeURIComponent, which
 * leaves the usual token characters (letters, digits, `-._~`) as they are and escapes anything form-special.
 */
export function kambalaFormBody(jData, jKey) {
  const body = `jData=${kambalaJson(jData)}`;
  return jKey === undefined ? body : `${body}&jKey=${encodeURIComponent(jKey)}`;
}
