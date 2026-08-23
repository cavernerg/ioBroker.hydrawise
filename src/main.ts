/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from '@iobroker/adapter-core';
import axios from 'axios';
import {
    HydrawiseV2,
    NotAuthorizedError,
    ThrottledError,
    dateValue,
    inactiveVolume,
    localizedNumber,
    localizedUnit,
    periodBounds,
    periodRange,
    sumFlow,
    summarizeRuns,
    type FlowSummary,
    type Period,
    type PeriodBounds,
    type UsageSummary,
} from './lib/hydrawise-v2';

const hydrawise_url = 'https://api.hydrawise.com';
let nextpollSchedule: any = null;
let nextpollCustomer: any = null;
let resetSwitch: any = null;
const RELAYS: any = Object;

/** How long an endpoint is paused after the API answered with 429, and the cap for repeated hits */
const RATE_LIMIT_PAUSE = 5 * 60 * 1000;
const RATE_LIMIT_PAUSE_MAX = 30 * 60 * 1000;

/** One turn of the rotating long term queries */
interface PeriodTask {
    period: Period;
    /** the watering report is only worth its own request where the runs are already final */
    withReport: boolean;
}

/**
 * A field that takes arguments must not appear twice in one query, so every period needs
 * its own request. The periods take turns instead of being fetched on every poll.
 */
const V2_PERIOD_TASKS: PeriodTask[] = [
    { period: 'yesterday', withReport: true },
    { period: 'week', withReport: false },
    { period: 'month', withReport: false },
    { period: 'year', withReport: false },
];

/** Zones of a controller, indexed by their (internal) zone id */
interface ZoneSummary {
    byId: Map<number, string>;
    anyRunning: boolean;
}

class Hydrawise extends utils.Adapter {
    private v2: HydrawiseV2 | null = null;
    private v2Timer: any = null;
    private v2ControllerId: number | null = null;
    private v2Objects = new Set<string>();
    private v2Errors: Record<string, number> = {};
    private v2Period = 0;
    private v2FirstPoll = true;
    private v2Polling = false;
    private v2AnySection = false;
    private v2Units: Record<string, string> = {};
    private leakSeen = false;
    private lastErrorCode: any = 0;
    private unloaded = false;
    private blockedUntil: Record<string, number> = {};
    private backoff: Record<string, number> = {};
    private pollIntervalWarned = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'hydrawise',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        void this.setStateChangedAsync('info.connection', false, true);

        if (!this.config.apiKey) {
            this.log.error('No API-Key defined!');
        } else {
            const scheduleInterval = Math.max(15, Number(this.config.apiInterval) || 60) * 1000;
            const customerInterval = Math.max(5, Number(this.config.customerInterval) || 30) * 60 * 1000;

            try {
                await this.GetStatusSchedule();
                await this.GetCustomerDetails();
            } catch (error: any) {
                this.log.error(error.toString());
            }

            // one stable interval per endpoint - a failing request must never remove it,
            // the rate limit is handled by pausing the endpoint instead
            nextpollSchedule = this.setInterval(() => {
                void this.GetStatusSchedule();
            }, scheduleInterval);

            nextpollCustomer = this.setInterval(() => {
                void this.GetCustomerDetails();
            }, customerInterval);

            await this.subscribeStatesAsync('*');
        }

