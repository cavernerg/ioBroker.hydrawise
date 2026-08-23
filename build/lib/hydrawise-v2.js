"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var hydrawise_v2_exports = {};
__export(hydrawise_v2_exports, {
  HydrawiseV2: () => HydrawiseV2,
  NotAuthorizedError: () => NotAuthorizedError,
  ThrottledError: () => ThrottledError,
  dateStamp: () => dateStamp,
  dateValue: () => dateValue,
  localizedNumber: () => localizedNumber,
  localizedUnit: () => localizedUnit,
  periodBounds: () => periodBounds
});
module.exports = __toCommonJS(hydrawise_v2_exports);
var import_axios = __toESM(require("axios"));
const TOKEN_URL = "https://app.hydrawise.com/api/v2/oauth/access-token";
const GRAPHQL_URL = "https://app.hydrawise.com/api/v2/graph";
const CLIENT_ID = "hydrawise_app";
const CLIENT_SECRET = "zn3CrjglwNV1";
const REQUEST_TIMEOUT = 3e4;
class NotAuthorizedError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotAuthorizedError";
  }
}
class ThrottledError extends Error {
  constructor(message) {
    super(message);
    this.name = "ThrottledError";
  }
}
const DATE_TIME = "{ value timestamp }";
const QUERY_CONTROLLERS = `query Controllers {
    me {
        customerId
        controllers { id name }
    }
}`;
const QUERY_SNAPSHOT = `query Snapshot($cid: Int!) {
    controller(controllerId: $cid) {
        id
        name
        online
        lastContactTime ${DATE_TIME}
        status {
            summary
            online
            accumulatedWaterSavings
            lastContact ${DATE_TIME}
        }
        hardware {
            serialNumber
            version
            status
            model { name }
        }
        observationsSummary {
            currentTemperature { value unit }
            maxTemperatureSinceMidnight { value unit }
            rainfallLast24Hours { value unit }
            rainfallLast168hours { value unit }
        }
        sensors {
            id
            name
            input { number label }
            model {
                id
                name
                sensorType
                flowRate
                divisor
                offLevel
                offTimer
            }
            status {
                active
                waterFlow { value unit longUnit }
            }
        }
        zones {
            id
            name
            number { value }
            status {
                relativeWaterBalance
                suspendedUntil ${DATE_TIME}
            }
            scheduledRuns {
                status
                currentWaterUsage { value unit }
                currentRun {
                    startTime ${DATE_TIME}
                    endTime ${DATE_TIME}
                    duration
                    normalDuration
                    remainingTime
                    status { value label }
                }
                nextRun {
                    startTime ${DATE_TIME}
                    duration
                    normalDuration
                }
            }
        }
    }
}`;
const QUERY_FLOW = `query FlowSummary($cid: Int!, $start: Int!, $end: Int!) {
    controller(controllerId: $cid) {
        sensors {
            id
            name
            input { number }
            model { sensorType }
            flowSummary(start: $start, end: $end) {
                totalWaterVolume { value unit }
            }
        }
    }
}`;
const QUERY_REPORT = `query WateringReport($cid: Int!, $from: Int!, $until: Int!) {
    controller(controllerId: $cid) {
        reports {
            watering(from: $from, until: $until) {
                runEvent {
                    id
                    zone { id }
                    scheduledStartTime ${DATE_TIME}
                    reportedStartTime ${DATE_TIME}
                    reportedEndTime ${DATE_TIME}
                    reportedDuration
                    reportedWaterUsage { value unit }
                    scheduledStatus { value label }
                    reportedStatus { value label }
                    reportedStopReason { finishedNormally description }
                }
            }
        }
    }
}`;
class HydrawiseV2 {
  constructor(email, password, log) {
    this.email = email;
    this.password = password;
    this.log = log;
  }
  token = null;
  tokenType = "Bearer";
  refreshToken = null;
  expires = 0;
  pendingAuth = null;
  /** Forget the current token, e.g. after the credentials have been changed */
  reset() {
    this.token = null;
    this.refreshToken = null;
    this.expires = 0;
  }
  async fetchToken(useRefresh) {
    const data = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });
    if (useRefresh && this.refreshToken) {
      data.set("grant_type", "refresh_token");
      data.set("refresh_token", this.refreshToken);
    } else {
      data.set("grant_type", "password");
      data.set("scope", "all");
      data.set("username", this.email);
      data.set("password", this.password);
    }
    const response = await (0, import_axios.default)({
      method: "POST",
      url: TOKEN_URL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: data.toString(),
      timeout: REQUEST_TIMEOUT,
      responseType: "json",
      validateStatus: () => true
    });
    const body = response.data || {};
    if (body.error || !body.access_token) {
      if (useRefresh) {
        this.log.debug(`refreshing the v2 token failed (${JSON.stringify(body.error)}), logging in again`);
        this.refreshToken = null;
        return this.fetchToken(false);
      }
      this.reset();
      throw new NotAuthorizedError(String(body.message || body.error || `HTTP ${response.status}`));
    }
    this.token = body.access_token;
    this.tokenType = body.token_type || "Bearer";
    this.refreshToken = body.refresh_token || null;
    this.expires = Date.now() + (Number(body.expires_in) || 3600) * 1e3;
    this.log.debug(`v2 token acquired, valid until ${new Date(this.expires).toISOString()}`);
  }
  async ensureToken() {
    var _a;
    if (this.token && this.expires - Date.now() > 5 * 60 * 1e3) {
      return;
    }
    (_a = this.pendingAuth) != null ? _a : this.pendingAuth = (async () => {
      try {
        await this.fetchToken(!!this.refreshToken);
      } finally {
        this.pendingAuth = null;
      }
    })();
    await this.pendingAuth;
  }
  async post(query, variables) {
    return (0, import_axios.default)({
      method: "POST",
      url: GRAPHQL_URL,
      headers: {
        "Content-Type": "application/json",
        Authorization: `${this.tokenType} ${this.token}`
      },
      data: { query, variables },
      timeout: REQUEST_TIMEOUT,
      responseType: "json",
      validateStatus: () => true
    });
  }
  /**
   * Runs a GraphQL query and returns its data section.
   *
   * @param name name of the query, only used for logging
   * @param query the GraphQL query
   * @param variables variables of the query
   */
  async query(name, query, variables = {}) {
    var _a, _b;
    await this.ensureToken();
    let response = await this.post(query, variables);
    if (response.status === 401) {
      this.token = null;
      await this.ensureToken();
      response = await this.post(query, variables);
    }
    if (response.status === 429) {
      throw new ThrottledError(`${name}: too many requests`);
    }
    if (response.status >= 400) {
      throw new Error(`${name}: HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 300)}`);
    }
    const errors = (_a = response.data) == null ? void 0 : _a.errors;
    if (Array.isArray(errors) && errors.length) {
      const message = errors.map((e) => e == null ? void 0 : e.message).join("; ");
      if (/too many requests|rate limit|throttl/i.test(message)) {
        throw new ThrottledError(`${name}: ${message}`);
      }
      throw new Error(`${name}: ${message}`);
    }
    if (!((_b = response.data) == null ? void 0 : _b.data)) {
      throw new Error(`${name}: empty response`);
    }
    return response.data.data;
  }
  /** All controllers of the account */
  async getControllers() {
    var _a;
    const data = await this.query("controllers", QUERY_CONTROLLERS);
    return (((_a = data == null ? void 0 : data.me) == null ? void 0 : _a.controllers) || []).filter((c) => c && typeof c.id === "number");
  }
  /**
   * Controller status, weather observations, sensors and zones in one request
   *
   * @param controllerId the controller to query
   */
  async getSnapshot(controllerId) {
    const data = await this.query("snapshot", QUERY_SNAPSHOT, { cid: controllerId });
    return data == null ? void 0 : data.controller;
  }
  /**
   * Volume through the flow meters between two points in time.
   *
   * @param controllerId the controller to query
   * @param start start of the period, epoch seconds
   * @param end end of the period, epoch seconds
   */
  async getFlowSummary(controllerId, start, end) {
    var _a;
    const data = await this.query("flowSummary", QUERY_FLOW, { cid: controllerId, start, end });
    return ((_a = data == null ? void 0 : data.controller) == null ? void 0 : _a.sensors) || [];
  }
  /**
   * Watering report - one entry per scheduled run, with the values the controller reported back.
   *
   * @param controllerId the controller to query
   * @param from start of the period, epoch seconds
   * @param until end of the period, epoch seconds
   */
  async getReport(controllerId, from, until) {
    var _a, _b;
    const data = await this.query("watering", QUERY_REPORT, { cid: controllerId, from, until });
    return ((_b = (_a = data == null ? void 0 : data.controller) == null ? void 0 : _a.reports) == null ? void 0 : _b.watering) || [];
  }
}
function periodBounds(reference = /* @__PURE__ */ new Date()) {
  const seconds = (d) => Math.floor(d.getTime() / 1e3);
  const todayStart = new Date(reference);
  todayStart.setHours(0, 0, 0, 0);
  const ydayStart = new Date(todayStart);
  ydayStart.setDate(ydayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);
  return {
    todayStart: seconds(todayStart),
    now: seconds(reference),
    ydayStart: seconds(ydayStart),
    ydayEnd: seconds(todayStart) - 1,
    weekStart: seconds(weekStart),
    monthStart: seconds(new Date(reference.getFullYear(), reference.getMonth(), 1)),
    yearStart: seconds(new Date(reference.getFullYear(), 0, 1))
  };
}
function localizedNumber(value, fallback = null) {
  const num = value == null ? void 0 : value.value;
  return typeof num === "number" && !Number.isNaN(num) ? num : fallback;
}
function localizedUnit(value, fallback = "") {
  return (value == null ? void 0 : value.unit) || fallback;
}
function dateValue(date) {
  if (typeof (date == null ? void 0 : date.timestamp) === "number" && date.timestamp > 0) {
    return new Date(date.timestamp * 1e3).toISOString();
  }
  return (date == null ? void 0 : date.value) || null;
}
function dateStamp(date) {
  var _a;
  if (typeof (date == null ? void 0 : date.timestamp) === "number" && date.timestamp > 0) {
    return date.timestamp * 1e3;
  }
  const parsed = Date.parse((_a = date == null ? void 0 : date.value) != null ? _a : "");
  return Number.isNaN(parsed) ? 0 : parsed;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HydrawiseV2,
  NotAuthorizedError,
  ThrottledError,
  dateStamp,
  dateValue,
  localizedNumber,
  localizedUnit,
  periodBounds
});
//# sourceMappingURL=hydrawise-v2.js.map
