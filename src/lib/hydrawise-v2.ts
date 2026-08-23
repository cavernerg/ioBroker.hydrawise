/*
 * Client for the Hydrawise v2 API (OAuth2 + GraphQL).
 *
 * The v1 REST API (api.hydrawise.com/api/v1) only exposes the sensor configuration
 * and cannot report water usage at all. The v2 API used by the Hydrawise app does:
 * flow meter volumes, per zone water usage, sensor states and rainfall observations.
 *
 * Two things about this API are not obvious:
 *
 *  - `DateTime` is an object type, not a scalar - it always needs a sub selection.
 *  - A field that takes arguments must not appear twice in the same query, not even
 *    under different aliases. The server answers from the first occurrence: two
 *    `flowSummary` calls return null for both, two `watering` calls return the same
 *    list twice. Every parameterized call therefore gets its own request.
 */

import axios from 'axios';

const TOKEN_URL = 'https://app.hydrawise.com/api/v2/oauth/access-token';
const GRAPHQL_URL = 'https://app.hydrawise.com/api/v2/graph';

/** Credentials of the official Hydrawise app - the v2 API is not open for own client registrations */
const CLIENT_ID = 'hydrawise_app';
const CLIENT_SECRET = 'zn3CrjglwNV1';

const REQUEST_TIMEOUT = 30000;

export interface V2Logger {
    debug: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
}

/** A value together with the unit the account is configured for (l/gal, mm/in, °C/°F) */
export interface LocalizedValue {
    value: number | null;
    unit: string | null;
    longUnit?: string | null;
}

/*
 * `ZoneStatus.lastRun` and `ZoneStatus.nextRun` are declared as `DateTime!` but the
 * resolver answers null when a zone has no scheduled run, which makes the whole request
 * fail with "Internal server error". They are therefore not queried - the next run comes
 * from `scheduledRuns.nextRun`, the last run from the watering report.
 *
 * Durations differ per type: `ScheduledZoneRun.duration`/`normalDuration` are minutes,
 * `remainingTime` and `RunEventType.reportedDuration` are seconds.
 */

/** The API's DateTime object */
export interface ApiDateTime {
    value: string | null;
    timestamp: number | null;
}

export interface V2Controller {
    id: number;
    name: string | null;
}

/** Thrown for wrong credentials - retrying with the same credentials is pointless */
export class NotAuthorizedError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'NotAuthorizedError';
    }
}

/** Thrown when the API rejects the request because of rate limiting */
export class ThrottledError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'ThrottledError';
    }
}

const DATE_TIME = '{ value timestamp }';

const QUERY_CONTROLLERS = `query Controllers {
    me {
        customerId
        controllers { id name }
    }
}`;

/**
 * Everything that does not take arguments, in a single request: controller status,
 * weather observations, sensors and zones.
 */
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

/** Total volume through the flow meters for one period. Never combine two of these. */
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

/** Watering report for one period. Never combine two of these. */
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

export interface PeriodBounds {
    todayStart: number;
    now: number;
    ydayStart: number;
    ydayEnd: number;
    weekStart: number;
    monthStart: number;
    yearStart: number;
}

export class HydrawiseV2 {
    private token: string | null = null;
    private tokenType = 'Bearer';
    private refreshToken: string | null = null;
    private expires = 0;
    private pendingAuth: Promise<void> | null = null;

    public constructor(
        private readonly email: string,
        private readonly password: string,
        private readonly log: V2Logger,
    ) {}

    /** Forget the current token, e.g. after the credentials have been changed */
    public reset(): void {
        this.token = null;
        this.refreshToken = null;
        this.expires = 0;
    }

