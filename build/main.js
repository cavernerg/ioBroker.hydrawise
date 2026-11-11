"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var utils = __toESM(require("@iobroker/adapter-core"));
var import_hydrawise_v2 = require("./lib/hydrawise-v2");
var import_http = require("./lib/http");
const hydrawise_url = "https://api.hydrawise.com";
let nextpollSchedule = null;
let nextpollCustomer = null;
const RATE_LIMIT_PAUSE = 5 * 60 * 1e3;
const RATE_LIMIT_PAUSE_MAX = 30 * 60 * 1e3;
const V2_PERIOD_TASKS = [
  { period: "yesterday", withReport: true },
  { period: "week", withReport: false },
  { period: "month", withReport: false },
  { period: "year", withReport: false }
];
class Hydrawise extends utils.Adapter {
  v2 = null;
  v2Timer = null;
  v2ControllerId = null;
  v2Objects = /* @__PURE__ */ new Set();
  v2Errors = {};
  v2Period = 0;
  v2FirstPoll = true;
  v2Polling = false;
  v2AnySection = false;
  v2Units = {};
  leakSeen = false;
  lastErrorCode = 0;
  unloaded = false;
  blockedUntil = {};
  backoff = {};
  pollIntervalWarned = false;
  /** relay number (as used in the object ids) to the relay id the API wants */
  relays = /* @__PURE__ */ new Map();
  /** one pending reset of `runDefault` per zone */
  resetSwitches = /* @__PURE__ */ new Map();
  /** objects this adapter run has already made sure of, to spare the objects DB */
  knownObjects = /* @__PURE__ */ new Set();
  v2Throttled = false;
  v2Backoff = 0;
  v2PausedUntil = 0;
  constructor(options = {}) {
    super({
      ...options,
      name: "hydrawise"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    void this.setStateChangedAsync("info.connection", false, true);
    if (!this.config.apiKey) {
      this.log.error("No API-Key defined!");
    } else {
      const scheduleInterval = Math.max(15, Number(this.config.apiInterval) || 60) * 1e3;
      const customerInterval = Math.max(5, Number(this.config.customerInterval) || 30) * 60 * 1e3;
      await this.GetStatusSchedule();
      await this.GetCustomerDetails();
      nextpollSchedule = this.setInterval(() => {
        void this.GetStatusSchedule();
      }, scheduleInterval);
      nextpollCustomer = this.setInterval(() => {
        void this.GetCustomerDetails();
      }, customerInterval);
      await this.subscribeStatesAsync("*");
    }
    if (this.config.useV2) {
      await this.startV2();
    }
  }
  async GetStatusSchedule() {
    if (!this.mayRequest("statusschedule.php")) {
      return;
    }
    return new Promise((resolve) => {
      this.buildRequest("statusschedule.php", { api_key: this.config.apiKey }).then(async (response) => {
        if (this.unloaded) {
          resolve();
          return;
        }
        if ((response == null ? void 0 : response.status) === 200) {
          const content = response.data;
          void this.setStateChangedAsync("info.connection", true, true);
          await this.ensureObject("schedule.stopall", {
            type: "state",
            common: {
              name: {
                en: "stop all zones",
                de: "alle Zonen stoppen",
                ru: "\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0432\u0441\u0435 \u0437\u043E\u043D\u044B",
                pt: "parar todas as zonas",
                nl: "stop alle zones",
                fr: "arr\xEAter toutes les zones",
                it: "fermare tutte le zone",
                es: "detener todas las zonas",
                pl: "zatrzymuj\u0105 wszystkie strefy",
                uk: "\u0437\u0443\u043F\u0438\u043D\u0438\u0442\u0438 \u0432\u0441\u0456 \u0437\u043E\u043D\u0438",
                "zh-cn": "\u505C\u6B62\u6240\u6709\u5730\u533A"
              },
              type: "boolean",
              role: "button.stop",
              read: false,
              write: true
            },
            native: {}
          });
          await this.ensureObject("schedule.runall", {
            type: "state",
            common: {
              name: {
                en: "run all zones for x seconds",
                de: "alle Zonen f\xFCr x Sekunden ausf\xFChren",
                ru: "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0432\u0441\u0435 \u0437\u043E\u043D\u044B \u0437\u0430 x \u0441\u0435\u043A\u0443\u043D\u0434\u044B",
                pt: "executar todas as zonas por x segundos",
                nl: "ren alle zones voor x seconden",
                fr: "ex\xE9cuter toutes les zones pendant x secondes",
                it: "eseguire tutte le zone per x secondi",
                es: "ejecutar todas las zonas durante x segundos",
                pl: "wszystkie strefy startuj\u0105 dla x sekundy",
                uk: "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u0438 \u0432\u0441\u0456 \u0437\u043E\u043D\u0438 \u0434\u043B\u044F x \u0441\u0435\u043A\u0443\u043D\u0434",
                "zh-cn": "\u8DD1\u9053\u533A"
              },
              type: "number",
              role: "level",
              unit: "seconds",
              read: true,
              write: true
            },
            native: {}
          });
          await this.ensureObject("schedule.suspendall", {
            type: "state",
            common: {
              name: {
                en: "suspend all zones for x seconds",
                de: "alle Zonen f\xFCr x Sekunden aussetzen",
                ru: "\u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0432\u0441\u0435 \u0437\u043E\u043D\u044B \u0437\u0430 x \u0441\u0435\u043A\u0443\u043D\u0434\u044B",
                pt: "suspender todas as zonas por x segundos",
                nl: "vertaling:",
                fr: "suspendre toutes les zones pendant x secondes",
                it: "sospendere tutte le zone per x secondi",
                es: "suspender todas las zonas durante x segundos",
                pl: "wszystkie strefy zawieszenia dla x sekundy",
                uk: "\u043F\u0440\u0438\u0437\u0443\u043F\u0438\u043D\u0438\u0442\u0438 \u0432\u0441\u0456 \u0437\u043E\u043D\u0438 \u043D\u0430 x \u0441\u0435\u043A\u0443\u043D\u0434",
                "zh-cn": "\u505C\u6B62\u6240\u6709\xD7\u4E8C\u533A"
              },
              type: "number",
              role: "level",
              read: true,
              write: true
            },
            native: {}
          });
          for (let key in content) {
            key = this.name2id(key);
            if (key !== "relays" && key !== "sensors" && key !== "expanders") {
              await this.ensureObject(`schedule.${key}`, {
                type: "state",
                common: {
                  name: key,
                  type: key === "message" ? "string" : "number",
                  role: key === "message" ? "text" : "value",
                  read: true,
                  write: false
                },
                native: {}
              });
              void this.setStateChangedAsync(`schedule.${key}`, content[key], true);
              if (key === "time") {
                await this.ensureObject("schedule.timestr", {
                  type: "state",
                  common: {
                    name: "last api call",
                    type: "string",
                    role: "text",
                    read: true,
                    write: false
                  },
                  native: {}
                });
                const t = new Date(content[key] * 1e3);
                void this.setStateChangedAsync("schedule.timestr", t.toString(), true);
              }
            }
          }
          this.checkPollInterval(Number(content.nextpoll));
          for (const relay of content.relays) {
            if (this.unloaded) {
              break;
            }
            const name = relay.relay;
            await this.ensureObject(`schedule.${relay.relay}`, {
              type: "channel",
              common: {
                name: name.toString()
              },
              native: {}
            });
            this.relays.set(String(relay.relay), relay.relay_id);
            for (let key in relay) {
              key = this.name2id(key);
              await this.ensureObject(`schedule.${relay.relay}.${key}`, {
                type: "state",
                common: {
                  name: key,
                  type: key === "name" || key === "timestr" ? "string" : "number",
                  role: key === "name" || key === "timestr" ? "text" : "value",
                  read: true,
                  write: false
                },
                native: {}
              });
              if (key === "timestr") {
                const t = /* @__PURE__ */ new Date();
                t.setSeconds(t.getSeconds() + relay.time);
                relay[key] = t.toString();
              }
              void this.setStateChangedAsync(`schedule.${relay.relay}.${key}`, relay[key], true);
            }
            await this.ensureObject(`schedule.${relay.relay}.stopZone`, {
              type: "state",
              common: {
                name: {
                  en: "stop zone",
                  de: "Zone stoppen",
                  ru: "\u0437\u043E\u043D\u0430 \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u043A\u0438",
                  pt: "zona de paragem",
                  nl: "stop zone",
                  fr: "zone d ' arr\xEAt",
                  it: "zona di sosta",
                  es: "zona de parada",
                  pl: "strefa stopu",
                  uk: "\u0437\u043E\u043D\u0430 \u0437\u0443\u043F\u0438\u043D\u043A\u0438",
                  "zh-cn": "\u505C\u6B62\u5730\u533A"
                },
                type: "boolean",
                role: "button.stop",
                read: false,
                write: true
              },
              native: {}
            });
            await this.ensureObject(`schedule.${relay.relay}.runZone`, {
              type: "state",
              common: {
                name: {
                  en: "run zone for x seconds",
                  de: "Zone f\xFCr x Sekunden starten",
                  ru: "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0437\u043E\u043D\u0443 \u0437\u0430 x \u0441\u0435\u043A\u0443\u043D\u0434\u044B",
                  pt: "zona de execu\xE7\xE3o por x segundos",
                  nl: "ren zone voor x seconden",
                  fr: "zone de course pour x secondes",
                  it: "zona di corsa per x secondi",
                  es: "zona de ejecuci\xF3n por x segundos",
                  pl: "strefa x sekundy",
                  uk: "\u0437\u043E\u043D\u0430 \u0437\u0430\u043F\u0443\u0441\u043A\u0443 \u0434\u043B\u044F x \u0441\u0435\u043A\u0443\u043D\u0434",
                  "zh-cn": "\xD7\u4E8C\u533A"
                },
                type: "number",
                role: "level",
                read: true,
                write: true
              },
              native: {}
            });
            await this.ensureObject(`schedule.${relay.relay}.suspendZone`, {
              type: "state",
              common: {
                name: {
                  en: "suspend zone for x seconds",
                  de: "Zone f\xFCr x Sekunden aussetzen",
                  ru: "\u043F\u0440\u0438\u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C \u0437\u043E\u043D\u0443 \u043D\u0430 x \u0441\u0435\u043A\u0443\u043D\u0434\u044B",
                  pt: "zona de suspens\xE3o por x segundos",
                  nl: "quality over quantity (qoq) releases vertaling:",
                  fr: "zone de suspension pour x secondes",
                  it: "zona di sospensione per x secondi",
                  es: "zona de suspensi\xF3n por x segundos",
                  pl: "strefa zawies\u0142a na x sekundy",
                  uk: "\u0437\u043E\u043D\u0430 \u043F\u0456\u0434\u0432\u0456\u0441\u043A\u0438 \u0434\u043B\u044F x \u0441\u0435\u043A\u0443\u043D\u0434",
                  "zh-cn": "\u505C\u6B62x\u4E8C\u533A"
                },
                type: "number",
                role: "level",
                read: true,
                write: true
              },
              native: {}
            });
            await this.ensureObject(`schedule.${relay.relay}.runDefault`, {
              type: "state",
              common: {
                name: {
                  en: "run zone for default time",
                  de: "Zone mit Standardlaufzeit starten",
                  ru: "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u0437\u043E\u043D\u0443 \u0434\u043B\u044F \u0432\u0440\u0435\u043C\u0435\u043D\u0438 \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",
                  pt: "fuso de execu\xE7\xE3o para o tempo padr\xE3o",
                  nl: "run zone for default time",
                  fr: "run zone for default time",
                  it: "run zone per il tempo predefinito",
                  es: "zona de ejecuci\xF3n por tiempo predeterminado",
                  pl: "strefa czasu domy\u015Blnego",
                  uk: "\u0437\u043E\u043D\u0430 \u0437\u0430\u043F\u0443\u0441\u043A\u0443 \u0437\u0430 \u0437\u0430\u043C\u043E\u0432\u0447\u0443\u0432\u0430\u043D\u043D\u044F\u043C",
                  "zh-cn": "a. \u6682\u505C\u65F6\u95F4\u533A"
                },
                type: "boolean",
                role: "button.start",
                read: true,
                write: true
              },
              native: {}
            });
          }
          for (const sensor of content.sensors) {
            if (this.unloaded) {
              break;
            }
            await this.ensureObject(`schedule.sensors.${sensor.input}`, {
              type: "channel",
              common: {
                name: "sensors"
              },
              native: {}
            });
            for (let key in sensor) {
              if (key !== "relays") {
                key = this.name2id(key);
                await this.ensureObject(`schedule.sensors.${sensor.input}.${key}`, {
                  type: "state",
                  common: {
                    name: key,
                    type: "number",
                    role: "value",
                    read: true,
                    write: false
                  },
                  native: {}
                });
                void this.setStateChangedAsync(
                  `schedule.sensors.${sensor.input}.${key}`,
                  sensor[key],
                  true
                );
              }
            }
          }
        }
        resolve();
      }).catch((error) => {
        this.handleRequestError("statusschedule.php", error);
        resolve();
      });
    });
  }
  async GetCustomerDetails() {
    if (!this.mayRequest("customerdetails.php")) {
      return;
    }
    return new Promise((resolve) => {
      this.buildRequest("customerdetails.php", { api_key: this.config.apiKey }).then(async (response) => {
        var _a;
        if (this.unloaded) {
          resolve();
          return;
        }
        if ((response == null ? void 0 : response.status) === 200) {
          const content = response.data;
          void this.setStateChangedAsync("info.connection", true, true);
          for (let key in content) {
            if (key !== "controllers") {
              key = this.name2id(key);
              await this.ensureObject(`customer.${key}`, {
                type: "state",
                common: {
                  name: key,
                  type: key === "message" || key === "current_controller" ? "string" : "number",
                  role: key === "message" || key === "current_controller" ? "text" : "value",
                  read: true,
                  write: false
                },
                native: {}
              });
              void this.setStateChangedAsync(`customer.${key}`, content[key], true);
            }
          }
          for (const controller of content.controllers) {
            if (this.unloaded) {
              break;
            }
            await this.ensureObject(`customer.controllers.${controller.name}`, {
              type: "channel",
              common: {
                name: controller.name
              },
              native: {}
            });
            for (let key in controller) {
              key = this.name2id(key);
              await this.ensureObject(`customer.controllers.${controller.name}.${key}`, {
                type: "state",
                common: {
                  name: key,
                  type: key !== "controller_id" ? "string" : "number",
                  role: key !== "controller_id" ? "text" : "value",
                  read: true,
                  write: false
                },
                native: {}
              });
              if (key === "last_contact") {
                const timestamp = Number(controller[key]);
                controller[key] = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1e3).toString() : String((_a = controller[key]) != null ? _a : "");
              }
              void this.setStateChangedAsync(
                `customer.controllers.${controller.name}.${key}`,
                controller[key],
                true
              );
            }
          }
        }
        resolve();
      }).catch((error) => {
        this.handleRequestError("customerdetails.php", error);
        resolve();
      });
    });
  }
  /**
   * Makes sure an object exists - asks the objects DB only once per adapter run.
   *
   * @param id id of the object
   * @param object the object to create when it is missing
   */
  async ensureObject(id, object) {
    if (this.knownObjects.has(id) || this.unloaded) {
      return;
    }
    await this.setObjectNotExistsAsync(id, object);
    this.knownObjects.add(id);
  }
  /**
   * Calls an endpoint of the v1 API. Rejects with an HttpError for every status but 2xx
   * and with a NetworkError when the API did not answer.
   *
   * @param service endpoint of the v1 API
   * @param params query parameters, including the api_key
   */
  async buildRequest(service, params) {
    var _a;
    if (!params.api_key) {
      throw new Error("API key is not configured");
    }
    const url = new URL(`/api/v1/${service}`, hydrawise_url);
    for (const [key, value] of Object.entries(params)) {
      if (value !== void 0 && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    try {
      const response = await (0, import_http.requestJson)(url, { timeout: 3e4 });
      if (response.status < 200 || response.status >= 300) {
        throw new import_http.HttpError(response.status, response.data);
      }
      this.lastErrorCode = 0;
      this.backoff[service] = 0;
      this.blockedUntil[service] = 0;
      return response;
    } catch (error) {
      if (error instanceof import_http.HttpError) {
        this.log.warn(
          `received ${error.status} response from ${service} with content: ${JSON.stringify(error.data)}`
        );
      } else if (error instanceof import_http.NetworkError) {
        if (error.code === this.lastErrorCode) {
          this.log.debug(error.message);
        } else {
          this.log.info(`error ${error.code} from ${service}: ${error.message}`);
          this.lastErrorCode = error.code;
        }
      } else {
        this.log.error((_a = error == null ? void 0 : error.message) != null ? _a : String(error));
      }
      throw error;
    }
  }
  /**
   * Sends a zone command. A command that fails is reported and dropped - it must never
   * surface as an unhandled rejection, which would restart the adapter.
   *
   * @param params action and its parameters
   */
  async sendCommand(params) {
    var _a;
    try {
      await this.buildRequest("setzone.php", { api_key: this.config.apiKey, ...params });
    } catch (error) {
      this.log.warn(`command "${String(params.action)}" was not accepted: ${(_a = error == null ? void 0 : error.message) != null ? _a : String(error)}`);
    }
  }
  /**
   * The id the API uses for a relay, undefined (and a warning) before the first poll knew it
   *
   * @param relay relay number as used in the object ids
   */
  relayId(relay) {
    const id = this.relays.get(relay);
    if (id === void 0) {
      this.log.warn(`zone ${relay} is not known (yet) - command ignored`);
    }
    return id;
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback callback function
   */
  onUnload(callback) {
    try {
      this.unloaded = true;
      this.clearInterval(nextpollSchedule);
      this.clearInterval(nextpollCustomer);
      this.clearInterval(this.v2Timer);
      for (const timer of this.resetSwitches.values()) {
        this.clearTimeout(timer);
      }
      this.resetSwitches.clear();
      callback();
    } catch {
      callback();
    }
  }
  /**
   * Is called if a subscribed state changes
   *
   * @param id id of the state
   * @param state state object
   */
  onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const seconds = Number(state.val);
    const hasSeconds = (typeof state.val === "number" || typeof state.val === "string" && state.val.trim() !== "") && Number.isFinite(seconds) && seconds >= 0;
    const relayOf = (name) => {
      var _a;
      return (_a = id.match(new RegExp(`.*schedule\\.(.*)\\.${name}$`))) == null ? void 0 : _a[1];
    };
    const secondsOf = (name) => {
      if (!hasSeconds) {
        this.log.warn(
          `${name} expects a number of seconds, got ${JSON.stringify(state.val)} - command ignored`
        );
      }
      return hasSeconds;
    };
    if (id.endsWith(".stopall")) {
      void this.sendCommand({ action: "stopall" });
    } else if (id.endsWith(".stopZone")) {
      const relay = relayOf("stopZone");
      const relayId = relay ? this.relayId(relay) : void 0;
      if (relayId !== void 0) {
        void this.sendCommand({ action: "stop", relay_id: relayId });
      }
    } else if (id.endsWith(".runall")) {
      if (secondsOf("runall")) {
        void this.sendCommand({ action: "runall", period_id: 999, custom: Math.trunc(seconds) });
      }
    } else if (id.endsWith(".runZone")) {
      const relay = relayOf("runZone");
      const relayId = relay && secondsOf("runZone") ? this.relayId(relay) : void 0;
      if (relayId !== void 0) {
        void this.sendCommand({
          action: "run",
          period_id: 999,
          custom: Math.trunc(seconds),
          relay_id: relayId
        });
      }
    } else if (id.endsWith(".runDefault")) {
      if (state.val !== null) {
        void this.initRunDefault(id, !!state.val);
      }
    } else if (id.endsWith(".suspendall")) {
      if (secondsOf("suspendall")) {
        void this.sendCommand({
          action: "suspendall",
          period_id: 999,
          custom: Math.trunc(state.ts / 1e3) + Math.trunc(seconds)
        });
      }
    } else if (id.endsWith(".suspendZone")) {
      const relay = relayOf("suspendZone");
      const relayId = relay && secondsOf("suspendZone") ? this.relayId(relay) : void 0;
      if (relayId !== void 0) {
        void this.sendCommand({
          action: "suspend",
          period_id: 999,
          custom: Math.trunc(state.ts / 1e3) + Math.trunc(seconds),
          relay_id: relayId
        });
      }
    }
  }
  /**
   * Runs a zone for its default time, or stops it.
   *
   * @param id id of the `runDefault` state
   * @param run true starts the zone, false stops it
   */
  async initRunDefault(id, run) {
    var _a;
    const relay = id.match(/(.*schedule.*\.)runDefault/);
    if (!relay) {
      return;
    }
    this.clearTimeout(this.resetSwitches.get(id));
    this.resetSwitches.delete(id);
    try {
      if (!run) {
        await this.setStateAsync(`${relay[1]}stopZone`, true, false);
        return;
      }
      const defaultRunTime = await this.getStateAsync(`${relay[1]}run`);
      const seconds = Number(defaultRunTime == null ? void 0 : defaultRunTime.val) || 0;
      if (seconds <= 0) {
        return;
      }
      await this.setStateAsync(`${relay[1]}runZone`, seconds, false);
      this.resetSwitches.set(
        id,
        this.setTimeout(() => {
          this.resetSwitches.delete(id);
          this.setStateAsync(id, false, true).catch(() => {
          });
        }, seconds * 1e3)
      );
    } catch (error) {
      this.log.warn(`runDefault failed: ${(_a = error == null ? void 0 : error.message) != null ? _a : String(error)}`);
    }
  }
  /**
   * False while an endpoint is paused after the API answered with 429.
   *
   * @param service endpoint of the v1 API
   */
  mayRequest(service) {
    const blocked = this.blockedUntil[service] || 0;
    if (Date.now() < blocked) {
      this.log.debug(`skipping ${service}, paused until ${new Date(blocked).toLocaleTimeString()}`);
      return false;
    }
    return true;
  }
  /**
   * Applies a failed request to the rate limit and to the connection state.
   *
   * @param service endpoint of the v1 API
   * @param error the error the request failed with
   */
  handleRequestError(service, error) {
    var _a;
    if (error instanceof import_http.HttpError && error.status === 429) {
      const pause = Math.min(Math.max((this.backoff[service] || 0) * 2, RATE_LIMIT_PAUSE), RATE_LIMIT_PAUSE_MAX);
      this.backoff[service] = pause;
      this.blockedUntil[service] = Date.now() + pause;
      this.log.info(`${service} hit the API rate limit - pausing it for ${Math.round(pause / 6e4)} minutes`);
      return;
    }
    this.log.debug(`(${service}) received error - API is now offline: ${(_a = error == null ? void 0 : error.message) != null ? _a : String(error)}`);
    this.writeFlag("info.connection", false);
  }
  /**
   * The API reports how often it wants to be polled - warn once when we are faster.
   *
   * @param nextpoll seconds the API asks us to wait
   */
  checkPollInterval(nextpoll) {
    const configured = Math.max(15, Number(this.config.apiInterval) || 60);
    if (!nextpoll || this.pollIntervalWarned || configured >= nextpoll) {
      return;
    }
    this.pollIntervalWarned = true;
    this.log.warn(
      `the API asks to be polled every ${nextpoll} seconds, but the adapter polls every ${configured} seconds`
    );
  }
  /* ------------------------------------------------------------------ *
   *  Hydrawise v2 API (OAuth2 + GraphQL)                               *
   *                                                                    *
   *  The v1 REST API only reports the sensor configuration. Water       *
   *  usage, sensor states, per zone reports and rainfall observations   *
   *  are only available through the v2 API the Hydrawise app uses.      *
   * ------------------------------------------------------------------ */
  /** Creates the v2 client and starts its polling timer */
  async startV2() {
    if (!this.config.email || !this.config.password) {
      this.log.error("The v2 API is enabled but no e-mail/password is configured!");
      return;
    }
    this.v2 = new import_hydrawise_v2.HydrawiseV2(this.config.email, this.config.password, {
      debug: (message) => this.log.debug(`(v2) ${message}`),
      info: (message) => this.log.info(`(v2) ${message}`),
      warn: (message) => this.log.warn(`(v2) ${message}`),
      error: (message) => this.log.error(`(v2) ${message}`)
    });
    this.writeFlag("info.connectionV2", false);
    const minutes = Math.max(2, Number(this.config.v2Interval) || 5);
    await this.pollV2();
    if (!this.v2) {
      return;
    }
    this.v2Timer = this.setInterval(
      () => {
        void this.pollV2();
      },
      minutes * 60 * 1e3
    );
    this.log.info(`v2 API enabled - polling every ${minutes} minutes`);
  }
  /**
   * Stops polling the v2 API, e.g. after the credentials turned out to be wrong
   *
   * @param reason why polling was stopped, ends up in the log
   */
  stopV2(reason) {
    this.clearInterval(this.v2Timer);
    this.v2Timer = null;
    this.v2 = null;
    this.writeFlag("info.connectionV2", false);
    this.log.error(`(v2) polling stopped: ${reason}`);
  }
  /** One poll cycle - every query is applied on its own so a single failure is not fatal */
  async pollV2() {
    if (!this.v2 || this.unloaded || this.v2Polling) {
      return;
    }
    if (Date.now() < this.v2PausedUntil) {
      this.log.debug(`(v2) paused until ${new Date(this.v2PausedUntil).toLocaleTimeString()}`);
      return;
    }
    this.v2Polling = true;
    this.v2AnySection = false;
    this.v2Throttled = false;
    try {
      const controllerId = await this.resolveV2Controller();
      if (controllerId === null) {
        return;
      }
      const bounds = (0, import_hydrawise_v2.periodBounds)();
      const snapshot = await this.v2Section("snapshot", () => this.v2.getSnapshot(controllerId));
      let zones = null;
      if (snapshot) {
        await this.applyV2Status(snapshot);
        if (this.config.v2Weather) {
          await this.applyV2Observations(snapshot.observationsSummary);
        }
        await this.applyV2Sensors(snapshot.sensors || []);
        zones = await this.applyV2Zones(snapshot.zones || []);
      }
      const flow = await this.v2Section(
        "flow today",
        () => this.v2.getFlowSummary(controllerId, bounds.todayStart, bounds.now)
      );
      const report = await this.v2Section(
        "report today",
        () => this.v2.getReport(controllerId, bounds.todayStart, bounds.now)
      );
      const volume = flow ? (0, import_hydrawise_v2.sumFlow)(flow) : null;
      const usage = report ? (0, import_hydrawise_v2.summarizeRuns)(report) : null;
      await this.applyV2Usage("today", volume, usage);
      await this.applyV2ZoneUsage(zones, usage, (usage == null ? void 0 : usage.unit) || (volume == null ? void 0 : volume.unit) || "l");
      await this.applyV2Leak(volume, usage, zones);
      await this.pollV2Periods(controllerId, bounds);
      this.writeFlag("info.connectionV2", this.v2AnySection);
      if (this.v2AnySection) {
        await this.setV2State(
          "water.lastUpdate",
          { name: "last v2 update", type: "string", role: "date" },
          (/* @__PURE__ */ new Date()).toISOString()
        );
      } else {
        this.log.debug("(v2) no query of this poll returned data");
      }
    } catch (error) {
      if (error instanceof import_hydrawise_v2.NotAuthorizedError) {
        this.stopV2(`login failed - check e-mail and password (${error.message})`);
        return;
      }
      if (error instanceof import_hydrawise_v2.ThrottledError) {
        this.v2Throttled = true;
      } else {
        this.writeFlag("info.connectionV2", false);
        this.log.warn(`(v2) poll failed: ${error.message}`);
      }
    } finally {
      this.v2Polling = false;
      this.applyV2Throttle();
    }
  }
  /** After a rate limited poll the v2 API is left alone for a while, longer on every repeat */
  applyV2Throttle() {
    if (!this.v2Throttled) {
      this.v2Backoff = 0;
      return;
    }
    this.v2Backoff = Math.min(Math.max(this.v2Backoff * 2, 2 * RATE_LIMIT_PAUSE), 2 * RATE_LIMIT_PAUSE_MAX);
    this.v2PausedUntil = Date.now() + this.v2Backoff - 5e3;
    this.log.info(`(v2) hit the API rate limit - pausing for ${Math.round(this.v2Backoff / 6e4)} minutes`);
  }
  /**
   * Yesterday, week, month and year in turn. A parameterized field must not appear twice
   * in one query, so each period needs its own request - fetching them all on every poll
   * would be wasteful, but the first poll fills them all in once.
   *
   * @param controllerId the controller to query
   * @param bounds start/end of the reporting periods
   */
  async pollV2Periods(controllerId, bounds) {
    const tasks = this.v2FirstPoll ? V2_PERIOD_TASKS : [V2_PERIOD_TASKS[this.v2Period++ % V2_PERIOD_TASKS.length]];
    this.v2FirstPoll = false;
    for (const task of tasks) {
      if (this.unloaded) {
        return;
      }
      const [from, until] = (0, import_hydrawise_v2.periodRange)(task.period, bounds);
      const sensors = await this.v2Section(
        `flow ${task.period}`,
        () => this.v2.getFlowSummary(controllerId, from, until)
      );
      const entries = task.withReport ? await this.v2Section(`report ${task.period}`, () => this.v2.getReport(controllerId, from, until)) : null;
      await this.applyV2Usage(
        task.period,
        sensors ? (0, import_hydrawise_v2.sumFlow)(sensors) : null,
        entries ? (0, import_hydrawise_v2.summarizeRuns)(entries) : null
      );
    }
  }
  /**
   * Runs one query and keeps the adapter alive when only this query fails
   *
   * @param name label of the query, used in the warning when it fails
   * @param run the query to run
   */
  async v2Section(name, run) {
    if (this.v2Throttled) {
      return null;
    }
    try {
      const result = await run();
      this.v2Errors[name] = 0;
      this.v2AnySection = true;
      return result;
    } catch (error) {
      if (error instanceof import_hydrawise_v2.NotAuthorizedError) {
        throw error;
      }
      const count = this.v2Errors[name] = (this.v2Errors[name] || 0) + 1;
      if (error instanceof import_hydrawise_v2.ThrottledError) {
        this.v2Throttled = true;
        this.log.debug(`(v2) ${error.message}`);
      } else if (count <= 3) {
        this.log.warn(`(v2) query "${name}" failed: ${error.message}`);
      } else {
        this.log.debug(`(v2) query "${name}" failed (${count}x): ${error.message}`);
      }
      return null;
    }
  }
  /**
   * Fire-and-forget write of a connection flag. Stays quiet once the adapter is shutting
   * down, otherwise the states DB is already closed when the promise resolves.
   *
   * @param id id of the state
   * @param value value to write
   */
  writeFlag(id, value) {
    if (this.unloaded) {
      return;
    }
    this.setStateChangedAsync(id, value, true).catch(() => {
    });
  }
  /** Id of the controller to query - configured explicitly or the first one of the account */
  async resolveV2Controller() {
    if (this.v2ControllerId !== null) {
      return this.v2ControllerId;
    }
    if (Number(this.config.v2ControllerId) > 0) {
      this.v2ControllerId = Number(this.config.v2ControllerId);
      return this.v2ControllerId;
    }
    const controllers = await this.v2.getControllers();
    if (!controllers.length) {
      this.log.error("(v2) no controller found for this account");
      return null;
    }
    this.v2ControllerId = controllers[0].id;
    this.log.info(`(v2) using controller "${controllers[0].name}" (id ${controllers[0].id})`);
    return this.v2ControllerId;
  }
  async applyV2Status(controller) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    await this.ensureV2Channel("controller", "Controller");
    const status = controller.status || {};
    const hardware = controller.hardware || {};
    await this.setV2State(
      "controller.online",
      { name: "controller online", type: "boolean", role: "indicator.reachable" },
      !!((_a = controller.online) != null ? _a : status.online)
    );
    await this.setV2State(
      "controller.status",
      { name: "status summary", type: "string", role: "text" },
      (_b = status.summary) != null ? _b : null
    );
    await this.setV2State(
      "controller.lastContact",
      { name: "last contact", type: "string", role: "date" },
      (_c = (0, import_hydrawise_v2.dateValue)(status.lastContact)) != null ? _c : (0, import_hydrawise_v2.dateValue)(controller.lastContactTime)
    );
    await this.setV2State(
      "controller.name",
      { name: "controller name", type: "string", role: "text" },
      (_d = controller.name) != null ? _d : null
    );
    await this.setV2State(
      "controller.model",
      { name: "controller model", type: "string", role: "text" },
      (_f = (_e = hardware.model) == null ? void 0 : _e.name) != null ? _f : null
    );
    await this.setV2State(
      "controller.serialNumber",
      { name: "serial number", type: "string", role: "text" },
      (_g = hardware.serialNumber) != null ? _g : null
    );
    await this.setV2State(
      "controller.firmwareVersion",
      { name: "firmware version", type: "string", role: "text" },
      (_h = hardware.version) != null ? _h : null
    );
    await this.setV2State(
      "controller.waterSavings",
      { name: "accumulated water savings", unit: "%" },
      (_i = status.accumulatedWaterSavings) != null ? _i : null
    );
  }
  async applyV2Observations(observations) {
    var _a, _b, _c, _d;
    if (!observations) {
      return;
    }
    await this.ensureV2Channel("weather", "Weather station");
    await this.setV2State(
      "weather.rainfallLast24h",
      {
        name: "rainfall last 24 hours",
        role: "value.precipitation",
        unit: (0, import_hydrawise_v2.localizedUnit)(observations.rainfallLast24Hours, "mm")
      },
      (_a = (0, import_hydrawise_v2.localizedNumber)(observations.rainfallLast24Hours)) != null ? _a : void 0
    );
    await this.setV2State(
      "weather.rainfallLast7d",
      {
        name: "rainfall last 7 days",
        role: "value.precipitation",
        unit: (0, import_hydrawise_v2.localizedUnit)(observations.rainfallLast168hours, "mm")
      },
      (_b = (0, import_hydrawise_v2.localizedNumber)(observations.rainfallLast168hours)) != null ? _b : void 0
    );
    await this.setV2State(
      "weather.temperature",
      {
        name: "current temperature",
        role: "value.temperature",
        unit: (0, import_hydrawise_v2.localizedUnit)(observations.currentTemperature, "\xB0C")
      },
      (_c = (0, import_hydrawise_v2.localizedNumber)(observations.currentTemperature)) != null ? _c : void 0
    );
    await this.setV2State(
      "weather.temperatureMax",
      {
        name: "max temperature since midnight",
        role: "value.temperature",
        unit: (0, import_hydrawise_v2.localizedUnit)(observations.maxTemperatureSinceMidnight, "\xB0C")
      },
      (_d = (0, import_hydrawise_v2.localizedNumber)(observations.maxTemperatureSinceMidnight)) != null ? _d : void 0
    );
  }
  async applyV2Sensors(sensors) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k;
    if (!sensors.length) {
      return;
    }
    await this.ensureV2Channel("sensors", "Sensors");
    for (const sensor of sensors) {
      const input = (_a = sensor == null ? void 0 : sensor.input) == null ? void 0 : _a.number;
      if (input === void 0 || input === null) {
        continue;
      }
      const base = `sensors.${this.name2id(String(input))}`;
      await this.ensureV2Channel(base, sensor.name || `sensor ${input}`);
      await this.setV2State(
        `${base}.name`,
        { name: "sensor name", type: "string", role: "text" },
        (_b = sensor.name) != null ? _b : null
      );
      await this.setV2State(
        `${base}.type`,
        { name: "sensor type", type: "string", role: "text" },
        (_d = (_c = sensor.model) == null ? void 0 : _c.sensorType) != null ? _d : null
      );
      await this.setV2State(
        `${base}.model`,
        { name: "sensor model", type: "string", role: "text" },
        (_f = (_e = sensor.model) == null ? void 0 : _e.name) != null ? _f : null
      );
      await this.setV2State(
        `${base}.terminal`,
        { name: "controller terminal", type: "string", role: "text" },
        (_h = (_g = sensor.input) == null ? void 0 : _g.label) != null ? _h : null
      );
      if (((_i = sensor.status) == null ? void 0 : _i.active) !== null && ((_j = sensor.status) == null ? void 0 : _j.active) !== void 0) {
        await this.setV2State(
          `${base}.active`,
          { name: "sensor is triggered", type: "boolean", role: "indicator" },
          !!sensor.status.active
        );
      }
      if ((_k = sensor.status) == null ? void 0 : _k.waterFlow) {
        await this.setV2State(
          `${base}.waterFlow`,
          {
            name: "water flow reported by the sensor",
            unit: (0, import_hydrawise_v2.localizedUnit)(sensor.status.waterFlow)
          },
          (0, import_hydrawise_v2.localizedNumber)(sensor.status.waterFlow, 0)
        );
      }
    }
  }
  async applyV2Zones(zones) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    const summary = { byId: /* @__PURE__ */ new Map(), anyRunning: false };
    if (!zones.length) {
      return summary;
    }
    await this.ensureV2Channel("zones", "Zones");
    for (const zone of zones) {
      const number = (_b = (_a = zone == null ? void 0 : zone.number) == null ? void 0 : _a.value) != null ? _b : zone == null ? void 0 : zone.id;
      if (number === void 0 || number === null) {
        continue;
      }
      const base = `zones.${this.name2id(String(number))}`;
      const runs = zone.scheduledRuns || {};
      const current = runs.currentRun;
      const running = !!current;
      summary.byId.set(zone.id, base);
      summary.anyRunning = summary.anyRunning || running;
      await this.ensureV2Channel(base, zone.name || `zone ${number}`);
      await this.setV2State(`${base}.id`, { name: "zone id" }, zone.id);
      await this.setV2State(
        `${base}.name`,
        { name: "zone name", type: "string", role: "text" },
        (_c = zone.name) != null ? _c : null
      );
      await this.setV2State(
        `${base}.running`,
        { name: "zone is watering", type: "boolean", role: "indicator.working" },
        running
      );
      await this.setV2State(
        `${base}.status`,
        { name: "run status", type: "string", role: "text" },
        (_d = runs.status) != null ? _d : null
      );
      await this.setV2State(
        `${base}.remainingTime`,
        { name: "remaining run time", unit: "s" },
        running ? Number(current.remainingTime) || 0 : 0
      );
      await this.setV2State(
        `${base}.currentWater`,
        { name: "water used by the running zone", unit: (0, import_hydrawise_v2.localizedUnit)(runs.currentWaterUsage, "l") },
        running ? (0, import_hydrawise_v2.localizedNumber)(runs.currentWaterUsage, 0) : 0
      );
      await this.setV2State(
        `${base}.nextRun`,
        { name: "next run", type: "string", role: "date" },
        (0, import_hydrawise_v2.dateValue)((_e = runs.nextRun) == null ? void 0 : _e.startTime)
      );
      await this.setV2State(
        `${base}.nextRunDuration`,
        { name: "duration of the next run", unit: "min" },
        (_g = (_f = runs.nextRun) == null ? void 0 : _f.duration) != null ? _g : null
      );
      await this.setV2State(
        `${base}.suspendedUntil`,
        { name: "suspended until", type: "string", role: "date" },
        (0, import_hydrawise_v2.dateValue)((_h = zone.status) == null ? void 0 : _h.suspendedUntil)
      );
      await this.setV2State(
        `${base}.waterBalance`,
        { name: "relative water balance", unit: "%" },
        (_j = (_i = zone.status) == null ? void 0 : _i.relativeWaterBalance) != null ? _j : null
      );
    }
    return summary;
  }
  /**
   * Water usage of one period.
   *
   * @param period the period these numbers belong to
   * @param volume total volume through the flow meters, null when it was not queried
   * @param usage watering report of the period, null when it was not queried
   */
  async applyV2Usage(period, volume, usage) {
    if (!volume && !usage) {
      return;
    }
    await this.ensureV2Channel("water", "Water usage");
    const unit = (volume == null ? void 0 : volume.unit) || (usage == null ? void 0 : usage.unit) || "l";
    if ((volume == null ? void 0 : volume.hasFlowSensor) && (volume.hasValue || period === "today" || period === "yesterday")) {
      await this.setV2State(`water.${period}`, { name: `water usage ${period}`, unit }, volume.total);
    }
    if (!usage) {
      return;
    }
    await this.setV2State(
      `water.${period}Active`,
      { name: `water used for watering ${period}`, unit },
      usage.active
    );
    await this.setV2State(`water.${period}Runtime`, { name: `watering time ${period}`, unit: "s" }, usage.runtime);
    if (volume == null ? void 0 : volume.hasFlowSensor) {
      await this.setV2State(
        `water.${period}Inactive`,
        { name: `water used outside of watering ${period}`, unit },
        (0, import_hydrawise_v2.inactiveVolume)(volume, usage)
      );
    }
  }
  /**
   * Per zone water usage of the current day - zones without a run are reset to zero.
   *
   * @param zones zones of the controller
   * @param today watering report of the current day
   * @param unit volume unit reported by the API
   */
  async applyV2ZoneUsage(zones, today, unit) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (!zones || !today) {
      return;
    }
    for (const [zoneId, base] of zones.byId) {
      const usage = today.byZone.get(zoneId);
      await this.setV2State(`${base}.waterToday`, { name: "water used today", unit }, (_a = usage == null ? void 0 : usage.water) != null ? _a : 0);
      await this.setV2State(
        `${base}.runtimeToday`,
        { name: "watering time today", unit: "s" },
        (_b = usage == null ? void 0 : usage.runtime) != null ? _b : 0
      );
      if (usage == null ? void 0 : usage.latest) {
        await this.setV2State(
          `${base}.scheduleStatus`,
          { name: "status of the most recent scheduled run", type: "string", role: "text" },
          (_d = (_c = usage.latest.scheduledStatus) == null ? void 0 : _c.label) != null ? _d : null
        );
      }
      const last = usage == null ? void 0 : usage.last;
      if (!last) {
        continue;
      }
      await this.setV2State(
        `${base}.lastRunStart`,
        { name: "start of the last run", type: "string", role: "date" },
        (0, import_hydrawise_v2.dateValue)(last.reportedStartTime)
      );
      await this.setV2State(
        `${base}.lastRunEnd`,
        { name: "end of the last run", type: "string", role: "date" },
        (0, import_hydrawise_v2.dateValue)(last.reportedEndTime)
      );
      await this.setV2State(
        `${base}.lastRunDuration`,
        { name: "duration of the last run", unit: "s" },
        Number(last.reportedDuration) || 0
      );
      await this.setV2State(
        `${base}.lastRunWater`,
        { name: "water used by the last run", unit },
        (0, import_hydrawise_v2.localizedNumber)(last.reportedWaterUsage, 0)
      );
      await this.setV2State(
        `${base}.lastRunStatus`,
        { name: "status of the last run", type: "string", role: "text" },
        (_f = (_e = last.reportedStatus) == null ? void 0 : _e.label) != null ? _f : null
      );
      await this.setV2State(
        `${base}.lastRunOk`,
        { name: "last run finished normally", type: "boolean", role: "indicator" },
        (_h = (_g = last.reportedStopReason) == null ? void 0 : _g.finishedNormally) != null ? _h : null
      );
    }
  }
  /**
   * Water that flowed today without any zone running points at a leak or a dripping valve.
   *
   * @param volume total volume through the flow meters today
   * @param usage watering report of the current day
   * @param zones zones of the controller
   */
  async applyV2Leak(volume, usage, zones) {
    if (!(volume == null ? void 0 : volume.hasFlowSensor) || !usage) {
      return;
    }
    if (!zones || zones.anyRunning) {
      return;
    }
    const threshold = Number(this.config.leakThreshold) || 0;
    if (threshold <= 0) {
      return;
    }
    const suspected = (0, import_hydrawise_v2.inactiveVolume)(volume, usage) > threshold;
    const confirmed = suspected && this.leakSeen;
    this.leakSeen = suspected;
    await this.setV2State(
      "water.leakSuspected",
      { name: "water used today without any zone running", type: "boolean", role: "indicator.alarm" },
      confirmed
    );
  }
  /**
   * Creates a channel once per adapter run
   *
   * @param id id of the channel
   * @param name display name of the channel
   */
  async ensureV2Channel(id, name) {
    if (this.v2Objects.has(`channel:${id}`) || this.unloaded) {
      return;
    }
    await this.setObjectNotExistsAsync(id, { type: "channel", common: { name }, native: {} });
    this.v2Objects.add(`channel:${id}`);
  }
  /**
   * Creates the state on first use (units are only known once the API answered) and writes its value
   *
   * @param id id of the state
   * @param common common properties used when the state is created
   * @param value value to write
   */
  async setV2State(id, common, value) {
    var _a;
    if (value === void 0 || this.unloaded) {
      return;
    }
    const unit = typeof common.unit === "string" ? common.unit : "";
    if (!this.v2Objects.has(id) || unit && this.v2Units[id] !== unit) {
      const definition = {
        name: id.split(".").pop(),
        type: "number",
        role: "value",
        read: true,
        write: false,
        ...common
      };
      const existing = await this.getObjectAsync(id);
      if (!existing) {
        await this.setObjectAsync(id, { type: "state", common: definition, native: {} });
      } else if (definition.unit && ((_a = existing.common) == null ? void 0 : _a.unit) !== definition.unit) {
        await this.extendObjectAsync(id, { common: { unit: definition.unit } });
      }
      this.v2Objects.add(id);
      this.v2Units[id] = unit;
    }
    await this.setStateChangedAsync(id, value, true);
  }
  name2id(pName) {
    return (pName || "").replace(this.FORBIDDEN_CHARS, "_");
  }
}
if (require.main !== module) {
  module.exports = (options) => new Hydrawise(options);
} else {
  (() => new Hydrawise())();
}
//# sourceMappingURL=main.js.map
