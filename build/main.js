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
var import_axios = __toESM(require("axios"));
var import_hydrawise_v2 = require("./lib/hydrawise-v2");
const hydrawise_url = "https://api.hydrawise.com";
let nextpollSchedule = null;
let nextpollCustomer = null;
let resetSwitch = null;
const RELAYS = Object;
const RATE_LIMIT_PAUSE = 5 * 60 * 1e3;
const RATE_LIMIT_PAUSE_MAX = 30 * 60 * 1e3;
const V2_PERIOD_TASKS = [
  { kind: "flow", period: "yesterday" },
  { kind: "report", period: "yesterday" },
  { kind: "flow", period: "week" },
  { kind: "flow", period: "month" },
  { kind: "flow", period: "year" }
];
class Hydrawise extends utils.Adapter {
  v2 = null;
  v2Timer = null;
  v2ControllerId = null;
  v2Objects = /* @__PURE__ */ new Set();
  v2Errors = {};
  v2Period = 0;
  v2FirstPoll = true;
  lastErrorCode = 0;
  unloaded = false;
  blockedUntil = {};
  backoff = {};
  pollIntervalWarned = false;
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
      try {
        await this.GetStatusSchedule();
        await this.GetCustomerDetails();
      } catch (error) {
        this.log.error(error.toString());
      }
      nextpollSchedule = this.setInterval(() => {
        void this.GetStatusSchedule();
      }, scheduleInterval);
      nextpollCustomer = this.setInterval(() => {
        void this.GetCustomerDetails();
      }, customerInterval);
    }
    if (this.config.useV2) {
      await this.startV2();
    }
    await this.subscribeStatesAsync("*");
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
          await this.setObjectNotExistsAsync("schedule.stopall", {
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
          await this.setObjectNotExistsAsync("schedule.runall", {
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
          await this.setObjectNotExistsAsync("schedule.suspendall", {
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
            if (key !== "relays" && key !== "sensors" && key !== "expanders" && !Number.isNaN(key)) {
              await this.setObjectNotExistsAsync(`schedule.${key}`, {
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
                await this.setObjectNotExistsAsync("schedule.timestr", {
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
            await this.setObjectNotExistsAsync(`schedule.${relay.relay}`, {
              type: "channel",
              common: {
                name: name.toString()
              },
              native: {}
            });
            RELAYS[relay.relay] = relay.relay_id;
            for (let key in relay) {
              key = this.name2id(key);
              await this.setObjectNotExistsAsync(`schedule.${relay.relay}.${key}`, {
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
            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.stopZone`, {
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
            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.runZone`, {
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
            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.suspendZone`, {
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
            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.runDefault`, {
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
            await this.setObjectNotExistsAsync(`schedule.sensors.${sensor.input}`, {
              type: "channel",
              common: {
                name: "sensors"
              },
              native: {}
            });
            for (let key in sensor) {
              if (key !== "relays") {
                key = this.name2id(key);
                await this.setObjectNotExistsAsync(`schedule.sensors.${sensor.input}.${key}`, {
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
            if (key !== "controllers" && !Number.isNaN(key)) {
              key = this.name2id(key);
              await this.setObjectNotExistsAsync(`customer.${key}`, {
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
            await this.setObjectNotExistsAsync(`customer.controllers.${controller.name}`, {
              type: "channel",
              common: {
                name: controller.name
              },
              native: {}
            });
            for (let key in controller) {
              key = this.name2id(key);
              await this.setObjectNotExistsAsync(`customer.controllers.${controller.name}.${key}`, {
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
  buildRequest(service, params) {
    return new Promise((resolve, reject) => {
      const url = `/api/v1/${service}`;
      if (params.api_key) {
        try {
          (0, import_axios.default)({
            method: "GET",
            baseURL: hydrawise_url,
            url,
            timeout: 3e4,
            responseType: "json",
            params
          }).then((response) => {
            this.lastErrorCode = 0;
            this.backoff[service] = 0;
            this.blockedUntil[service] = 0;
            resolve(response);
          }).catch((error) => {
            if (error.response) {
              this.log.warn(
                `received ${error.response.status} response from ${url} with content: ${JSON.stringify(error.response.data)}`
              );
            } else if (error.request) {
              if (error.code === this.lastErrorCode) {
                this.log.debug(error.message);
              } else {
                this.log.info(`error ${error.code} from ${url}: ${error.message}`);
                this.lastErrorCode = error.code;
              }
            } else {
              this.log.error(error.message);
            }
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      } else {
        reject(new Error("API key is not configured"));
      }
    });
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
    if (state && !state.ack) {
      if (id.indexOf("stopall") !== -1) {
        void this.buildRequest("setzone.php", { api_key: this.config.apiKey, action: "stopall" });
      } else if (id.indexOf("stop") !== -1) {
        const relay = id.match(/.*schedule\.(.*)\.stopZone/);
        if (relay && (relay == null ? void 0 : relay.length) > 1) {
          void this.buildRequest("setzone.php", {
            api_key: this.config.apiKey,
            action: "stop",
            relay_id: RELAYS[relay[1]]
          });
        }
      }
      if (id.indexOf("runall") !== -1 && (state.val || state.val === 0)) {
        void this.buildRequest("setzone.php", {
          api_key: this.config.apiKey,
          action: "runall",
          period_id: 999,
          custom: state.val
        });
      } else if (id.indexOf("runZone") !== -1 && (state.val || state.val === 0)) {
        const relay = id.match(/.*schedule\.(.*)\.runZone/);
        if (relay && (relay == null ? void 0 : relay.length) > 1) {
          void this.buildRequest("setzone.php", {
            api_key: this.config.apiKey,
            action: "run",
            period_id: 999,
            custom: state.val,
            relay_id: RELAYS[relay[1]]
          });
        }
      }
      if (id.indexOf("runDefault") !== -1 && state.val !== null) {
        void this.initRunDefault(id, state.val);
      }
      if (id.indexOf("suspendall") !== -1 && (state.val || state.val === 0)) {
        const num = state.val;
        void this.buildRequest("setzone.php", {
          api_key: this.config.apiKey,
          action: "suspendall",
          period_id: 999,
          custom: Math.trunc((state.ts + num) / 1e3)
        });
      } else if (id.indexOf("suspend") !== -1 && (state.val || state.val === 0)) {
        const num = state.val;
        const relay = id.match(/.*schedule\.(.*)\.suspendZone/);
        if (relay && (relay == null ? void 0 : relay.length) > 1) {
          void this.buildRequest("setzone.php", {
            api_key: this.config.apiKey,
            action: "suspend",
            period_id: 999,
            custom: Math.trunc((state.ts + num) / 1e3),
            relay_id: RELAYS[relay[1]]
          });
        }
      }
    }
  }
  async initRunDefault(id, run) {
    const relay = id.match(/(.*schedule.*\.)runDefault/);
    this.clearTimeout(resetSwitch);
    if (relay) {
      if (run) {
        const defaultRunTime = await this.getStateAsync(`${relay[1]}run`);
        if (defaultRunTime && defaultRunTime.val) {
          void this.setState(`${relay[1]}runZone`, defaultRunTime.val, false);
          resetSwitch = this.setTimeout(
            () => {
              void this.setState(id, false, false);
            },
            defaultRunTime.val * 1e3
          );
        }
      } else {
        void this.setState(`${relay[1]}stopZone`, true, false);
      }
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
    var _a, _b;
    if (((_a = error == null ? void 0 : error.response) == null ? void 0 : _a.status) === 429) {
      const pause = Math.min(Math.max((this.backoff[service] || 0) * 2, RATE_LIMIT_PAUSE), RATE_LIMIT_PAUSE_MAX);
      this.backoff[service] = pause;
      this.blockedUntil[service] = Date.now() + pause;
      this.log.info(`${service} hit the API rate limit - pausing it for ${Math.round(pause / 6e4)} minutes`);
      return;
    }
    this.log.debug(`(${service}) received error - API is now offline: ${(_b = error == null ? void 0 : error.message) != null ? _b : JSON.stringify(error)}`);
    void this.setStateChangedAsync("info.connection", false, true);
  }
  /**
   * The API reports how often it wants to be polled - warn once when we are faster.
   *
   * @param nextpoll seconds the API asks us to wait
   */
  checkPollInterval(nextpoll) {
    if (!nextpoll || this.pollIntervalWarned || Number(this.config.apiInterval) >= nextpoll) {
      return;
    }
    this.pollIntervalWarned = true;
    this.log.warn(
      `the API asks to be polled every ${nextpoll} seconds, but the configured interval is ${this.config.apiInterval} seconds`
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
    await this.setObjectNotExistsAsync("info.connectionV2", {
      type: "state",
      common: {
        name: {
          en: "v2 API connected",
          de: "v2-API verbunden",
          ru: "v2 API \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D",
          pt: "API v2 conectada",
          nl: "v2 API verbonden",
          fr: "API v2 connect\xE9e",
          it: "API v2 connessa",
          es: "API v2 conectada",
          pl: "API v2 po\u0142\u0105czone",
          uk: "API v2 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E",
          "zh-cn": "v2 API \u5DF2\u8FDE\u63A5"
        },
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false
      },
      native: {}
    });
    void this.setStateChangedAsync("info.connectionV2", false, true);
    const minutes = Math.max(2, Number(this.config.v2Interval) || 5);
    await this.pollV2();
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
    void this.setStateChangedAsync("info.connectionV2", false, true);
    this.log.error(`(v2) polling stopped: ${reason}`);
  }
  /** One poll cycle - every query is applied on its own so a single failure is not fatal */
  async pollV2() {
    if (!this.v2 || this.unloaded) {
      return;
    }
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
      const volume = flow ? this.sumFlow(flow) : null;
      const usage = report ? this.summarizeRuns(report) : null;
      await this.applyV2Usage("today", volume, usage);
      await this.applyV2ZoneUsage(zones, usage, (volume == null ? void 0 : volume.unit) || "l");
      await this.applyV2Leak(volume, usage, zones);
      await this.pollV2Periods(controllerId, bounds);
      if (snapshot || flow || report) {
        void this.setStateChangedAsync("info.connectionV2", true, true);
        await this.setV2State(
          "water.lastUpdate",
          { name: "last v2 update", type: "string", role: "date" },
          (/* @__PURE__ */ new Date()).toISOString()
        );
      }
    } catch (error) {
      if (error instanceof import_hydrawise_v2.NotAuthorizedError) {
        this.stopV2(`login failed - check e-mail and password (${error.message})`);
        return;
      }
      void this.setStateChangedAsync("info.connectionV2", false, true);
      this.log.warn(`(v2) poll failed: ${error.message}`);
    }
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
      const [from, until] = this.periodRange(task.period, bounds);
      if (task.kind === "flow") {
        const sensors = await this.v2Section(
          `flow ${task.period}`,
          () => this.v2.getFlowSummary(controllerId, from, until)
        );
        if (sensors) {
          const volume = this.sumFlow(sensors);
          if (volume.hasFlowSensor) {
            await this.setV2State(
              `water.${task.period}`,
              { name: `water usage ${task.period}`, unit: volume.unit },
              volume.total
            );
          }
        }
      } else {
        const entries = await this.v2Section(
          `report ${task.period}`,
          () => this.v2.getReport(controllerId, from, until)
        );
        if (entries) {
          await this.applyV2Usage(task.period, null, this.summarizeRuns(entries));
        }
      }
    }
  }
  /**
   * Start and end of a reporting period.
   *
   * @param period the period to look up
   * @param bounds start/end of the reporting periods
   */
  periodRange(period, bounds) {
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
  /**
   * Runs one query and keeps the adapter alive when only this query fails
   *
   * @param name label of the query, used in the warning when it fails
   * @param run the query to run
   */
  async v2Section(name, run) {
    try {
      const result = await run();
      this.v2Errors[name] = 0;
      return result;
    } catch (error) {
      if (error instanceof import_hydrawise_v2.NotAuthorizedError) {
        throw error;
      }
      const count = this.v2Errors[name] = (this.v2Errors[name] || 0) + 1;
      if (error instanceof import_hydrawise_v2.ThrottledError) {
        this.log.debug(`(v2) ${error.message}`);
      } else if (count <= 3) {
        this.log.warn(`(v2) query "${name}" failed: ${error.message}`);
      } else {
        this.log.debug(`(v2) query "${name}" failed (${count}x): ${error.message}`);
      }
      return null;
    }
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
   * Adds up the flow meters of a controller.
   *
   * @param sensors sensors as returned by a flow summary query
   */
  sumFlow(sensors) {
    var _a, _b;
    const summary = { hasFlowSensor: false, total: 0, unit: "" };
    for (const sensor of sensors) {
      if (((_a = sensor == null ? void 0 : sensor.model) == null ? void 0 : _a.sensorType) !== "FLOW") {
        continue;
      }
      const volume = (_b = sensor.flowSummary) == null ? void 0 : _b.totalWaterVolume;
      summary.hasFlowSensor = true;
      summary.total += (0, import_hydrawise_v2.localizedNumber)(volume, 0);
      summary.unit = summary.unit || (0, import_hydrawise_v2.localizedUnit)(volume);
    }
    summary.total = Math.round(summary.total * 100) / 100;
    return summary;
  }
  /**
   * Adds up the runs of a watering report, per controller and per zone.
   *
   * @param entries entries of the watering report
   */
  summarizeRuns(entries) {
    const summary = { active: 0, runtime: 0, unit: "", byZone: /* @__PURE__ */ new Map() };
    for (const entry of entries) {
      const run = entry == null ? void 0 : entry.runEvent;
      if (!(run == null ? void 0 : run.zone)) {
        continue;
      }
      const zone = summary.byZone.get(run.zone.id) || { water: 0, runtime: 0, last: null, latest: null };
      if (!zone.latest || (0, import_hydrawise_v2.dateStamp)(run.scheduledStartTime) >= (0, import_hydrawise_v2.dateStamp)(zone.latest.scheduledStartTime)) {
        zone.latest = run;
      }
      if (run.reportedStartTime) {
        const water = (0, import_hydrawise_v2.localizedNumber)(run.reportedWaterUsage, 0);
        const runtime = Number(run.reportedDuration) || 0;
        summary.active += water;
        summary.runtime += runtime;
        summary.unit = summary.unit || (0, import_hydrawise_v2.localizedUnit)(run.reportedWaterUsage);
        zone.water += water;
        zone.runtime += runtime;
        if (!zone.last || (0, import_hydrawise_v2.dateStamp)(run.reportedEndTime) >= (0, import_hydrawise_v2.dateStamp)(zone.last.reportedEndTime)) {
          zone.last = run;
        }
      }
      summary.byZone.set(run.zone.id, zone);
    }
    summary.active = Math.round(summary.active * 100) / 100;
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
    if (volume == null ? void 0 : volume.hasFlowSensor) {
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
        this.inactiveVolume(volume, usage)
      );
    }
  }
  /**
   * Water that flowed without a zone running. The watering report and the flow summary are
   * not updated at the same time, so a negative difference only means the report is ahead.
   *
   * @param volume total volume through the flow meters
   * @param usage watering report of the same period
   */
  inactiveVolume(volume, usage) {
    return volume.total > usage.active ? Math.round((volume.total - usage.active) * 100) / 100 : 0;
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
    if (zones == null ? void 0 : zones.anyRunning) {
      return;
    }
    const threshold = Number(this.config.leakThreshold) || 0;
    const inactive = this.inactiveVolume(volume, usage);
    await this.setV2State(
      "water.leakSuspected",
      { name: "water used today without any zone running", type: "boolean", role: "indicator.alarm" },
      threshold > 0 && inactive > threshold
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
    if (!this.v2Objects.has(id)) {
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