    private async fetchToken(useRefresh: boolean): Promise<void> {
        const data = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        });

        if (useRefresh && this.refreshToken) {
            data.set('grant_type', 'refresh_token');
            data.set('refresh_token', this.refreshToken);
        } else {
            data.set('grant_type', 'password');
            data.set('scope', 'all');
            data.set('username', this.email);
            data.set('password', this.password);
        }

        const response = await axios({
            method: 'POST',
            url: TOKEN_URL,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            data: data.toString(),
            timeout: REQUEST_TIMEOUT,
            responseType: 'json',
            validateStatus: () => true,
            // a 307/308 would replay the body - and with it the account password - to
            // whatever host the redirect points at
            maxRedirects: 0,
        });

        const body = response.data || {};

        if (body.error || !body.access_token) {
            // a rejected refresh token is not a credential problem - start over with a full login
            if (useRefresh) {
                this.log.debug(`refreshing the v2 token failed (${JSON.stringify(body.error)}), logging in again`);
                this.refreshToken = null;
                return this.fetchToken(false);
            }

            // a 429 or a 5xx says nothing about the credentials - treating it as a login
            // failure would stop the v2 polling for good over a transient server problem
            if (response.status === 429) {
                throw new ThrottledError('login: too many requests');
            }

            if (![400, 401, 403].includes(response.status) || !body.error) {
                throw new Error(`login: HTTP ${response.status} ${String(body.message || body.error || '')}`.trim());
            }

            this.reset();
            throw new NotAuthorizedError(String(body.message || body.error || `HTTP ${response.status}`));
        }

        this.token = body.access_token;
        this.tokenType = body.token_type || 'Bearer';
        this.refreshToken = body.refresh_token || null;
        this.expires = Date.now() + (Number(body.expires_in) || 3600) * 1000;

        this.log.debug(`v2 token acquired, valid until ${new Date(this.expires).toISOString()}`);
    }

    private async ensureToken(): Promise<void> {
        // refresh a couple of minutes before the token actually expires
        if (this.token && this.expires - Date.now() > 5 * 60 * 1000) {
            return;
        }

        // make sure parallel queries do not trigger several logins
        this.pendingAuth ??= (async () => {
            try {
                await this.fetchToken(!!this.refreshToken);
            } finally {
                this.pendingAuth = null;
            }
        })();

        await this.pendingAuth;
    }

    private async post(query: string, variables: Record<string, unknown>): Promise<any> {
        return axios({
            method: 'POST',
            url: GRAPHQL_URL,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `${this.tokenType} ${this.token}`,
            },
            data: { query, variables },
            timeout: REQUEST_TIMEOUT,
            responseType: 'json',
            validateStatus: () => true,
            maxRedirects: 0,
        });
    }

    /**
     * Runs a GraphQL query and returns its data section.
     *
     * @param name name of the query, only used for logging
     * @param query the GraphQL query
     * @param variables variables of the query
     */
    public async query<T = any>(name: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
        await this.ensureToken();

        let response = await this.post(query, variables);

        if (response.status === 401) {
            // token was revoked server side - get a new one and try again
            this.token = null;
            await this.ensureToken();
            response = await this.post(query, variables);

            if (response.status === 401) {
                // the credentials are good enough for a token but the account cannot use
                // the API - retrying every poll would hammer the login endpoint forever
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

        const errors = response.data?.errors;
        if (Array.isArray(errors) && errors.length) {
            const message = errors.map((e: any) => e?.message).join('; ');
            if (/too many requests|rate limit|throttl/i.test(message)) {
                throw new ThrottledError(`${name}: ${message}`);
            }
            throw new Error(`${name}: ${message}`);
        }

        if (!response.data?.data) {
            throw new Error(`${name}: empty response`);
        }

        return response.data.data as T;
    }

    /** All controllers of the account */
    public async getControllers(): Promise<V2Controller[]> {
        const data = await this.query('controllers', QUERY_CONTROLLERS);
        return (data?.me?.controllers || []).filter((c: any) => c && typeof c.id === 'number');
    }

    /**
     * Controller status, weather observations, sensors and zones in one request
     *
     * @param controllerId the controller to query
     */
    public async getSnapshot(controllerId: number): Promise<any> {
        const data = await this.query('snapshot', QUERY_SNAPSHOT, { cid: controllerId });
        return data?.controller;
    }

    /**
     * Volume through the flow meters between two points in time.
     *
     * @param controllerId the controller to query
     * @param start start of the period, epoch seconds
     * @param end end of the period, epoch seconds
     */
    public async getFlowSummary(controllerId: number, start: number, end: number): Promise<any[]> {
        const data = await this.query('flowSummary', QUERY_FLOW, { cid: controllerId, start, end });
        return data?.controller?.sensors || [];
    }

    /**
     * Watering report - one entry per scheduled run, with the values the controller reported back.
     *
     * @param controllerId the controller to query
     * @param from start of the period, epoch seconds
     * @param until end of the period, epoch seconds
     */
    public async getReport(controllerId: number, from: number, until: number): Promise<any[]> {
        const data = await this.query('watering', QUERY_REPORT, { cid: controllerId, from, until });
        return data?.controller?.reports?.watering || [];
    }
}

/**
 * Start/end timestamps (epoch seconds, local time) of the reporting periods
 *
 * @param reference the point in time the periods are calculated from
 */
export function periodBounds(reference: Date = new Date()): PeriodBounds {
    const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

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
        yearStart: seconds(new Date(reference.getFullYear(), 0, 1)),
    };
}

/**
 * Numeric part of a localized value, `fallback` when the API reported nothing
 *
 * @param value the localized value as returned by the API
 * @param fallback result when the API reported no number
 */
