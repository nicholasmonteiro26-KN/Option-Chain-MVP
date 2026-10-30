/** JSON with `&`, `%` and `+` written as unicode escapes, so it holds no form-special characters. */
export declare function kambalaJson(value: object): string;
/** `jData=<json>` plus `&jKey=<token>` when a token is given. */
export declare function kambalaFormBody(jData: object, jKey?: string): string;