        if (this.config.useV2) {
            await this.startV2();
        }
    }

    private async GetStatusSchedule(): Promise<void> {
        if (!this.mayRequest('statusschedule.php')) {
            return;
        }

        return new Promise(resolve => {
            this.buildRequest('statusschedule.php', { api_key: this.config.apiKey })
                .then(async response => {
                    if (this.unloaded) {
                        resolve();

                        return;
                    }

                    if (response?.status === 200) {
                        const content = response.data;

                        void this.setStateChangedAsync('info.connection', true, true);

                        await this.setObjectNotExistsAsync('schedule.stopall', {
                            type: 'state',
                            common: {
                                name: {
                                    en: 'stop all zones',
                                    de: 'alle Zonen stoppen',
                                    ru: 'остановить все зоны',
                                    pt: 'parar todas as zonas',
                                    nl: 'stop alle zones',
                                    fr: 'arrêter toutes les zones',
                                    it: 'fermare tutte le zone',
                                    es: 'detener todas las zonas',
                                    pl: 'zatrzymują wszystkie strefy',
                                    uk: 'зупинити всі зони',
                                    'zh-cn': '停止所有地区',
                                },
                                type: 'boolean',
                                role: 'button.stop',
                                read: false,
                                write: true,
                            },
                            native: {},
                        });

                        await this.setObjectNotExistsAsync('schedule.runall', {
                            type: 'state',
                            common: {
                                name: {
                                    en: 'run all zones for x seconds',
                                    de: 'alle Zonen für x Sekunden ausführen',
                                    ru: 'запустить все зоны за x секунды',
                                    pt: 'executar todas as zonas por x segundos',
                                    nl: 'ren alle zones voor x seconden',
                                    fr: 'exécuter toutes les zones pendant x secondes',
                                    it: 'eseguire tutte le zone per x secondi',
                                    es: 'ejecutar todas las zonas durante x segundos',
                                    pl: 'wszystkie strefy startują dla x sekundy',
                                    uk: 'запустити всі зони для x секунд',
                                    'zh-cn': '跑道区',
                                },
                                type: 'number',
                                role: 'level',
                                unit: 'seconds',
                                read: true,
                                write: true,
                            },
                            native: {},
                        });

                        await this.setObjectNotExistsAsync('schedule.suspendall', {
                            type: 'state',
                            common: {
                                name: {
                                    en: 'suspend all zones for x seconds',
                                    de: 'alle Zonen für x Sekunden aussetzen',
                                    ru: 'приостановить все зоны за x секунды',
                                    pt: 'suspender todas as zonas por x segundos',
                                    nl: 'vertaling:',
                                    fr: 'suspendre toutes les zones pendant x secondes',
                                    it: 'sospendere tutte le zone per x secondi',
                                    es: 'suspender todas las zonas durante x segundos',
                                    pl: 'wszystkie strefy zawieszenia dla x sekundy',
                                    uk: 'призупинити всі зони на x секунд',
                                    'zh-cn': '停止所有×二区',
                                },
                                type: 'number',
                                role: 'level',
                                read: true,
                                write: true,
                            },
                            native: {},
                        });

                        for (let key in content) {
                            key = this.name2id(key);

                            if (key !== 'relays' && key !== 'sensors' && key !== 'expanders' && !Number.isNaN(key)) {
                                await this.setObjectNotExistsAsync(`schedule.${key}`, {
                                    type: 'state',
                                    common: {
                                        name: key,
                                        type: key === 'message' ? 'string' : 'number',
                                        role: key === 'message' ? 'text' : 'value',
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                });

                                void this.setStateChangedAsync(`schedule.${key}`, content[key], true);

                                if (key === 'time') {
                                    await this.setObjectNotExistsAsync('schedule.timestr', {
                                        type: 'state',
                                        common: {
                                            name: 'last api call',
                                            type: 'string',
                                            role: 'text',
                                            read: true,
                                            write: false,
                                        },
                                        native: {},
                                    });

                                    const t = new Date(content[key] * 1000);

                                    void this.setStateChangedAsync('schedule.timestr', t.toString(), true);
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
                                type: 'channel',
                                common: {
                                    name: name.toString(),
                                },
                                native: {},
                            });

                            RELAYS[relay.relay] = relay.relay_id;

                            for (let key in relay) {
                                key = this.name2id(key);

                                await this.setObjectNotExistsAsync(`schedule.${relay.relay}.${key}`, {
                                    type: 'state',
                                    common: {
                                        name: key,
                                        type: key === 'name' || key === 'timestr' ? 'string' : 'number',
                                        role: key === 'name' || key === 'timestr' ? 'text' : 'value',
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                });

                                if (key === 'timestr') {
                                    const t = new Date();
                                    t.setSeconds(t.getSeconds() + relay.time);
                                    relay[key] = t.toString();
                                }

                                void this.setStateChangedAsync(`schedule.${relay.relay}.${key}`, relay[key], true);
                            }

                            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.stopZone`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'stop zone',
                                        de: 'Zone stoppen',
                                        ru: 'зона остановки',
                                        pt: 'zona de paragem',
                                        nl: 'stop zone',
                                        fr: "zone d ' arrêt",
                                        it: 'zona di sosta',
                                        es: 'zona de parada',
                                        pl: 'strefa stopu',
                                        uk: 'зона зупинки',
                                        'zh-cn': '停止地区',
                                    },
                                    type: 'boolean',
                                    role: 'button.stop',
                                    read: false,
                                    write: true,
                                },
                                native: {},
                            });

                            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.runZone`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'run zone for x seconds',
                                        de: 'Zone für x Sekunden starten',
                                        ru: 'запустить зону за x секунды',
                                        pt: 'zona de execução por x segundos',
                                        nl: 'ren zone voor x seconden',
                                        fr: 'zone de course pour x secondes',
                                        it: 'zona di corsa per x secondi',
                                        es: 'zona de ejecución por x segundos',
                                        pl: 'strefa x sekundy',
                                        uk: 'зона запуску для x секунд',
                                        'zh-cn': '×二区',
                                    },
                                    type: 'number',
                                    role: 'level',
                                    read: true,
                                    write: true,
                                },
                                native: {},
                            });

                            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.suspendZone`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'suspend zone for x seconds',
                                        de: 'Zone für x Sekunden aussetzen',
                                        ru: 'приостановить зону на x секунды',
                                        pt: 'zona de suspensão por x segundos',
                                        nl: 'quality over quantity (qoq) releases vertaling:',
                                        fr: 'zone de suspension pour x secondes',
                                        it: 'zona di sospensione per x secondi',
                                        es: 'zona de suspensión por x segundos',
                                        pl: 'strefa zawiesła na x sekundy',
                                        uk: 'зона підвіски для x секунд',
                                        'zh-cn': '停止x二区',
                                    },
                                    type: 'number',
                                    role: 'level',
                                    read: true,
                                    write: true,
                                },
                                native: {},
                            });

                            await this.setObjectNotExistsAsync(`schedule.${relay.relay}.runDefault`, {
                                type: 'state',
                                common: {
                                    name: {
                                        en: 'run zone for default time',
                                        de: 'Zone mit Standardlaufzeit starten',
                                        ru: 'запустить зону для времени по умолчанию',
                                        pt: 'fuso de execução para o tempo padrão',
                                        nl: 'run zone for default time',
                                        fr: 'run zone for default time',
                                        it: 'run zone per il tempo predefinito',
                                        es: 'zona de ejecución por tiempo predeterminado',
                                        pl: 'strefa czasu domyślnego',
                                        uk: 'зона запуску за замовчуванням',
                                        'zh-cn': 'a. 暂停时间区',
                                    },
                                    type: 'boolean',
                                    role: 'button.start',
                                    read: true,
                                    write: true,
                                },
                                native: {},
                            });
                        }

                        for (const sensor of content.sensors) {
                            if (this.unloaded) {
                                break;
                            }

                            await this.setObjectNotExistsAsync(`schedule.sensors.${sensor.input}`, {
                                type: 'channel',
                                common: {
                                    name: 'sensors',
                                },
                                native: {},
                            });

                            for (let key in sensor) {
                                if (key !== 'relays') {
                                    key = this.name2id(key);

                                    await this.setObjectNotExistsAsync(`schedule.sensors.${sensor.input}.${key}`, {
                                        type: 'state',
                                        common: {
                                            name: key,
                                            type: 'number',
                                            role: 'value',
                                            read: true,
                                            write: false,
                                        },
                                        native: {},
                                    });

                                    void this.setStateChangedAsync(
                                        `schedule.sensors.${sensor.input}.${key}`,
                                        sensor[key],
                                        true,
                                    );
                                }
                            }
                        }
                    }

                    resolve();
                })
                .catch(error => {
                    this.handleRequestError('statusschedule.php', error);

                    resolve();
                });
        });
    }

    private async GetCustomerDetails(): Promise<void> {
        if (!this.mayRequest('customerdetails.php')) {
            return;
        }

        return new Promise(resolve => {
            this.buildRequest('customerdetails.php', { api_key: this.config.apiKey })
                .then(async response => {
                    if (this.unloaded) {
                        resolve();

                        return;
                    }

                    if (response?.status === 200) {
                        const content = response.data;

                        void this.setStateChangedAsync('info.connection', true, true);

                        for (let key in content) {
                            if (key !== 'controllers' && !Number.isNaN(key)) {
                                key = this.name2id(key);

                                await this.setObjectNotExistsAsync(`customer.${key}`, {
                                    type: 'state',
                                    common: {
                                        name: key,
                                        type: key === 'message' || key === 'current_controller' ? 'string' : 'number',
                                        role: key === 'message' || key === 'current_controller' ? 'text' : 'value',
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                });

                                void this.setStateChangedAsync(`customer.${key}`, content[key], true);
                            }
                        }

                        for (const controller of content.controllers) {
                            if (this.unloaded) {
                                break;
                            }

                            await this.setObjectNotExistsAsync(`customer.controllers.${controller.name}`, {
                                type: 'channel',
                                common: {
                                    name: controller.name,
                                },
                                native: {},
                            });

                            for (let key in controller) {
                                key = this.name2id(key);

                                await this.setObjectNotExistsAsync(`customer.controllers.${controller.name}.${key}`, {
                                    type: 'state',
                                    common: {
                                        name: key,
                                        type: key !== 'controller_id' ? 'string' : 'number',
                                        role: key !== 'controller_id' ? 'text' : 'value',
                                        read: true,
                                        write: false,
                                    },
                                    native: {},
                                });

                                if (key === 'last_contact') {
                                    // most controllers report epoch seconds here, but the API also
                                    // answers with plain text like "Unknown" - which used to end up
                                    // in the state as "Invalid Date"
                                    const timestamp = Number(controller[key]);

                                    controller[key] =
                                        Number.isFinite(timestamp) && timestamp > 0
                                            ? new Date(timestamp * 1000).toString()
                                            : String(controller[key] ?? '');
                                }

                                void this.setStateChangedAsync(
                                    `customer.controllers.${controller.name}.${key}`,
                                    controller[key],
                                    true,
                                );
                            }
                        }
                    }

                    resolve();
                })
                .catch(error => {
                    this.handleRequestError('customerdetails.php', error);

                    resolve();
                });
        });
    }

    buildRequest(service: string, params: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const url = `/api/v1/${service}`;

            if (params.api_key) {
                try {
                    axios({
                        method: 'GET',
                        baseURL: hydrawise_url,
                        url: url,
                        timeout: 30000,
                        responseType: 'json',
                        params: params,
                    })
                        .then(response => {
                            // no error - clear up reminder
                            this.lastErrorCode = 0;
                            this.backoff[service] = 0;
                            this.blockedUntil[service] = 0;

                            resolve(response);
                        })
                        .catch(error => {
                            if (error.response) {
                                // The request was made and the server responded with a status code

                                this.log.warn(
                                    `received ${error.response.status} response from ${url} with content: ${JSON.stringify(error.response.data)}`,
                                );
                            } else if (error.request) {
                                // The request was made but no response was received
                                // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                                // http.ClientRequest in node.js

                                // avoid spamming of the same error when stuck in a reconnection loop
                                if (error.code === this.lastErrorCode) {
                                    this.log.debug(error.message);
                                } else {
                                    this.log.info(`error ${error.code} from ${url}: ${error.message}`);
                                    this.lastErrorCode = error.code;
                                }
                            } else {
                                // Something happened in setting up the request that triggered an Error
                                this.log.error(error.message);
                            }

                            reject(error instanceof Error ? error : new Error(String(error)));
                        });
                } catch (error: any) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            } else {
                reject(new Error('API key is not configured'));
            }
        });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     *
     * @param callback callback function
     */
    private onUnload(callback: () => void): void {
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
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (state && !state.ack) {
            if (id.indexOf('stopall') !== -1) {
                void this.buildRequest('setzone.php', { api_key: this.config.apiKey, action: 'stopall' });
            } else if (id.indexOf('stop') !== -1) {
                const relay = id.match(/.*schedule\.(.*)\.stopZone/);

                if (relay && relay?.length > 1) {
                    void this.buildRequest('setzone.php', {
                        api_key: this.config.apiKey,
                        action: 'stop',
                        relay_id: RELAYS[relay[1]],
                    });
                }
            }
            if (id.indexOf('runall') !== -1 && (state.val || state.val === 0)) {
                void this.buildRequest('setzone.php', {
                    api_key: this.config.apiKey,
                    action: 'runall',
                    period_id: 999,
                    custom: state.val,
                });
            } else if (id.indexOf('runZone') !== -1 && (state.val || state.val === 0)) {
                const relay = id.match(/.*schedule\.(.*)\.runZone/);

                if (relay && relay?.length > 1) {
                    void this.buildRequest('setzone.php', {
                        api_key: this.config.apiKey,
                        action: 'run',
                        period_id: 999,
                        custom: state.val,
                        relay_id: RELAYS[relay[1]],
                    });
                }
            }

            if (id.indexOf('runDefault') !== -1 && state.val !== null) {
                void this.initRunDefault(id, state.val as boolean);
            }

            if (id.indexOf('suspendall') !== -1 && (state.val || state.val === 0)) {
                const num = state.val as number;

                void this.buildRequest('setzone.php', {
                    api_key: this.config.apiKey,
                    action: 'suspendall',
                    period_id: 999,
                    custom: Math.trunc((state.ts + num) / 1000),
                });
            } else if (id.indexOf('suspend') !== -1 && (state.val || state.val === 0)) {
                const num = state.val as number;
                const relay = id.match(/.*schedule\.(.*)\.suspendZone/);

                if (relay && relay?.length > 1) {
                    void this.buildRequest('setzone.php', {
                        api_key: this.config.apiKey,
                        action: 'suspend',
                        period_id: 999,
                        custom: Math.trunc((state.ts + num) / 1000),
                        relay_id: RELAYS[relay[1]],
                    });
                }
            }
        }
    }

    async initRunDefault(id: string, run: boolean): Promise<void> {
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
                        (defaultRunTime.val as number) * 1000,
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
    private mayRequest(service: string): boolean {
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
    private handleRequestError(service: string, error: any): void {
        if (error?.response?.status === 429) {
            // being rate limited does not mean the API is unreachable - back off and keep
            // the connection state, otherwise a restart burst looks like an outage
            const pause = Math.min(Math.max((this.backoff[service] || 0) * 2, RATE_LIMIT_PAUSE), RATE_LIMIT_PAUSE_MAX);

            this.backoff[service] = pause;
            this.blockedUntil[service] = Date.now() + pause;

            this.log.info(`${service} hit the API rate limit - pausing it for ${Math.round(pause / 60000)} minutes`);

            return;
        }

        // never stringify the error itself - an axios error carries the api_key in its config
        this.log.debug(`(${service}) received error - API is now offline: ${error?.message ?? String(error)}`);

        this.writeFlag('info.connection', false);
    }

    /**
     * The API reports how often it wants to be polled - warn once when we are faster.
     *
     * @param nextpoll seconds the API asks us to wait
     */
    private checkPollInterval(nextpoll: number): void {
        // the configured value is clamped before it becomes an interval - compare what runs
        const configured = Math.max(15, Number(this.config.apiInterval) || 60);

        if (!nextpoll || this.pollIntervalWarned || configured >= nextpoll) {
            return;
        }

        this.pollIntervalWarned = true;

        this.log.warn(
            `the API asks to be polled every ${nextpoll} seconds, but the adapter polls every ${configured} seconds`,
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
    private async startV2(): Promise<void> {
        if (!this.config.email || !this.config.password) {
            this.log.error('The v2 API is enabled but no e-mail/password is configured!');
            return;
        }

        this.v2 = new HydrawiseV2(this.config.email, this.config.password, {
            debug: message => this.log.debug(`(v2) ${message}`),
            info: message => this.log.info(`(v2) ${message}`),
            warn: message => this.log.warn(`(v2) ${message}`),
            error: message => this.log.error(`(v2) ${message}`),
        });

        this.writeFlag('info.connectionV2', false);

        const minutes = Math.max(2, Number(this.config.v2Interval) || 5);

        await this.pollV2();

        if (!this.v2) {
            // the first poll ran into credentials the API rejects - stopV2 already said so
            return;
        }

        this.v2Timer = this.setInterval(
            () => {
                void this.pollV2();
            },
            minutes * 60 * 1000,
        );

        this.log.info(`v2 API enabled - polling every ${minutes} minutes`);
    }

    /**
     * Stops polling the v2 API, e.g. after the credentials turned out to be wrong
     *
     * @param reason why polling was stopped, ends up in the log
     */
    private stopV2(reason: string): void {
        this.clearInterval(this.v2Timer);
        this.v2Timer = null;
        this.v2 = null;

        this.writeFlag('info.connectionV2', false);

        this.log.error(`(v2) polling stopped: ${reason}`);
    }

    /** One poll cycle - every query is applied on its own so a single failure is not fatal */
    private async pollV2(): Promise<void> {
        if (!this.v2 || this.unloaded || this.v2Polling) {
            return;
        }

        // four requests at a 30 s timeout can outlast the shortest poll interval
        this.v2Polling = true;
        this.v2AnySection = false;

        try {
            const controllerId = await this.resolveV2Controller();

            if (controllerId === null) {
                return;
            }

            const bounds = periodBounds();

            const snapshot = await this.v2Section('snapshot', () => this.v2!.getSnapshot(controllerId));
            let zones: ZoneSummary | null = null;

            if (snapshot) {
                await this.applyV2Status(snapshot);

                if (this.config.v2Weather) {
                    await this.applyV2Observations(snapshot.observationsSummary);
                }

                await this.applyV2Sensors(snapshot.sensors || []);

                zones = await this.applyV2Zones(snapshot.zones || []);
            }

            // the values of the current day are refreshed on every poll
            const flow = await this.v2Section('flow today', () =>
                this.v2!.getFlowSummary(controllerId, bounds.todayStart, bounds.now),
            );
            const report = await this.v2Section('report today', () =>
                this.v2!.getReport(controllerId, bounds.todayStart, bounds.now),
            );

            const volume = flow ? sumFlow(flow) : null;
            const usage = report ? summarizeRuns(report) : null;

            await this.applyV2Usage('today', volume, usage);
            await this.applyV2ZoneUsage(zones, usage, usage?.unit || volume?.unit || 'l');
            await this.applyV2Leak(volume, usage, zones);

            // the longer periods take turns, one request per poll
            await this.pollV2Periods(controllerId, bounds);

            // every query is caught individually, so a total outage raises no exception -
            // without this the indicator would stay green through hours of stale values
            this.writeFlag('info.connectionV2', this.v2AnySection);

            if (this.v2AnySection) {
                await this.setV2State(
                    'water.lastUpdate',
                    { name: 'last v2 update', type: 'string', role: 'date' },
                    new Date().toISOString(),
                );
            } else {
                this.log.debug('(v2) no query of this poll returned data');
            }
        } catch (error: any) {
            if (error instanceof NotAuthorizedError) {
                this.stopV2(`login failed - check e-mail and password (${error.message})`);
                return;
            }

            this.writeFlag('info.connectionV2', false);

            this.log.warn(`(v2) poll failed: ${error.message}`);
        } finally {
            this.v2Polling = false;
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
    private async pollV2Periods(controllerId: number, bounds: PeriodBounds): Promise<void> {
        const tasks = this.v2FirstPoll ? V2_PERIOD_TASKS : [V2_PERIOD_TASKS[this.v2Period++ % V2_PERIOD_TASKS.length]];

        this.v2FirstPoll = false;

        for (const task of tasks) {
            if (this.unloaded) {
                return;
            }

            const [from, until] = periodRange(task.period, bounds);

            const sensors = await this.v2Section(`flow ${task.period}`, () =>
                this.v2!.getFlowSummary(controllerId, from, until),
            );

            const entries = task.withReport
                ? await this.v2Section(`report ${task.period}`, () => this.v2!.getReport(controllerId, from, until))
                : null;

            await this.applyV2Usage(
                task.period,
                sensors ? sumFlow(sensors) : null,
                entries ? summarizeRuns(entries) : null,
            );
        }
    }

    /**
     * Runs one query and keeps the adapter alive when only this query fails
     *
     * @param name label of the query, used in the warning when it fails
     * @param run the query to run
     */
    private async v2Section<T>(name: string, run: () => Promise<T>): Promise<T | null> {
        try {
            const result = await run();

            this.v2Errors[name] = 0;
            this.v2AnySection = true;

            return result;
        } catch (error: any) {
            if (error instanceof NotAuthorizedError) {
                throw error;
            }

            const count = (this.v2Errors[name] = (this.v2Errors[name] || 0) + 1);

            if (error instanceof ThrottledError) {
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
    private writeFlag(id: string, value: boolean): void {
        if (this.unloaded) {
            return;
        }

        this.setStateChangedAsync(id, value, true).catch(() => {
            /* the adapter is going down, nobody is left to tell */
        });
    }

    /** Id of the controller to query - configured explicitly or the first one of the account */
    private async resolveV2Controller(): Promise<number | null> {
        if (this.v2ControllerId !== null) {
            return this.v2ControllerId;
        }

        if (Number(this.config.v2ControllerId) > 0) {
            this.v2ControllerId = Number(this.config.v2ControllerId);

            return this.v2ControllerId;
        }

        const controllers = await this.v2!.getControllers();

        if (!controllers.length) {
            this.log.error('(v2) no controller found for this account');

            return null;
        }

        this.v2ControllerId = controllers[0].id;

        this.log.info(`(v2) using controller "${controllers[0].name}" (id ${controllers[0].id})`);

        return this.v2ControllerId;
    }

    private async applyV2Status(controller: any): Promise<void> {
        await this.ensureV2Channel('controller', 'Controller');

        const status = controller.status || {};
        const hardware = controller.hardware || {};

        await this.setV2State(
            'controller.online',
            { name: 'controller online', type: 'boolean', role: 'indicator.reachable' },
            !!(controller.online ?? status.online),
        );
        await this.setV2State(
            'controller.status',
            { name: 'status summary', type: 'string', role: 'text' },
            status.summary ?? null,
        );
        await this.setV2State(
            'controller.lastContact',
            { name: 'last contact', type: 'string', role: 'date' },
            dateValue(status.lastContact) ?? dateValue(controller.lastContactTime),
        );
        await this.setV2State(
            'controller.name',
            { name: 'controller name', type: 'string', role: 'text' },
            controller.name ?? null,
        );
        await this.setV2State(
            'controller.model',
            { name: 'controller model', type: 'string', role: 'text' },
            hardware.model?.name ?? null,
        );
        await this.setV2State(
            'controller.serialNumber',
            { name: 'serial number', type: 'string', role: 'text' },
            hardware.serialNumber ?? null,
        );
        await this.setV2State(
            'controller.firmwareVersion',
            { name: 'firmware version', type: 'string', role: 'text' },
            hardware.version ?? null,
        );
        await this.setV2State(
            'controller.waterSavings',
            { name: 'accumulated water savings', unit: '%' },
            status.accumulatedWaterSavings ?? null,
        );
    }

    private async applyV2Observations(observations: any): Promise<void> {
        if (!observations) {
            return;
        }

        await this.ensureV2Channel('weather', 'Weather station');

        await this.setV2State(
            'weather.rainfallLast24h',
            {
                name: 'rainfall last 24 hours',
                role: 'value.precipitation',
                unit: localizedUnit(observations.rainfallLast24Hours, 'mm'),
            },
            localizedNumber(observations.rainfallLast24Hours) ?? undefined,
        );
        await this.setV2State(
            'weather.rainfallLast7d',
            {
                name: 'rainfall last 7 days',
                role: 'value.precipitation',
                unit: localizedUnit(observations.rainfallLast168hours, 'mm'),
            },
            localizedNumber(observations.rainfallLast168hours) ?? undefined,
        );
        await this.setV2State(
            'weather.temperature',
            {
                name: 'current temperature',
                role: 'value.temperature',
                unit: localizedUnit(observations.currentTemperature, '°C'),
            },
            localizedNumber(observations.currentTemperature) ?? undefined,
        );
        await this.setV2State(
            'weather.temperatureMax',
            {
                name: 'max temperature since midnight',
                role: 'value.temperature',
                unit: localizedUnit(observations.maxTemperatureSinceMidnight, '°C'),
            },
            localizedNumber(observations.maxTemperatureSinceMidnight) ?? undefined,
        );
    }

    private async applyV2Sensors(sensors: any[]): Promise<void> {
        if (!sensors.length) {
            return;
        }

        await this.ensureV2Channel('sensors', 'Sensors');

        for (const sensor of sensors) {
            const input = sensor?.input?.number;

            if (input === undefined || input === null) {
                continue;
            }

            const base = `sensors.${this.name2id(String(input))}`;

            await this.ensureV2Channel(base, sensor.name || `sensor ${input}`);

            await this.setV2State(
                `${base}.name`,
                { name: 'sensor name', type: 'string', role: 'text' },
                sensor.name ?? null,
            );
            await this.setV2State(
                `${base}.type`,
                { name: 'sensor type', type: 'string', role: 'text' },
                sensor.model?.sensorType ?? null,
            );
            await this.setV2State(
                `${base}.model`,
                { name: 'sensor model', type: 'string', role: 'text' },
                sensor.model?.name ?? null,
            );
            await this.setV2State(
                `${base}.terminal`,
                { name: 'controller terminal', type: 'string', role: 'text' },
                sensor.input?.label ?? null,
            );

            // a level sensor (rain, moisture) reports whether it is currently triggered,
            // a flow meter leaves this null
            if (sensor.status?.active !== null && sensor.status?.active !== undefined) {
                await this.setV2State(
                    `${base}.active`,
                    { name: 'sensor is triggered', type: 'boolean', role: 'indicator' },
                    !!sensor.status.active,
                );
            }

            if (sensor.status?.waterFlow) {
                await this.setV2State(
                    `${base}.waterFlow`,
                    {
                        name: 'water flow reported by the sensor',
                        unit: localizedUnit(sensor.status.waterFlow),
                    },
                    localizedNumber(sensor.status.waterFlow, 0),
                );
            }
        }
    }

    private async applyV2Zones(zones: any[]): Promise<ZoneSummary> {
        const summary: ZoneSummary = { byId: new Map(), anyRunning: false };

        if (!zones.length) {
            return summary;
        }

        await this.ensureV2Channel('zones', 'Zones');

        for (const zone of zones) {
            const number = zone?.number?.value ?? zone?.id;

            if (number === undefined || number === null) {
                continue;
            }

            const base = `zones.${this.name2id(String(number))}`;
            const runs = zone.scheduledRuns || {};
            const current = runs.currentRun;
            const running = !!current;

            summary.byId.set(zone.id, base);
            summary.anyRunning = summary.anyRunning || running;

            await this.ensureV2Channel(base, zone.name || `zone ${number}`);

            await this.setV2State(`${base}.id`, { name: 'zone id' }, zone.id);
            await this.setV2State(
                `${base}.name`,
                { name: 'zone name', type: 'string', role: 'text' },
                zone.name ?? null,
            );
            await this.setV2State(
                `${base}.running`,
                { name: 'zone is watering', type: 'boolean', role: 'indicator.working' },
                running,
            );
            await this.setV2State(
                `${base}.status`,
                { name: 'run status', type: 'string', role: 'text' },
                runs.status ?? null,
            );
            await this.setV2State(
                `${base}.remainingTime`,
                { name: 'remaining run time', unit: 's' },
                running ? Number(current.remainingTime) || 0 : 0,
            );
            await this.setV2State(
                `${base}.currentWater`,
                { name: 'water used by the running zone', unit: localizedUnit(runs.currentWaterUsage, 'l') },
                running ? localizedNumber(runs.currentWaterUsage, 0) : 0,
            );
            await this.setV2State(
                `${base}.nextRun`,
                { name: 'next run', type: 'string', role: 'date' },
                dateValue(runs.nextRun?.startTime),
            );
            await this.setV2State(
                `${base}.nextRunDuration`,
                { name: 'duration of the next run', unit: 'min' },
                runs.nextRun?.duration ?? null,
            );
            await this.setV2State(
                `${base}.suspendedUntil`,
                { name: 'suspended until', type: 'string', role: 'date' },
                dateValue(zone.status?.suspendedUntil),
            );
            await this.setV2State(
                `${base}.waterBalance`,
                { name: 'relative water balance', unit: '%' },
                zone.status?.relativeWaterBalance ?? null,
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
    private async applyV2Usage(period: Period, volume: FlowSummary | null, usage: UsageSummary | null): Promise<void> {
        if (!volume && !usage) {
            return;
        }

        await this.ensureV2Channel('water', 'Water usage');

        const unit = volume?.unit || usage?.unit || 'l';

        // for today a zero is a fact, for a whole year a null answer is more likely a gap
        // in the API than an empty year - overwriting the history with 0 is the worse guess
        if (volume?.hasFlowSensor && (volume.hasValue || period === 'today' || period === 'yesterday')) {
            await this.setV2State(`water.${period}`, { name: `water usage ${period}`, unit }, volume.total);
        }

        if (!usage) {
            return;
        }

        await this.setV2State(
            `water.${period}Active`,
            { name: `water used for watering ${period}`, unit },
            usage.active,
        );
        await this.setV2State(`water.${period}Runtime`, { name: `watering time ${period}`, unit: 's' }, usage.runtime);

        if (volume?.hasFlowSensor) {
            await this.setV2State(
                `water.${period}Inactive`,
                { name: `water used outside of watering ${period}`, unit },
                inactiveVolume(volume, usage),
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
    private async applyV2ZoneUsage(zones: ZoneSummary | null, today: UsageSummary | null, unit: string): Promise<void> {
        if (!zones || !today) {
            return;
        }

        for (const [zoneId, base] of zones.byId) {
            const usage = today.byZone.get(zoneId);

            await this.setV2State(`${base}.waterToday`, { name: 'water used today', unit }, usage?.water ?? 0);
            await this.setV2State(
                `${base}.runtimeToday`,
                { name: 'watering time today', unit: 's' },
                usage?.runtime ?? 0,
            );

            if (usage?.latest) {
                await this.setV2State(
                    `${base}.scheduleStatus`,
                    { name: 'status of the most recent scheduled run', type: 'string', role: 'text' },
                    usage.latest.scheduledStatus?.label ?? null,
                );
            }

            const last = usage?.last;

            if (!last) {
                continue;
            }

            await this.setV2State(
                `${base}.lastRunStart`,
                { name: 'start of the last run', type: 'string', role: 'date' },
                dateValue(last.reportedStartTime),
            );
            await this.setV2State(
                `${base}.lastRunEnd`,
                { name: 'end of the last run', type: 'string', role: 'date' },
                dateValue(last.reportedEndTime),
            );
            await this.setV2State(
                `${base}.lastRunDuration`,
                { name: 'duration of the last run', unit: 's' },
                Number(last.reportedDuration) || 0,
            );
            await this.setV2State(
                `${base}.lastRunWater`,
                { name: 'water used by the last run', unit },
                localizedNumber(last.reportedWaterUsage, 0),
            );
            await this.setV2State(
                `${base}.lastRunStatus`,
                { name: 'status of the last run', type: 'string', role: 'text' },
                last.reportedStatus?.label ?? null,
            );
            await this.setV2State(
                `${base}.lastRunOk`,
                { name: 'last run finished normally', type: 'boolean', role: 'indicator' },
                last.reportedStopReason?.finishedNormally ?? null,
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
    private async applyV2Leak(
        volume: FlowSummary | null,
        usage: UsageSummary | null,
        zones: ZoneSummary | null,
    ): Promise<void> {
        if (!volume?.hasFlowSensor || !usage) {
            return;
        }

        // the report only records a run once it finished, so while a zone is watering the
        // flow meter is ahead of it - that difference is not a leak. Keep the last verdict.
        // Without a snapshot we do not know whether a zone is running, so we cannot judge.
        if (!zones || zones.anyRunning) {
            return;
        }

        const threshold = Number(this.config.leakThreshold) || 0;

        if (threshold <= 0) {
            return;
        }

        const suspected = inactiveVolume(volume, usage) > threshold;
        // a run that just finished is not in the report yet, and a run across midnight puts
        // its water into today's flow summary but its start into yesterday's report - both
        // resolve within a poll or two, so only a verdict that survives twice is reported
        const confirmed = suspected && this.leakSeen;

        this.leakSeen = suspected;

        await this.setV2State(
            'water.leakSuspected',
            { name: 'water used today without any zone running', type: 'boolean', role: 'indicator.alarm' },
            confirmed,
        );
    }

    /**
     * Creates a channel once per adapter run
     *
     * @param id id of the channel
     * @param name display name of the channel
     */
    private async ensureV2Channel(id: string, name: string): Promise<void> {
        if (this.v2Objects.has(`channel:${id}`) || this.unloaded) {
            return;
        }

        await this.setObjectNotExistsAsync(id, { type: 'channel', common: { name }, native: {} });

        this.v2Objects.add(`channel:${id}`);
    }

    /**
     * Creates the state on first use (units are only known once the API answered) and writes its value
     *
     * @param id id of the state
     * @param common common properties used when the state is created
     * @param value value to write
     */
    private async setV2State(id: string, common: Partial<ioBroker.StateCommon>, value: any): Promise<void> {
        if (value === undefined || this.unloaded) {
            return;
        }

        const unit = typeof common.unit === 'string' ? common.unit : '';

        // the unit follows the account settings and is only known once something has flowed,
        // so a state created during a dry spell carries the fallback until a real one arrives
        if (!this.v2Objects.has(id) || (unit && this.v2Units[id] !== unit)) {
            const definition: ioBroker.StateCommon = {
                name: id.split('.').pop() as string,
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                ...common,
            };

            const existing = await this.getObjectAsync(id);

            if (!existing) {
                await this.setObjectAsync(id, { type: 'state', common: definition, native: {} });
            } else if (definition.unit && existing.common?.unit !== definition.unit) {
                // the unit follows the account settings (litres/gallons) and is only known
                // once the API answered - correct it, but leave the object alone otherwise
                await this.extendObjectAsync(id, { common: { unit: definition.unit } });
            }

            this.v2Objects.add(id);
            this.v2Units[id] = unit;
        }

        await this.setStateChangedAsync(id, value, true);
    }

    name2id(pName: string): string {
        return (pName || '').replace(this.FORBIDDEN_CHARS, '_');
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Hydrawise(options);
} else {
    // otherwise start the instance directly
    (() => new Hydrawise())();
}
