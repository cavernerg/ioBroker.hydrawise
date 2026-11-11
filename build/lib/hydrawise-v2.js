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
var hydrawise_v2_exports = {};
__export(hydrawise_v2_exports, {
  HydrawiseV2: () => HydrawiseV2,
  NotAuthorizedError: () => NotAuthorizedError,
  ThrottledError: () => ThrottledError,
  dateStamp: () => dateStamp,
  dateValue: () => dateValue,
  inactiveVolume: () => inactiveVolume,
  localizedNumber: () => localizedNumber,
  localizedUnit: () => localizedUnit,
  periodBounds: () => periodBounds,
  periodRange: () => periodRange,
  sumFlow: () => sumFlow,
  summarizeRuns: () => summarizeRuns
});
module.exports = __toCommonJS(hydrawise_v2_exports);
var import_http = require("./http");
const TOKEN_URL = "https://app.hydrawise.com/api/v2/oauth/access-token";
const GRAPHQL_URL = "https://app.hydrawise.com/api/v2/graph";
const CLIENT_ID = "hydrawise_app";
const CLIENT_SECRET = "zn3CrjglwNV1";
const REQUEST_TIMEOUT = 3e4;
class NotAuthorizedError extends Error {
  /**
   * @param message what the API answered
   */
  constructor(message) {
    super(message);
    this.name = "NotAuthorizedError";
  }
}
class ThrottledError extends Error {
  /**
   * @param message what the API answered
   */
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
  /**
   * @param email e-mail address of the Hydrawise account
   * @param password password of the Hydrawise account
   * @param log where to report to
   */
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
    const response = await (0, import_http.requestJson)(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: data.toString(),
      timeout: REQUEST_TIMEOUT,
      // a 307/308 would replay the body - and with it the account password - to
      // whatever host the redirect points at
      redirect: "manual"
    });
    const body = response.data && typeof response.data === "object" ? response.data : {};
    if (body.error || !body.access_token) {
      if (useRefresh) {
        this.log.debug(`refreshing the v2 token failed (${JSON.stringify(body.error)}), logging in again`);
        this.refreshToken = null;
        return this.fetchToken(false);
      }
      if (response.status === 429) {
        throw new ThrottledError("login: too many requests");
      }
      if (![400, 401, 403].includes(response.status) || !body.error) {
        throw new Error(`login: HTTP ${response.status} ${String(body.message || body.error || "")}`.trim());
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
    return (0, import_http.requestJson)(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `${this.tokenType} ${this.token}`
      },
      body: JSON.stringify({ query, variables }),
      timeout: REQUEST_TIMEOUT,
      redirect: "manual"
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
      if (response.status === 401) {
        this.reset();
        throw new NotAuthorizedError(`${name}: the account is not authorized for the v2 API`);
      }
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
function periodRange(period, bounds) {
  switch (period) {
    case "yesterday":
      return [bounds.ydayStart, bounds.ydayEnd];
    case "week":
      return [bounds.weekStart, bounds.now];
    case "month":
      return [bounds.monthStart, bounds.now];
    case "year":
      return [bounds.yearStart, bounds.now];
    default:
      return [bounds.todayStart, bounds.now];
  }
}
function sumFlow(sensors) {
  var _a, _b;
  const summary = { hasFlowSensor: false, hasValue: false, total: 0, unit: "" };
  for (const sensor of sensors) {
    if (((_a = sensor == null ? void 0 : sensor.model) == null ? void 0 : _a.sensorType) !== "FLOW") {
      continue;
    }
    const volume = (_b = sensor.flowSummary) == null ? void 0 : _b.totalWaterVolume;
    const reading = localizedNumber(volume);
    summary.hasFlowSensor = true;
    summary.hasValue = summary.hasValue || reading !== null;
    summary.total += reading != null ? reading : 0;
    summary.unit = summary.unit || localizedUnit(volume);
  }
  summary.total = Math.round(summary.total * 100) / 100;
  return summary;
}
function summarizeRuns(entries) {
  const summary = { active: 0, runtime: 0, unit: "", byZone: /* @__PURE__ */ new Map() };
  for (const entry of entries) {
    const run = entry == null ? void 0 : entry.runEvent;
    if (!(run == null ? void 0 : run.zone)) {
      continue;
    }
    const zone = summary.byZone.get(run.zone.id) || { water: 0, runtime: 0, last: null, latest: null };
    if (!zone.latest || dateStamp(run.scheduledStartTime) >= dateStamp(zone.latest.scheduledStartTime)) {
      zone.latest = run;
    }
    if (run.reportedStartTime) {
      const water = localizedNumber(run.reportedWaterUsage, 0);
      const runtime = Number(run.reportedDuration) || 0;
      summary.active += water;
      summary.runtime += runtime;
      summary.unit = summary.unit || localizedUnit(run.reportedWaterUsage);
      zone.water += water;
      zone.runtime += runtime;
      if (!zone.last || dateStamp(run.reportedEndTime) >= dateStamp(zone.last.reportedEndTime)) {
        zone.last = run;
      }
    }
    summary.byZone.set(run.zone.id, zone);
  }
  summary.active = Math.round(summary.active * 100) / 100;
  for (const zone of summary.byZone.values()) {
    zone.water = Math.round(zone.water * 100) / 100;
  }
  return summary;
}
function inactiveVolume(volume, usage) {
  return volume.total > usage.active ? Math.round((volume.total - usage.active) * 100) / 100 : 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HydrawiseV2,
  NotAuthorizedError,
  ThrottledError,
  dateStamp,
  dateValue,
  inactiveVolume,
  localizedNumber,
  localizedUnit,
  periodBounds,
  periodRange,
  sumFlow,
  summarizeRuns
});
//# sourceMappingURL=hydrawise-v2.js.map
