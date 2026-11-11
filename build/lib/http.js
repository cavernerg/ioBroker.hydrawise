"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var http_exports = {};
__export(http_exports, {
  HttpError: () => HttpError,
  NetworkError: () => NetworkError,
  requestJson: () => requestJson
});
module.exports = __toCommonJS(http_exports);
class HttpError extends Error {
  /**
   * @param status HTTP status code
   * @param data body of the response
   */
  constructor(status, data) {
    super(`HTTP ${status}`);
    this.status = status;
    this.data = data;
    this.name = "HttpError";
  }
}
class NetworkError extends Error {
  /**
   * @param code error code like ENOTFOUND or TimeoutError, stable enough to compare
   * @param message human readable description
   */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "NetworkError";
  }
}
async function requestJson(url, options) {
  var _a, _b, _c, _d, _e, _f;
  let status;
  let text;
  try {
    const response = await fetch(url, {
      method: (_a = options.method) != null ? _a : "GET",
      headers: options.headers,
      body: options.body,
      redirect: (_b = options.redirect) != null ? _b : "follow",
      signal: AbortSignal.timeout(options.timeout)
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if ((error == null ? void 0 : error.name) === "TimeoutError") {
      throw new NetworkError("TimeoutError", `no answer within ${options.timeout} ms`);
    }
    const code = String((_e = (_d = (_c = error == null ? void 0 : error.cause) == null ? void 0 : _c.code) != null ? _d : error == null ? void 0 : error.name) != null ? _e : "UNKNOWN");
    throw new NetworkError(code, `${(_f = error == null ? void 0 : error.message) != null ? _f : "request failed"} (${code})`);
  }
  if (!text) {
    return { status, data: null };
  }
  try {
    return { status, data: JSON.parse(text) };
  } catch {
    return { status, data: text };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HttpError,
  NetworkError,
  requestJson
});
//# sourceMappingURL=http.js.map