export function localizedNumber(
    value: LocalizedValue | null | undefined,
    fallback: number | null = null,
): number | null {
    const num = value?.value;
    return typeof num === 'number' && !Number.isNaN(num) ? num : fallback;
}

/**
 * Unit of a localized value, `fallback` when the API reported nothing
 *
 * @param value the localized value as returned by the API
 * @param fallback result when the API reported no unit
 */
export function localizedUnit(value: LocalizedValue | null | undefined, fallback = ''): string {
    return value?.unit || fallback;
}

/**
 * ISO string of an API DateTime, null when it did not report one
 *
 * @param date the DateTime object as returned by the API
 */
export function dateValue(date: ApiDateTime | null | undefined): string | null {
    if (typeof date?.timestamp === 'number' && date.timestamp > 0) {
        return new Date(date.timestamp * 1000).toISOString();
    }

    return date?.value || null;
}

/**
 * Epoch milliseconds of an API DateTime, 0 when it did not report one
 *
 * @param date the DateTime object as returned by the API
 */
export function dateStamp(date: ApiDateTime | null | undefined): number {
    if (typeof date?.timestamp === 'number' && date.timestamp > 0) {
        return date.timestamp * 1000;
    }

    const parsed = Date.parse(date?.value ?? '');

    return Number.isNaN(parsed) ? 0 : parsed;
}

/** Periods the water usage is reported for */
export type Period = 'today' | 'yesterday' | 'week' | 'month' | 'year';

/** Total volume through the flow meters of a controller for one period */
export interface FlowSummary {
    hasFlowSensor: boolean;
    /** false when every flow meter answered null, so the total is an assumption, not a reading */
    hasValue: boolean;
    total: number;
    unit: string;
}

/** Water usage of one reporting period, taken from the watering report */
export interface UsageSummary {
    active: number;
    runtime: number;
    unit: string;
    byZone: Map<number, { water: number; runtime: number; last: any; latest: any }>;
}

/**
 * Start and end of a reporting period.
 *
 * @param period the period to look up
 * @param bounds start/end of the reporting periods
 */
export function periodRange(period: Period, bounds: PeriodBounds): [number, number] {
    switch (period) {
        case 'yesterday':
            return [bounds.ydayStart, bounds.ydayEnd];
        case 'week':
            return [bounds.weekStart, bounds.now];
        case 'month':
            return [bounds.monthStart, bounds.now];
        case 'year':
            return [bounds.yearStart, bounds.now];
        default:
            return [bounds.todayStart, bounds.now];
    }
}

/**
 * Adds up the flow meters of a controller.
 *
 * @param sensors sensors as returned by a flow summary query
 */
export function sumFlow(sensors: any[]): FlowSummary {
    const summary: FlowSummary = { hasFlowSensor: false, hasValue: false, total: 0, unit: '' };

    for (const sensor of sensors) {
        if (sensor?.model?.sensorType !== 'FLOW') {
            continue;
        }

        const volume = sensor.flowSummary?.totalWaterVolume;
        // the API answers with null when nothing flowed in that period - for a short period
        // that is a zero, for a long one the caller may prefer to keep the previous value
        const reading = localizedNumber(volume);

        summary.hasFlowSensor = true;
        summary.hasValue = summary.hasValue || reading !== null;
        summary.total += reading ?? 0;
        summary.unit = summary.unit || localizedUnit(volume);
    }

    summary.total = Math.round(summary.total * 100) / 100;

    return summary;
}

/**
 * Adds up the runs of a watering report, per controller and per zone.
 *
 * @param entries entries of the watering report
 */
export function summarizeRuns(entries: any[]): UsageSummary {
    const summary: UsageSummary = { active: 0, runtime: 0, unit: '', byZone: new Map() };

    for (const entry of entries) {
        const run = entry?.runEvent;

        if (!run?.zone) {
            continue;
        }

        const zone = summary.byZone.get(run.zone.id) || { water: 0, runtime: 0, last: null, latest: null };

        // entries without a reported start were scheduled but did not run - they still
        // carry the reason (rain sensor, suspension), which is worth keeping
        if (!zone.latest || dateStamp(run.scheduledStartTime) >= dateStamp(zone.latest.scheduledStartTime)) {
            zone.latest = run;
        }

        if (run.reportedStartTime) {
            const water = localizedNumber(run.reportedWaterUsage, 0) as number;
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

/**
 * Water that flowed without a zone running. The watering report and the flow summary are
 * not updated at the same time, so a negative difference only means the report is ahead.
 *
 * @param volume total volume through the flow meters
 * @param usage watering report of the same period
 */
export function inactiveVolume(volume: FlowSummary, usage: UsageSummary): number {
    return volume.total > usage.active ? Math.round((volume.total - usage.active) * 100) / 100 : 0;
}
