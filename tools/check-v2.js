#!/usr/bin/env node
/*
 * Diagnostic helper for the Hydrawise v2 API.
 *
 * Reads the credentials from the instance configuration (they never appear on the
 * command line), runs every query the adapter uses and reports what the API answers.
 * Use it to verify the credentials and to see which parts of the API this account
 * is allowed to read, without touching the running adapter.
 *
 *   node tools/check-v2.js [instance]      # default instance: 0
 *
 * Set IOB_BIN when the ioBroker CLI does not sit three directories above this file.
 */

const { execFileSync } = require('node:child_process');
const { statSync } = require('node:fs');
const path = require('node:path');
const {
    HydrawiseV2,
    dateValue,
    localizedNumber,
    localizedUnit,
    periodBounds,
    periodRange,
    sumFlow,
    summarizeRuns,
} = require('../build/lib/hydrawise-v2');

const instance = process.argv[2] || '0';
const PERIODS = ['today', 'yesterday', 'week', 'month', 'year'];

/** Absolute path of the ioBroker CLI - never a bare name, that would be a PATH hijack */
function iobrokerBin() {
    const candidates = [process.env.IOB_BIN, path.resolve(__dirname, '../../../iobroker'), '/opt/iobroker/iobroker'];
    // a bare existence check would happily return the iobroker user's home directory
    const found = candidates.find(candidate => {
        try {
            return !!candidate && statSync(candidate).isFile();
        } catch {
            return false;
        }
    });

    if (!found) {
        throw new Error('cannot find the ioBroker CLI - set IOB_BIN to its absolute path');
    }

    return found;
}

/**
 * Reads one object through the ioBroker CLI
 *
 * @param id id of the object
 */
function getObject(id) {
    return JSON.parse(execFileSync(iobrokerBin(), ['object', 'get', id], { encoding: 'utf-8' }));
}

/**
 * Runs one query and reports whether it worked
 *
 * @param name label of the section
 * @param run the query to run
 */
async function section(name, run) {
    process.stdout.write(`\n### ${name}\n`);
    try {
        const result = await run();
        console.log('  OK');
        return result;
    } catch (error) {
        console.log(`  FAILED: ${error.message}`);
        return null;
    }
}

/**
 * Keeps enough of an address to recognize it, not enough to reuse it
 *
 * @param email the account address
 */
function maskEmail(email) {
    const [local, domain] = String(email).split('@');
    return `${local.slice(0, 1)}***@${domain ?? '?'}`;
}

async function main() {
    const secret = getObject('system.config').native.secret;
    const config = getObject(`system.adapter.hydrawise.${instance}`).native;

    if (!config.email || !config.password) {
        console.error('No e-mail/password configured for this instance - enter them in the admin UI first.');
        process.exit(1);
    }

    // the field is listed in encryptedNative, so the stored value is always encrypted
    const { tools } = require('@iobroker/js-controller-common');
    const password = tools.decrypt(secret, config.password);

    console.log(`account   : ${maskEmail(config.email)}`);
    console.log(`password  : ${'*'.repeat(8)}`);

    const client = new HydrawiseV2(config.email, password, {
        debug: message => console.log(`  debug: ${message}`),
        info: message => console.log(`  info: ${message}`),
        warn: message => console.log(`  warn: ${message}`),
        error: message => console.log(`  error: ${message}`),
    });

    const controllers = await section('login + controllers', () => client.getControllers());

    if (!controllers || !controllers.length) {
        console.error('\nno controller returned - cannot continue');
        process.exit(1);
    }

    console.log(`  ${controllers.map(c => `${c.name} (id ${c.id})`).join(', ')}`);

    const controllerId = Number(config.v2ControllerId) > 0 ? Number(config.v2ControllerId) : controllers[0].id;
    const bounds = periodBounds();

    const snapshot = await section('snapshot (status, weather, sensors, zones)', () =>
        client.getSnapshot(controllerId),
    );

    if (snapshot) {
        const status = snapshot.status || {};
        console.log(`  controller : online=${snapshot.online ?? status.online} "${status.summary}"`);
        console.log(`  last contact: ${dateValue(status.lastContact) ?? dateValue(snapshot.lastContactTime)}`);
        console.log(`  hardware   : ${snapshot.hardware?.model?.name} fw ${snapshot.hardware?.version}`);

        const observations = snapshot.observationsSummary || {};
        console.log(
            `  weather    : rain24h=${localizedNumber(observations.rainfallLast24Hours)} ${localizedUnit(observations.rainfallLast24Hours)}` +
                ` rain7d=${localizedNumber(observations.rainfallLast168hours)} ${localizedUnit(observations.rainfallLast168hours)}` +
                ` temp=${localizedNumber(observations.currentTemperature)} ${localizedUnit(observations.currentTemperature)}`,
        );

        for (const sensor of snapshot.sensors || []) {
            console.log(
                `  sensor ${sensor.input?.number} (${sensor.input?.label}): "${sensor.name}" ${sensor.model?.sensorType}` +
                    ` active=${sensor.status?.active} waterFlow=${localizedNumber(sensor.status?.waterFlow)} ${localizedUnit(sensor.status?.waterFlow)}`,
            );
        }

        for (const zone of snapshot.zones || []) {
            const runs = zone.scheduledRuns || {};
            console.log(
                `  zone ${zone.number?.value} "${zone.name}" (id ${zone.id}) running=${!!runs.currentRun}` +
                    ` next=${dateValue(runs.nextRun?.startTime)}` +
                    ` nextDuration=${runs.nextRun?.duration} normal=${runs.nextRun?.normalDuration}` +
                    ` balance=${zone.status?.relativeWaterBalance}%`,
            );
        }
    }

    for (const period of PERIODS) {
        const [from, until] = periodRange(period, bounds);
        const sensors = await section(`flow summary ${period}`, () => client.getFlowSummary(controllerId, from, until));

        if (sensors) {
            const volume = sumFlow(sensors);
            console.log(
                `  ${volume.total} ${volume.unit || '-'} over ${sensors.length} sensor(s)` +
                    `${volume.hasValue ? '' : ' (every meter answered null - nothing flowed)'}`,
            );
        }
    }

    for (const period of ['today', 'yesterday']) {
        const [from, until] = periodRange(period, bounds);
        const entries = await section(`watering report ${period}`, () => client.getReport(controllerId, from, until));

        if (entries) {
            const usage = summarizeRuns(entries);
            const ran = entries.filter(entry => entry?.runEvent?.reportedStartTime).length;

            console.log(
                `  ${entries.length} scheduled, ${ran} actually ran, ${usage.active} ${usage.unit || '-'}, ${usage.runtime} s`,
            );

            for (const entry of entries.slice(0, 8)) {
                const run = entry.runEvent;
                console.log(
                    `      zone ${run?.zone?.id} ${dateValue(run?.reportedStartTime) ?? '(not run)'}` +
                        ` ${run?.reportedDuration ?? '-'}s ${localizedNumber(run?.reportedWaterUsage) ?? '-'}` +
                        ` "${run?.reportedStatus?.label ?? run?.scheduledStatus?.label ?? ''}"`,
                );
            }
        }
    }

    console.log('\ndone');
}

main().catch(error => {
    console.error(`\nFAILED: ${error.name}: ${error.message}`);
    process.exit(1);
});
